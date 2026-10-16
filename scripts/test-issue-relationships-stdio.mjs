import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { buildSchema, graphql } from 'graphql';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

if (process.env.LINEAR_MCP_ISSUE_FIXTURE === '1') {
  // The fixture accepts Linear's single-id mutation signature and rejects the
  // previous unsupported ids argument. No HTTP requests leave this process.
  const schema = buildSchema(`
    type Query { unused: String }
    type Mutation {
      issueCreate(input: IssueCreateInput!): IssuePayload!
      issueUpdate(id: String!, input: IssueUpdateInput!): IssuePayload!
      issueBatchCreate(input: IssueBatchCreateInput!): IssueBatchPayload!
    }
    input IssueCreateInput { title: String!, description: String, teamId: String!, projectId: String, parentId: String, priority: Int, estimate: Int }
    input IssueUpdateInput { title: String, description: String, stateId: String, assigneeId: String, priority: Int, estimate: Int, projectId: String, parentId: String }
    input IssueBatchCreateInput { issues: [IssueCreateInput!]! }
    type IssuePayload { success: Boolean!, issue: Issue }
    type IssueBatchPayload { success: Boolean!, issues: [Issue!]!, lastSyncId: Int! }
    type Issue { id: String!, identifier: String!, title: String!, url: String!, team: Team, project: Project, state: State }
    type Team { id: String!, name: String! }
    type Project { id: String!, name: String! }
    type State { name: String! }
  `);
  const issues = new Map([
    ['issue-1', { id: 'issue-1', projectId: 'old-project', parentId: null }],
    ['issue-2', { id: 'issue-2', projectId: null, parentId: null }],
  ]);
  let created = 0;
  function payload(issue) {
    console.error('FIXTURE_STATE ' + JSON.stringify(issue));
    return {
      success: true,
      issue: { ...issue, identifier: 'FIX-1', title: issue.title || 'Fixture issue', url: 'https://linear.app/fixture',
        project: issue.projectId ? { id: issue.projectId, name: 'Fixture project' } : null,
        team: { id: 'team-1', name: 'Fixture team' }, state: { name: 'Todo' } },
    };
  }
  const rootValue = {
    issueCreate({ input }) {
      const issue = { id: `created-${++created}`, ...input };
      issues.set(issue.id, issue); return payload(issue);
    },
    issueUpdate({ id, input }) {
      assert.ok(issues.has(id), 'Unknown fixture issue');
      const issue = { ...issues.get(id), ...input };
      issues.set(id, issue); return payload(issue);
    },
    issueBatchCreate({ input }) {
      return { success: true, issues: input.issues.map(item => rootValue.issueCreate({ input: item }).issue), lastSyncId: 1 };
    },
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url || String(input);
    assert.equal(url, 'https://api.linear.app/graphql');
    assert.equal(new Headers(init.headers).get('authorization'), 'fixture-api-key');
    const { query, variables } = JSON.parse(String(init.body));
    const result = await graphql({ schema, source: query, rootValue, variableValues: variables });
    return Response.json(result, { status: result.errors ? 400 : 200 });
  };
} else {
  await run();
}

async function run() {
  const client = new Client({ name: 'issue-relationship-regression', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', fileURLToPath(import.meta.url), fileURLToPath(new URL('../build/index.js', import.meta.url))],
    env: { PATH: process.env.PATH || '', LINEAR_MCP_ISSUE_FIXTURE: '1', LINEAR_API_KEY: 'fixture-api-key' }, stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', data => { stderr += data; });
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError); return result;
  };
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const update = tools.find(tool => tool.name === 'linear_update_issue');
    assert.ok(update.inputSchema.properties.update.properties.projectId);
    assert.ok(update.inputSchema.properties.update.properties.parentId);
    for (const name of ['linear_create_issue', 'linear_create_issues', 'linear_create_project_with_issues']) {
      const properties = tools.find(tool => tool.name === name).inputSchema.properties;
      assert.ok((properties.issues?.items.properties || properties).parentId);
    }
    await call('linear_create_issue', { title: 'Single child', description: 'Fixture', teamId: 'team-1', parentId: 'parent-1' });
    await call('linear_create_issues', { issues: [{ title: 'Bulk child', description: 'Fixture', teamId: 'team-1', parentId: 'parent-1' }] });
    await call('linear_update_issue', { id: 'issue-1', update: { projectId: 'project-2' } });
    await call('linear_bulk_update_issues', { issueIds: ['issue-1', 'issue-2'], update: { projectId: 'project-3', parentId: 'parent-1' } });
    await call('linear_update_issue', { id: 'issue-1', update: { projectId: null, parentId: null } });
    await assert.rejects(call('linear_bulk_update_issues', { issueIds: [], update: { projectId: 'project-2' } }), /non-empty array|minItems|at least 1/i);
  } finally {
    await client.close();
  }
  const snapshots = stderr.split('\n').filter(line => line.startsWith('FIXTURE_STATE ')).map(line => JSON.parse(line.slice('FIXTURE_STATE '.length)));
  assert.equal(snapshots.length, 6);
  assert.equal(snapshots.find(issue => issue.id === 'created-1').parentId, 'parent-1');
  assert.equal(snapshots.find(issue => issue.id === 'created-2').parentId, 'parent-1');
  assert.equal(snapshots.find(issue => issue.id === 'issue-1').projectId, 'project-2');
  assert.equal(snapshots.find(issue => issue.id === 'issue-2').projectId, 'project-3');
  assert.equal(snapshots.find(issue => issue.id === 'issue-2').parentId, 'parent-1');
  assert.deepEqual(snapshots.at(-1), { id: 'issue-1', projectId: null, parentId: null });
  console.log('PASS: tool discovery, child issue creation, project reassignment, valid bulk mutations, and relationship removal over MCP stdio');
}
