import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { LinearAuth } from '../auth';
import { LinearGraphQLClient } from '../graphql/client';
import { HandlerFactory } from '../core/handlers/handler.factory';
import { toolSchemas } from '../core/types/tool.types';

jest.unmock('@linear/sdk');

describe('Issue project assignment and parent relationships (upstream #19 and #17)', () => {
  let factory: HandlerFactory;
  let rawRequest: ReturnType<typeof jest.spyOn>;
  const issue = { id: 'issue-1', identifier: 'TEST-1', title: 'Child', url: 'https://linear.app/test/issue/TEST-1' };
  const schemas = toolSchemas as unknown as Record<string, any>;
  const call = (name: string, args: unknown) => {
    const { handler, method } = factory.getHandlerForTool(name);
    return (handler as any)[method](args);
  };

  beforeEach(() => {
    const auth = new LinearAuth(); auth.initialize({ type: 'api', apiKey: 'fixture-api-key' });
    rawRequest = jest.spyOn(auth.getClient().client, 'rawRequest')
      .mockRejectedValue(new Error('Unexpected fixture GraphQL request'));
    factory = new HandlerFactory(auth, new LinearGraphQLClient(auth.getClient()));
  });
  afterEach(() => { jest.restoreAllMocks(); });

  it('advertises a single-issue update tool with project and parent updates', () => {
    expect(Object.keys(schemas)).toContain('linear_update_issue');
    expect(schemas.linear_update_issue.inputSchema.properties.update.properties).toHaveProperty('projectId');
    expect(schemas.linear_update_issue.inputSchema.properties.update.properties).toHaveProperty('parentId');
  });

  it('advertises project and parent fields on the existing bulk update tool', () => {
    expect(schemas.linear_bulk_update_issues.inputSchema.properties.update.properties).toHaveProperty('projectId');
    expect(schemas.linear_bulk_update_issues.inputSchema.properties.update.properties).toHaveProperty('parentId');
  });

  it.each(['linear_create_issue', 'linear_create_issues', 'linear_create_project_with_issues'])('advertises parentId for %s', name => {
    const properties = schemas[name].inputSchema.properties;
    const issueProperties = properties.issues ? properties.issues.items.properties : properties;
    expect(issueProperties).toHaveProperty('parentId');
  });

  it.each(['project-2', null])('passes project reassignment %p unchanged to the single update mutation', async projectId => {
    rawRequest.mockResolvedValue({ data: { issueUpdate: { success: true, issue } } } as never);
    await call('linear_update_issue', { id: 'issue-1', update: { projectId } });
    expect(rawRequest).toHaveBeenCalledWith(expect.any(String), { id: 'issue-1', input: { projectId } });
  });

  it('passes parentId unchanged when creating a child issue', async () => {
    rawRequest.mockResolvedValue({ data: { issueCreate: { success: true, issue } } } as never);
    await call('linear_create_issue', { title: 'Child', description: 'Description', teamId: 'team-1', parentId: 'parent-1' });
    expect(rawRequest).toHaveBeenCalledWith(expect.any(String), {
      input: { title: 'Child', description: 'Description', teamId: 'team-1', parentId: 'parent-1' }
    });
  });

  it('passes parentId for bulk issue creation', async () => {
    rawRequest.mockResolvedValue({ data: { issueBatchCreate: { success: true, issues: [issue] } } } as never);
    const issues = [{ title: 'Child', description: 'Description', teamId: 'team-1', parentId: 'parent-1' }];
    await call('linear_create_issues', { issues });
    expect(rawRequest).toHaveBeenCalledWith(expect.any(String), { input: { issues } });
  });

  it('can remove a parent relationship with null', async () => {
    rawRequest.mockResolvedValue({ data: { issueUpdate: { success: true, issue } } } as never);
    await call('linear_update_issue', { id: 'issue-1', update: { parentId: null } });
    expect(rawRequest).toHaveBeenCalledWith(expect.any(String), { id: 'issue-1', input: { parentId: null } });
  });

  it('preserves single-issue updates through the existing bulk tool', async () => {
    rawRequest.mockResolvedValue({ data: { issueUpdate: { success: true, issue } } } as never);
    await call('linear_bulk_update_issues', { issueIds: ['issue-1'], update: { projectId: 'project-2' } });
    expect(rawRequest).toHaveBeenCalledTimes(1);
    expect(rawRequest).toHaveBeenCalledWith(expect.any(String), { id: 'issue-1', input: { projectId: 'project-2' } });
  });

  it('updates each issue using Linear single-id mutations, including project and parent', async () => {
    rawRequest.mockResolvedValue({ data: { issueUpdate: { success: true, issue } } } as never);
    await call('linear_bulk_update_issues', { issueIds: ['issue-1', 'issue-2'], update: { projectId: 'project-2', parentId: 'parent-1' } });
    expect(rawRequest).toHaveBeenCalledTimes(2);
    expect(rawRequest).toHaveBeenCalledWith(expect.stringContaining('issueUpdate(id: $id'), {
      id: 'issue-1', input: { projectId: 'project-2', parentId: 'parent-1' }
    });
    expect(rawRequest).toHaveBeenCalledWith(expect.stringContaining('issueUpdate(id: $id'), {
      id: 'issue-2', input: { projectId: 'project-2', parentId: 'parent-1' }
    });
  });

  it('rejects empty bulk updates before contacting Linear', async () => {
    await expect(call('linear_bulk_update_issues', { issueIds: [], update: { projectId: 'project-2' } })).rejects.toThrow(/non-empty array/);
    expect(rawRequest).not.toHaveBeenCalled();
  });

  it('reports a failed bulk item instead of claiming all issues were updated', async () => {
    rawRequest.mockResolvedValueOnce({ data: { issueUpdate: { success: true, issue } } } as never);
    rawRequest.mockResolvedValueOnce({ data: { issueUpdate: { success: false, issue: null } } } as never);
    await expect(call('linear_bulk_update_issues', { issueIds: ['issue-1', 'issue-2'], update: { projectId: 'project-2' } })).rejects.toThrow(/Failed to update issues/);
    expect(rawRequest).toHaveBeenCalledTimes(2);
  });
});
