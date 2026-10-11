const test = require('node:test');
const assert = require('node:assert/strict');
const { needsRollover, planningGaps, isStale } = require('./board-maintenance');

const item = (over = {}) => ({
  status: 'Todo',
  size: 'M',
  assignees: 1,
  open: true,
  updatedAt: '2026-10-20T00:00:00Z',
  sprint: { iterationId: 'a', startDate: '2026-10-12', duration: 14 },
  ...over,
});

test('rollover: unfinished items from an ended sprint', () => {
  assert.equal(needsRollover(item(), 'b', '2026-10-26'), true);
  assert.equal(needsRollover(item({ status: 'Done' }), 'b', '2026-10-26'), false);
  assert.equal(needsRollover(item({ open: false }), 'b', '2026-10-26'), false);
  assert.equal(needsRollover(item(), 'a', '2026-10-20'), false);
  assert.equal(needsRollover(item({ sprint: null }), 'b', '2026-10-26'), false);
  assert.equal(needsRollover(item(), null, '2026-10-26'), false);
});

test('planning gaps only for Todo and later', () => {
  assert.deepEqual(planningGaps(item()), []);
  assert.deepEqual(planningGaps(item({ assignees: 0, size: null, sprint: null })), ['assignee', 'size', 'sprint']);
  assert.deepEqual(planningGaps(item({ status: 'Backlog', assignees: 0 })), []);
  assert.deepEqual(planningGaps(item({ status: 'Done', assignees: 0 })), []);
});

test('stale: In Review or Blocked untouched for 3+ days', () => {
  const now = new Date('2026-10-24T00:00:00Z');
  assert.equal(isStale(item({ status: 'In Review', updatedAt: '2026-10-20T00:00:00Z' }), now), true);
  assert.equal(isStale(item({ status: 'Blocked', updatedAt: '2026-10-22T00:00:00Z' }), now), false);
  assert.equal(isStale(item({ status: 'Todo', updatedAt: '2026-10-01T00:00:00Z' }), now), false);
});

const { missingParentAssignees } = require('./board-maintenance');

test('parent issues gain every sub-issue assignee they lack, capped at 10', () => {
  assert.deepEqual(missingParentAssignees({ isIssue: true, assigneeLogins: ['ann'], subIssueAssignees: ['bob', 'ann', 'cy', 'bob'] }), ['bob', 'cy']);
  assert.deepEqual(missingParentAssignees({ isIssue: true, assigneeLogins: [], subIssueAssignees: [] }), []);
  assert.deepEqual(missingParentAssignees({ isIssue: false, assigneeLogins: [], subIssueAssignees: ['bob'] }), []);
  const many = Array.from({ length: 12 }, (_, i) => `u${i}`);
  assert.equal(missingParentAssignees({ isIssue: true, assigneeLogins: ['ann', 'bob'], subIssueAssignees: many }).length, 8);
});

test('run assigns sub-issue assignees to the parent and stops flagging it as unassigned', async () => {
  const { run } = require('./board-maintenance');
  const added = [];
  let published = '';
  const project = {
    organization: { projectV2: { id: 'P', fields: { nodes: [{ id: 'S', name: 'Sprint', configuration: { iterations: [] } }] } } },
  };
  const items = {
    node: { items: { pageInfo: { hasNextPage: false }, nodes: [{
      id: 'I1',
      content: {
        __typename: 'Issue', title: 'Epic', url: 'u', state: 'OPEN', updatedAt: new Date().toISOString(), number: 39,
        repository: { name: 'r_backend', owner: { login: 'weareonyani' } },
        assignees: { totalCount: 0, nodes: [] },
        subIssues: { nodes: [{ assignees: { nodes: [{ login: 'yokwejuste' }] } }] },
      },
      fieldValues: { nodes: [{ name: 'Todo', field: { name: 'Status' } }] },
    }] } },
  };
  const github = {
    graphql: async (q) => (q.includes('organization') ? project : items),
    rest: { issues: { addAssignees: async (a) => { added.push(a); return { data: { assignees: [{ login: 'yokwejuste' }] } }; } } },
  };
  const issuesApi = { rest: { issues: {
    listForRepo: async () => ({ data: [] }),
    create: async ({ body }) => { published = body; },
  } } };
  const core = { info: () => {} };
  await run({ github, issuesApi, context: { repo: { owner: 'weareonyani', repo: '.github' } }, core, org: 'weareonyani', projectNumber: 1 });
  assert.deepEqual(added, [{ owner: 'weareonyani', repo: 'r_backend', issue_number: 39, assignees: ['yokwejuste'] }]);
  assert.match(published, /Parents assigned from sub-issues[\s\S]*Epic[\s\S]*yokwejuste/);
  assert.doesNotMatch(published, /missing assignee/);
});

test('run only reports assignees GitHub accepted (people without repo access are dropped)', async () => {
  const { run } = require('./board-maintenance');
  let published = '';
  const project = { organization: { projectV2: { id: 'P', fields: { nodes: [{ id: 'S', name: 'Sprint', configuration: { iterations: [] } }] } } } };
  const items = { node: { items: { pageInfo: { hasNextPage: false }, nodes: [{
    id: 'I1',
    content: {
      __typename: 'Issue', title: 'Epic', url: 'u', state: 'OPEN', updatedAt: new Date().toISOString(), number: 41,
      repository: { name: 'r_backend', owner: { login: 'weareonyani' } },
      assignees: { totalCount: 1, nodes: [{ login: 'chestlyace' }] },
      subIssues: { nodes: [{ assignees: { nodes: [{ login: 'outsider' }] } }] },
    },
    fieldValues: { nodes: [] },
  }] } } };
  const github = {
    graphql: async (q) => (q.includes('organization') ? project : items),
    rest: { issues: { addAssignees: async () => ({ data: { assignees: [{ login: 'chestlyace' }] } }) } },
  };
  const issuesApi = { rest: { issues: { listForRepo: async () => ({ data: [] }), create: async ({ body }) => { published = body; } } } };
  await run({ github, issuesApi, context: { repo: { owner: 'weareonyani', repo: '.github' } }, core: { info: () => {} }, org: 'weareonyani', projectNumber: 1 });
  assert.match(published, /Parents assigned from sub-issues\n\n_None_/);
});
