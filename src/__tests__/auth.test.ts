import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { LinearAuth } from '../auth';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

// Mock fetch
const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
global.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockClear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('LinearAuth', () => {
  let auth: LinearAuth;

  beforeEach(() => {
    auth = new LinearAuth();
  });

  describe('initialize', () => {
    it('should initialize with valid OAuth credentials', () => {
      expect(() => {
        auth.initialize({
          type: 'oauth',
          clientId: 'test-client-id',
          clientSecret: 'test-client-secret',
          redirectUri: 'http://localhost:3000/callback'
        });
      }).not.toThrow();
    });

    it('should initialize with valid Personal Access Token', () => {
      expect(() => {
        auth.initialize({
          type: 'api',
          apiKey: 'test-access-token'
        });
      }).not.toThrow();

      expect(auth.isAuthenticated()).toBe(true);
      expect(auth.needsTokenRefresh()).toBe(false);
    });

    it('should throw error when missing required OAuth parameters', () => {
      expect(() => {
        auth.initialize({
          type: 'oauth',
          clientId: 'test-client-id',
          // Missing clientSecret and redirectUri
        } as any);
      }).toThrow();
    });
  });

  describe('getAuthorizationUrl', () => {
    it('uses only supported Linear OAuth scopes, actor, and parameters (upstream #24)', () => {
      auth.initialize({ type: 'oauth', clientId: 'client', clientSecret: 'secret', redirectUri: 'http://localhost:3000/callback' });
      const params = new URL(auth.getAuthorizationUrl()).searchParams;
      expect(params.get('scope')?.split(',')).toEqual(['read', 'write', 'issues:create']);
      expect(params.get('actor')).toBe('app');
      expect(params.has('access_type')).toBe(false);
    });

    it('should return valid authorization URL with OAuth config', () => {
      auth.initialize({
        type: 'oauth',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        redirectUri: 'http://localhost:3000/callback'
      });

      const url = auth.getAuthorizationUrl();
      expect(url).toContain('https://linear.app/oauth/authorize');
      expect(url).toContain('client_id=test-client-id');
      expect(url).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcallback');
    });

    it('should throw error when called with API Key config', () => {
      auth.initialize({
        type: 'api',
        apiKey: 'test-access-token'
      });

      expect(() => {
        auth.getAuthorizationUrl();
      }).toThrow();
    });

    it('should throw error when called before initialization', () => {
      expect(() => {
        auth.getAuthorizationUrl();
      }).toThrow();
    });
  });

  describe('handleCallback', () => {
    it('should handle valid authorization code with OAuth config', async () => {
      auth.initialize({
        type: 'oauth',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        redirectUri: 'http://localhost:3000/callback'
      });

      // Mock the token exchange
      mockFetch.mockResolvedValueOnce(new Response(
        JSON.stringify({
          access_token: 'test-access-token',
          refresh_token: 'test-refresh-token',
          expires_in: 3600
        }),
        { status: 200 }
      ));

      const state = new URL(auth.getAuthorizationUrl()).searchParams.get('state')!;
      await expect(auth.handleCallback('valid-code', state)).resolves.not.toThrow();
      expect(auth.isAuthenticated()).toBe(true);
      expect(new URLSearchParams(mockFetch.mock.calls[0][1]?.body as string).has('access_type')).toBe(false);
    });

    it('should throw error when called with API Key config', async () => {
      auth.initialize({
        type: 'api',
        apiKey: 'test-access-token'
      });

      await expect(auth.handleCallback('valid-code', 'unused-state')).rejects.toThrow();
    });

    it('should throw error for invalid authorization code', async () => {
      auth.initialize({
        type: 'oauth',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        redirectUri: 'http://localhost:3000/callback'
      });

      // Mock failed token exchange
      mockFetch.mockResolvedValueOnce(new Response(
        JSON.stringify({
          error: 'invalid_grant'
        }),
        { status: 400 }
      ));

      const state = new URL(auth.getAuthorizationUrl()).searchParams.get('state')!;
      await expect(auth.handleCallback('invalid-code', state)).rejects.toThrow(/token exchange failed/);
    });
  });

  describe('OAuth state validation', () => {
    const oauthConfig = {
      type: 'oauth' as const,
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      redirectUri: 'http://localhost:3000/callback'
    };
    const tokenResponse = () => new Response(JSON.stringify({
      access_token: 'test-access-token', refresh_token: 'test-refresh-token', expires_in: 3600
    }), { status: 200 });
    const start = () => new URL(auth.getAuthorizationUrl()).searchParams.get('state')!;

    beforeEach(() => { auth.initialize(oauthConfig); });

    it('generates a fresh UUIDv4 for every authorization attempt', () => {
      const first = start();
      expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(start()).not.toBe(first);
    });

    it.each(['', 'incorrect-state'])('rejects state %p before contacting the token endpoint', async state => {
      const validState = start();
      await expect(auth.handleCallback('code', state)).rejects.toThrow(/Invalid or expired OAuth state/);
      expect(mockFetch).not.toHaveBeenCalled();
      // An unrelated callback must not invalidate the real authorization attempt.
      mockFetch.mockResolvedValueOnce(tokenResponse());
      await expect(auth.handleCallback('code', validState)).resolves.toBeUndefined();
    });

    it('rejects callbacks when no authorization attempt is pending', async () => {
      await expect(auth.handleCallback('code', 'state')).rejects.toThrow(/Invalid or expired OAuth state/);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects state from a different auth instance', async () => {
      const other = new LinearAuth(); other.initialize(oauthConfig);
      const state = new URL(other.getAuthorizationUrl()).searchParams.get('state')!;
      start();
      await expect(auth.handleCallback('code', state)).rejects.toThrow(/Invalid or expired OAuth state/);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('expires state after ten minutes', async () => {
      const now = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
      const state = start();
      clock.mockReturnValue(now + 10 * 60 * 1000);
      await expect(auth.handleCallback('code', state)).rejects.toThrow(/Invalid or expired OAuth state/);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('invalidates the previous URL when another authorization attempt starts', async () => {
      const first = start(); const second = start();
      await expect(auth.handleCallback('code', first)).rejects.toThrow(/Invalid or expired OAuth state/);
      expect(mockFetch).not.toHaveBeenCalled();
      mockFetch.mockResolvedValueOnce(tokenResponse());
      await auth.handleCallback('code', second);
    });

    it('accepts matching state once and rejects a replay before any second request', async () => {
      const state = start(); mockFetch.mockResolvedValueOnce(tokenResponse());
      await auth.handleCallback('code', state);
      await expect(auth.handleCallback('code', state)).rejects.toThrow(/Invalid or expired OAuth state/);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('consumes state before token exchange so concurrent callbacks cannot replay it', async () => {
      let resolveResponse!: (response: Response) => void;
      mockFetch.mockImplementationOnce(() => new Promise(resolve => { resolveResponse = resolve; }));
      const state = start(); const first = auth.handleCallback('code', state);
      await expect(auth.handleCallback('code', state)).rejects.toThrow(/Invalid or expired OAuth state/);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      resolveResponse(tokenResponse()); await first;
    });

    it('consumes state even if the token exchange fails', async () => {
      const state = start();
      mockFetch.mockRejectedValueOnce(new Error('Network unavailable'));
      await expect(auth.handleCallback('code', state)).rejects.toThrow(/Network unavailable/);
      await expect(auth.handleCallback('code', state)).rejects.toThrow(/Invalid or expired OAuth state/);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('invalidates pending state and clears the previous client on reinitialization', async () => {
      const state = start();
      auth.setTokenData({ apiKey: 'previous-token', refreshToken: 'previous-refresh', expiresAt: Date.now() + 3600000 });
      auth.initialize(oauthConfig);
      expect(auth.isAuthenticated()).toBe(false);
      await expect(auth.handleCallback('code', state)).rejects.toThrow(/Invalid or expired OAuth state/);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('does not let an in-flight callback replace a newly configured API key', async () => {
      let resolveResponse!: (response: Response) => void;
      mockFetch.mockImplementationOnce(() => new Promise(resolve => { resolveResponse = resolve; }));
      const state = start(); const callback = auth.handleCallback('code', state);
      auth.initialize({ type: 'api', apiKey: 'new-api-key' });
      const client = auth.getClient();
      resolveResponse(tokenResponse());
      await expect(callback).rejects.toThrow(/Authentication changed/);
      expect(auth.getClient()).toBe(client);
      expect(auth.needsTokenRefresh()).toBe(false);
    });

    it('does not authenticate an old callback after a newer URL is generated', async () => {
      let resolveResponse!: (response: Response) => void;
      mockFetch.mockImplementationOnce(() => new Promise(resolve => { resolveResponse = resolve; }));
      const state = start(); const callback = auth.handleCallback('code', state);
      const nextState = start(); resolveResponse(tokenResponse());
      await expect(callback).rejects.toThrow(/Authentication changed/);
      expect(auth.isAuthenticated()).toBe(false);
      mockFetch.mockResolvedValueOnce(tokenResponse());
      await auth.handleCallback('new-code', nextState);
      expect(auth.isAuthenticated()).toBe(true);
    });
  });

  describe('needsTokenRefresh', () => {
    it('should return true when OAuth token is expired', () => {
      auth.initialize({
        type: 'oauth',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        redirectUri: 'http://localhost:3000/callback'
      });

      // Set expired token
      auth.setTokenData({
        apiKey: 'test-access-token',
        refreshToken: 'test-refresh-token',
        expiresAt: Date.now() - 1000
      });

      expect(auth.needsTokenRefresh()).toBe(true);
    });

    it('should return false for valid OAuth token', () => {
      auth.initialize({
        type: 'oauth',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        redirectUri: 'http://localhost:3000/callback'
      });

      // Set valid token
      auth.setTokenData({
        apiKey: 'test-access-token',
        refreshToken: 'test-refresh-token',
        expiresAt: Date.now() + 3600000 // 1 hour from now
      });

      expect(auth.needsTokenRefresh()).toBe(false);
    });

    it('should return false for API Key', () => {
      auth.initialize({
        type: 'api',
        apiKey: 'test-access-token'
      });

      expect(auth.needsTokenRefresh()).toBe(false);
    });
  });

  describe('refreshAPIKey', () => {
    it('should successfully refresh OAuth token', async () => {
      auth.initialize({
        type: 'oauth',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        redirectUri: 'http://localhost:3000/callback'
      });

      // Set initial token data
      auth.setTokenData({
        apiKey: 'test-access-token',
        refreshToken: 'test-refresh-token',
        expiresAt: Date.now() - 1000 // Expired
      });

      // Mock successful token refresh
      mockFetch.mockResolvedValueOnce(new Response(
        JSON.stringify({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 3600
        }),
        { status: 200 }
      ));

      await expect(auth.refreshAPIKey()).resolves.not.toThrow();
    });

    it('should throw error when refresh fails', async () => {
      auth.initialize({
        type: 'oauth',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        redirectUri: 'http://localhost:3000/callback'
      });

      // Set initial token data
      auth.setTokenData({
        apiKey: 'test-access-token',
        refreshToken: 'test-refresh-token',
        expiresAt: Date.now() - 1000 // Expired
      });

      // Mock failed token refresh
      mockFetch.mockResolvedValueOnce(new Response(
        JSON.stringify({
          error: 'invalid_grant'
        }),
        { status: 400 }
      ));

      await expect(auth.refreshAPIKey()).rejects.toThrow();
    });

    it('should throw error when called with API Key config', async () => {
      auth.initialize({
        type: 'api',
        apiKey: 'test-access-token'
      });

      await expect(auth.refreshAPIKey()).rejects.toThrow();
    });
  });
});
