import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Preload this module in the child to exercise real SDK clients and MCP routing
// while replacing only Linear's HTTP service. Unexpected network calls fail closed.
if (process.env.LINEAR_MCP_STDIO_FIXTURE === '1') {
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url || String(input);
    if (url === 'https://api.linear.app/oauth/token') {
      const params = new URLSearchParams(String(init.body));
      assert.equal(params.get('grant_type'), 'authorization_code');
      assert.equal(params.get('code'), 'fixture-code');
      assert.equal(params.has('access_type'), false);
      return Response.json({ access_token: 'fixture-oauth-token', refresh_token: 'fixture-refresh', expires_in: 3600 });
    }
    if (url === 'https://api.linear.app/graphql') {
      const authorization = new Headers(init.headers).get('authorization');
      assert.equal(authorization, process.env.LINEAR_API_KEY || 'Bearer fixture-oauth-token');
      const { query } = JSON.parse(String(init.body));
      if (/query GetUser\b/.test(query)) return Response.json({ data: { viewer: { id: 'user-1', name: 'Fixture user' } } });
      if (/query GetTeams\b/.test(query)) return Response.json({ data: { teams: { nodes: [{ id: 'team-1' }] } } });
      throw new Error('Unhandled fixture GraphQL operation');
    }
    throw new Error(`Unexpected fixture network request: ${url}`);
  };
} else {
  await run();
}

async function withServer(apiKey, callback) {
  const client = new Client({ name: 'oauth-stdio-regression', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', fileURLToPath(import.meta.url), fileURLToPath(new URL('../build/index.js', import.meta.url))],
    env: { PATH: process.env.PATH || '', LINEAR_MCP_STDIO_FIXTURE: '1', ...(apiKey ? { LINEAR_API_KEY: 'fixture-api-key' } : {}) },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', data => { stderr += data; });
  try {
    await client.connect(transport);
    await callback(client);
  } finally {
    await client.close();
  }
  assert.match(stderr, /Linear MCP server running on stdio/);
}

async function run() {
  const args = { clientId: 'fixture-client', clientSecret: 'fixture-secret', redirectUri: 'http://localhost:3000/callback' };
  const call = (client, name, args = {}) => client.callTool({ name, arguments: args });
  const start = async client => {
    const result = await call(client, 'linear_auth', args);
    const url = new URL(result.content[0].text.split('\n').at(-1));
    assert.equal(url.searchParams.get('scope'), 'read,write,issues:create');
    assert.equal(url.searchParams.get('actor'), 'app');
    assert.equal(url.searchParams.has('access_type'), false);
    const state = url.searchParams.get('state');
    assert.match(state, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    return state;
  };
  await withServer(false, async client => {
    await client.ping();
    const { tools } = await client.listTools();
    assert.ok(tools.length >= 22);
    assert.deepEqual(tools.find(tool => tool.name === 'linear_auth_callback').inputSchema.required, ['code', 'state']);
    await assert.rejects(call(client, 'linear_get_user'), /Not authenticated/);
    const firstState = await start(client);
    const secondState = await start(client);
    assert.notEqual(firstState, secondState);
    await assert.rejects(call(client, 'linear_auth_callback', { code: 'fixture-code' }), /state/);
    await assert.rejects(call(client, 'linear_auth_callback', { code: 'fixture-code', state: 'incorrect-state' }), /Invalid or expired OAuth state/);
    await assert.rejects(call(client, 'linear_auth_callback', { code: 'fixture-code', state: firstState }), /Invalid or expired OAuth state/);
    await call(client, 'linear_auth_callback', { code: 'fixture-code', state: secondState });
    await assert.rejects(call(client, 'linear_auth_callback', { code: 'fixture-code', state: secondState }), /Invalid or expired OAuth state/);
    const user = JSON.parse((await call(client, 'linear_get_user')).content[0].text);
    assert.equal(user.viewer.id, 'user-1');
    const teams = JSON.parse((await call(client, 'linear_get_teams')).content[0].text);
    assert.equal(teams.teams.nodes[0].id, 'team-1');
    await start(client);
    await assert.rejects(call(client, 'linear_get_user'), /Not authenticated/);
    console.log('PASS: OAuth state validation, callback replay rejection, and authenticated data tools over stdio');
  });
  await withServer(true, async client => {
    const user = JSON.parse((await call(client, 'linear_get_user')).content[0].text);
    assert.equal(user.viewer.id, 'user-1');
    console.log('PASS: API key authentication and data tools over stdio');
  });
}
