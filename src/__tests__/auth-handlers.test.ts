import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { LinearGraphQLClient as SDKGraphQLClient } from '@linear/sdk';
import { LinearAuth } from '../auth';
import { HandlerFactory } from '../core/handlers/handler.factory';
import { AuthHandler } from '../features/auth/handlers/auth.handler';
import { UserHandler } from '../features/users/handlers/user.handler';
import { TeamHandler } from '../features/teams/handlers/team.handler';
import { toolSchemas } from '../core/types/tool.types';

// Exercise real SDK client construction; mock only the HTTP boundary.
jest.unmock('@linear/sdk');

describe('OAuth authentication across existing tool handlers', () => {
  let auth: LinearAuth;
  let authHandler: AuthHandler;
  let userHandler: UserHandler;
  let teamHandler: TeamHandler;
  const originalFetch = global.fetch;
  const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
  const config = { type: 'oauth' as const, clientId: 'client', clientSecret: 'secret', redirectUri: 'http://localhost:3000/callback' };
  const tokenResponse = () => new Response(JSON.stringify({
    access_token: 'new-access-token', refresh_token: 'new-refresh-token', expires_in: 3600
  }), { status: 200 });

  beforeEach(() => {
    global.fetch = mockFetch; mockFetch.mockReset();
    auth = new LinearAuth();
    // Construct data handlers before authentication, as the real server does.
    const factory = new HandlerFactory(auth);
    authHandler = factory.getHandlerForTool('linear_auth').handler as AuthHandler;
    userHandler = factory.getHandlerForTool('linear_get_user').handler as UserHandler;
    teamHandler = factory.getHandlerForTool('linear_get_teams').handler as TeamHandler;
  });

  afterEach(() => { jest.restoreAllMocks(); global.fetch = originalFetch; });

  it('advertises and enforces the state argument on the callback tool', async () => {
    expect(toolSchemas.linear_auth_callback.inputSchema.required).toEqual(['code', 'state']);
    await expect(authHandler.handleAuthCallback({ code: 'code' })).rejects.toThrow(/Missing required parameters: state/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('enables existing data handlers after a valid callback and uses Bearer authentication', async () => {
    const response = await authHandler.handleAuth(config);
    const state = new URL(response.content[0].text.split('\n').pop()!).searchParams.get('state')!;
    mockFetch.mockResolvedValueOnce(tokenResponse());
    await authHandler.handleAuthCallback({ code: 'code', state });

    expect(new Headers(auth.getClient().options.headers).get('authorization')).toBe('Bearer new-access-token');
    const rawRequest = jest.spyOn(SDKGraphQLClient.prototype, 'rawRequest')
      .mockResolvedValue({ data: { viewer: { id: 'user-1' } } } as any);
    const user = await userHandler.handleGetUser({});
    expect(JSON.parse(user.content[0].text).viewer.id).toBe('user-1');
    expect(rawRequest.mock.contexts[0]).toBe(auth.getClient().client);
  });

  it('waits for one shared refresh before concurrent data tools use the new client', async () => {
    auth.initialize(config);
    auth.setTokenData({ apiKey: 'expired-token', refreshToken: 'refresh-token', expiresAt: Date.now() - 1 });
    const oldClient = auth.getClient();
    let resolveResponse!: (response: Response) => void;
    mockFetch.mockImplementationOnce(() => new Promise(resolve => { resolveResponse = resolve; }));
    const rawRequest = jest.spyOn(SDKGraphQLClient.prototype, 'rawRequest')
      .mockResolvedValue({ data: { viewer: { id: 'user-1' }, teams: { nodes: [] } } } as any);

    const user = userHandler.handleGetUser({});
    const teams = teamHandler.handleGetTeams({});
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(rawRequest).not.toHaveBeenCalled();
    resolveResponse(tokenResponse());
    await Promise.all([user, teams]);

    expect(auth.getClient()).not.toBe(oldClient);
    expect(rawRequest).toHaveBeenCalledTimes(2);
    expect(rawRequest.mock.contexts).toEqual([auth.getClient().client, auth.getClient().client]);
    expect(new Headers(auth.getClient().options.headers).get('authorization')).toBe('Bearer new-access-token');
  });

  it('propagates refresh failures without sending a data request and allows a later retry', async () => {
    auth.initialize(config);
    auth.setTokenData({ apiKey: 'expired-token', refreshToken: 'refresh-token', expiresAt: Date.now() - 1 });
    mockFetch.mockRejectedValueOnce(new Error('Refresh unavailable'));
    const rawRequest = jest.spyOn(SDKGraphQLClient.prototype, 'rawRequest')
      .mockResolvedValue({ data: { viewer: { id: 'user-1' } } } as any);
    await expect(userHandler.handleGetUser({})).rejects.toThrow(/Refresh unavailable/);
    expect(rawRequest).not.toHaveBeenCalled();
    mockFetch.mockResolvedValueOnce(tokenResponse());
    await userHandler.handleGetUser({});
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(rawRequest).toHaveBeenCalledTimes(1);
  });

  it('does not let an in-flight refresh overwrite a replacement API key', async () => {
    auth.initialize(config);
    auth.setTokenData({ apiKey: 'expired-token', refreshToken: 'refresh-token', expiresAt: Date.now() - 1 });
    let resolveResponse!: (response: Response) => void;
    mockFetch.mockImplementationOnce(() => new Promise(resolve => { resolveResponse = resolve; }));
    const rawRequest = jest.spyOn(SDKGraphQLClient.prototype, 'rawRequest');
    const user = userHandler.handleGetUser({});
    auth.initialize({ type: 'api', apiKey: 'replacement-api-key' });
    const replacement = auth.getClient(); resolveResponse(tokenResponse());
    await expect(user).rejects.toThrow(/Authentication changed/);
    expect(auth.getClient()).toBe(replacement);
    expect(rawRequest).not.toHaveBeenCalled();
  });

  it('replaces cached data clients when credentials change and retains raw API key headers', async () => {
    auth.initialize({ type: 'api', apiKey: 'first-api-key' });
    const rawRequest = jest.spyOn(SDKGraphQLClient.prototype, 'rawRequest')
      .mockResolvedValue({ data: { viewer: { id: 'user-1' } } } as any);
    await userHandler.handleGetUser({});
    const firstClient = auth.getClient();
    auth.initialize({ type: 'api', apiKey: 'second-api-key' });
    await userHandler.handleGetUser({});
    expect(rawRequest.mock.contexts).toEqual([firstClient.client, auth.getClient().client]);
    expect(new Headers(auth.getClient().options.headers).get('authorization')).toBe('second-api-key');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
