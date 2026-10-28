const test = require('node:test');
const assert = require('node:assert/strict');
const { STATUS, targetStatus } = require('./project-sync');

const pr = (action, extra = {}) => ({ action, pull_request: { draft: false, merged: false, ...extra } });
const run = (conclusion, event = 'pull_request') => ({ action: 'completed', workflow_run: { conclusion, event } });

test('issues', () => {
  assert.equal(targetStatus('issues', { action: 'opened' }), STATUS.backlog);
  assert.equal(targetStatus('issues', { action: 'reopened' }), STATUS.backlog);
  assert.equal(targetStatus('issues', { action: 'closed', issue: { state_reason: 'completed' } }), STATUS.done);
  assert.equal(targetStatus('issues', { action: 'closed', issue: { state_reason: 'not_planned' } }), null);
  assert.equal(targetStatus('issues', { action: 'labeled' }), null);
});

test('pull requests', () => {
  assert.equal(targetStatus('pull_request', pr('opened', { draft: true })), STATUS.inProgress);
  assert.equal(targetStatus('pull_request', pr('opened')), STATUS.inReview);
  assert.equal(targetStatus('pull_request', pr('ready_for_review')), STATUS.inReview);
  assert.equal(targetStatus('pull_request', pr('converted_to_draft', { draft: true })), STATUS.inProgress);
  assert.equal(targetStatus('pull_request', pr('closed', { merged: true })), STATUS.done);
  assert.equal(targetStatus('pull_request', pr('closed')), null);
  assert.equal(targetStatus('pull_request', pr('synchronize')), null);
});

test('reviews', () => {
  const review = (state) => ({ action: 'submitted', review: { state } });
  assert.equal(targetStatus('pull_request_review', review('changes_requested')), STATUS.inProgress);
  assert.equal(targetStatus('pull_request_review', review('approved')), null);
});

test('CI runs', () => {
  assert.equal(targetStatus('workflow_run', run('failure')), STATUS.blocked);
  assert.equal(targetStatus('workflow_run', run('timed_out')), STATUS.blocked);
  assert.equal(targetStatus('workflow_run', run('success')), STATUS.inReview);
  assert.equal(targetStatus('workflow_run', run('cancelled')), null);
  assert.equal(targetStatus('workflow_run', run('failure', 'push')), null);
});

test('events for a merged or closed PR leave the card alone, except the merge itself', () => {
  const { pullRequestEventIsStale } = require('./project-sync');
  assert.equal(pullRequestEventIsStale('workflow_run', 'completed', 'MERGED'), true);
  assert.equal(pullRequestEventIsStale('workflow_run', 'completed', 'CLOSED'), true);
  assert.equal(pullRequestEventIsStale('workflow_run', 'completed', 'OPEN'), false);
  assert.equal(pullRequestEventIsStale('pull_request', 'edited', 'MERGED'), true);
  assert.equal(pullRequestEventIsStale('pull_request_review', 'submitted', 'CLOSED'), true);
  assert.equal(pullRequestEventIsStale('pull_request', 'closed', 'MERGED'), false);
  assert.equal(pullRequestEventIsStale('issues', 'closed', null), false);
});

const { parseIssueForm, fieldsForNewIssue, currentIteration } = require('./project-sync');

test('parses issue form answers', () => {
  const body = '### Area\n\nInfra / DevOps, Backend\n\n### Severity\n\nP1 - Major feature broken, no workaround\n\n### What happened?\n\nBoom';
  assert.deepEqual(parseIssueForm(body), { area: 'Infra / DevOps', priority: 'P1' });
  assert.deepEqual(parseIssueForm('### Area\n\n_No response_'), { area: null, priority: null });
  assert.deepEqual(parseIssueForm(null), { area: null, priority: null });
});

test('new issue fields: form area wins, P0 goes to Todo in current sprint', () => {
  const p0 = '### Area\n\nFrontend\n\n### Severity\n\nP0 - Production down / data loss';
  assert.deepEqual(fieldsForNewIssue(p0, 'Backend'), { area: 'Frontend', priority: 'P0', status: STATUS.todo, currentSprint: true });
  assert.deepEqual(fieldsForNewIssue('no form', 'Backend'), { area: 'Backend', priority: null, status: STATUS.backlog, currentSprint: false });
});

test('current iteration', () => {
  const its = [
    { id: 'a', startDate: '2026-10-12', duration: 14 },
    { id: 'b', startDate: '2026-10-26', duration: 14 },
  ];
  assert.equal(currentIteration(its, '2026-10-12').id, 'a');
  assert.equal(currentIteration(its, '2026-10-25').id, 'a');
  assert.equal(currentIteration(its, '2026-10-26').id, 'b');
  assert.equal(currentIteration(its, '2026-10-11'), null);
});

const { cardsForPullRequest } = require('./project-sync');

test('only the issues a PR closes get cards, never the PR itself', () => {
  const pr = { id: 'PR1', closingIssuesReferences: { nodes: [{ id: 'I1' }, { id: 'I2' }] } };
  assert.deepEqual(cardsForPullRequest(pr), ['I1', 'I2']);
  assert.deepEqual(cardsForPullRequest({ id: 'PR2', closingIssuesReferences: { nodes: [] } }), []);
});

const { closingReferences, closesOnMerge, closeLinkedIssues } = require('./project-sync');

test('closing references in a PR body', () => {
  const body = 'Closes #42\nFixes weareonyani/r_frontend#41 and resolves: #7.\nRefs #9, closing #10 later, fixed #3';
  assert.deepEqual(closingReferences(body, 'weareonyani', 'r_backend'), [
    { owner: 'weareonyani', repo: 'r_backend', number: 42 },
    { owner: 'weareonyani', repo: 'r_frontend', number: 41 },
    { owner: 'weareonyani', repo: 'r_backend', number: 7 },
    { owner: 'weareonyani', repo: 'r_backend', number: 3 },
  ]);
  assert.deepEqual(closingReferences('Closes #5 and closes #5', 'o', 'r'), [{ owner: 'o', repo: 'r', number: 5 }]);
  assert.deepEqual(closingReferences(null, 'o', 'r'), []);
});

test('only merges into a non-default branch close issues', () => {
  const event = (merged, base) => ({
    action: 'closed',
    pull_request: { merged, base: { ref: base } },
    repository: { default_branch: 'main' },
  });
  assert.equal(closesOnMerge('pull_request', event(true, 'staging')), true);
  assert.equal(closesOnMerge('pull_request', event(true, 'main')), false);
  assert.equal(closesOnMerge('pull_request', event(false, 'staging')), false);
  assert.equal(closesOnMerge('issues', event(true, 'staging')), false);
});

test('closeLinkedIssues closes open issues and skips PRs, closed issues and failures', async () => {
  const calls = { updates: [], comments: [] };
  const issues = {
    42: { state: 'open' },
    43: { state: 'closed' },
    44: { state: 'open', pull_request: {} },
    45: { state: 'open' },
  };
  const github = {
    rest: {
      issues: {
        get: async ({ issue_number }) => {
          if (issue_number === 99) throw new Error('Not Found');
          return { data: issues[issue_number] };
        },
        update: async (args) => calls.updates.push(args),
        createComment: async (args) => calls.comments.push(args),
      },
    },
    graphql: async () => ({ node: { closedByPullRequestsReferences: { totalCount: 0 } } }),
  };
  const warnings = [];
  const core = { info: () => {}, warning: (m) => warnings.push(m) };
  const context = {
    repo: { owner: 'o', repo: 'r' },
    payload: { pull_request: { number: 7, body: 'Closes #42, closes #43, fixes #44, resolves #99, fixes o/x#45', base: { ref: 'staging' } } },
  };

  await closeLinkedIssues({ github, context, core });

  assert.deepEqual(
    calls.updates.map((u) => `${u.repo}#${u.issue_number}:${u.state}:${u.state_reason}`),
    ['r#42:closed:completed', 'x#45:closed:completed'],
  );
  assert.equal(calls.comments.length, 2);
  assert.match(calls.comments[0].body, /o\/r#7/);
  assert.match(calls.comments[0].body, /staging/);
  assert.equal(warnings.length, 1);
});

const {
  statusForOpenPullRequest,
  syncMergedPullRequests,
  reconcileOpenPullRequests,
} = require('./project-sync');

const openPr = (overrides = {}) => ({
  number: 1,
  updatedAt: new Date().toISOString(),
  isDraft: false,
  reviewDecision: null,
  closingIssuesReferences: { nodes: [{ id: 'ISSUE_1' }] },
  ...overrides,
});

test('open pull request status', () => {
  assert.equal(statusForOpenPullRequest(openPr()), STATUS.inReview);
  assert.equal(statusForOpenPullRequest(openPr({ isDraft: true })), STATUS.inProgress);
  assert.equal(statusForOpenPullRequest(openPr({ reviewDecision: 'CHANGES_REQUESTED' })), STATUS.inProgress);
});

const RELEASE_BRANCH = 'staging';

function fakeBoard({ pullRequests = [], associated = [], statuses = {}, stillOpen = [] } = {}) {
  const moves = [];
  const closes = [];
  const github = {
    rest: {
      repos: { listPullRequestsAssociatedWithCommit: async () => ({ data: associated }) },
      issues: {
        get: async ({ issue_number }) => ({ data: { state: 'open', node_id: `ISSUE_${issue_number}` } }),
        update: async (args) => closes.push(`${args.repo}#${args.issue_number}`),
        createComment: async () => {},
      },
    },
    graphql: async (query, vars) => {
      if (query.includes('closedByPullRequestsReferences')) {
        const nodes = [{ headRefName: RELEASE_BRANCH }];
        if (stillOpen.includes(vars.issueId)) nodes.push({ headRefName: 'feat/next' });
        return { node: { closedByPullRequestsReferences: { nodes } } };
      }
      if (query.includes('pullRequests(states: OPEN')) return { repository: { pullRequests: { nodes: pullRequests } } };
      if (query.includes('pullRequest(number:')) {
        return { repository: { pullRequest: { id: 'PR', isDraft: false, state: 'MERGED', closingIssuesReferences: { nodes: [{ id: `ISSUE_${vars.number}` }] } } } };
      }
      if (query.includes('addProjectV2ItemById')) return { addProjectV2ItemById: { item: { id: `ITEM_${vars.contentId}` } } };
      if (query.includes('fieldValueByName(name: "Status")')) {
        const name = statuses[vars.itemId];
        return { node: { fieldValueByName: name ? { name } : null } };
      }
      if (query.includes('fieldValueByName')) return { node: { fieldValueByName: { __typename: 'ProjectV2ItemFieldIterationValue' } } };
      if (query.includes('updateProjectV2ItemFieldValue')) {
        moves.push(`${vars.itemId}:${vars.value.singleSelectOptionId}`);
        return {};
      }
      throw new Error(`unexpected query: ${query.slice(0, 40)}`);
    },
  };
  const project = {
    id: 'P',
    fields: {
      Status: { id: 'S', options: Object.values(STATUS).map((name) => ({ id: name, name })) },
      Sprint: { id: 'SP', configuration: { iterations: [] } },
    },
  };
  return { github, project, moves, closes, core: { info: () => {}, warning: () => {} } };
}

test('a push moves the cards of PRs merged into that branch to Done and closes issues off the default branch', async () => {
  const board = fakeBoard({
    associated: [
      { number: 5, merged_at: '2026-10-27T00:00:00Z', base: { ref: 'staging' }, body: 'Closes #50' },
      { number: 6, merged_at: null, base: { ref: 'staging' }, body: 'Closes #60' },
      { number: 7, merged_at: '2026-10-27T00:00:00Z', base: { ref: 'main' }, body: 'Closes #70' },
    ],
  });
  class ActionsContext {
    payload = { ref: 'refs/heads/staging', after: 'abc', repository: { default_branch: 'main' } };
    get repo() {
      return { owner: 'o', repo: 'r' };
    }
  }

  await syncMergedPullRequests({ ...board, context: new ActionsContext() });

  assert.deepEqual(board.moves, ['ITEM_ISSUE_5:Done']);
  assert.deepEqual(board.closes, ['r#50']);
});

test('a push leaves issues that other open PRs still close open and off Done', async () => {
  const board = fakeBoard({
    associated: [
      { number: 5, merged_at: '2026-10-27T00:00:00Z', base: { ref: 'staging' }, body: 'Closes #5' },
      { number: 8, merged_at: '2026-10-27T00:00:00Z', base: { ref: 'staging' }, body: 'Closes #8' },
    ],
    stillOpen: ['ISSUE_5'],
  });
  const context = {
    repo: { owner: 'o', repo: 'r' },
    payload: { ref: 'refs/heads/staging', after: 'abc', repository: { default_branch: 'main' } },
  };

  await syncMergedPullRequests({ ...board, context });

  assert.deepEqual(board.moves, ['ITEM_ISSUE_8:Done']);
  assert.deepEqual(board.closes, ['r#8']);
});

test('a push to the default branch moves cards without closing issues itself', async () => {
  const board = fakeBoard({
    associated: [{ number: 7, merged_at: '2026-10-27T00:00:00Z', base: { ref: 'main' }, body: 'Closes #70' }],
  });
  const context = {
    repo: { owner: 'o', repo: 'r' },
    payload: { ref: 'refs/heads/main', after: 'abc', repository: { default_branch: 'main' } },
  };

  await syncMergedPullRequests({ ...board, context });

  assert.deepEqual(board.moves, ['ITEM_ISSUE_7:Done']);
  assert.deepEqual(board.closes, []);
});

test('the scheduled pass only touches recently updated open PRs', async () => {
  const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const board = fakeBoard({
    pullRequests: [
      openPr({ number: 1, isDraft: true, closingIssuesReferences: { nodes: [{ id: 'ISSUE_A' }] } }),
      openPr({ number: 2, updatedAt: stale, closingIssuesReferences: { nodes: [{ id: 'ISSUE_B' }] } }),
      openPr({ number: 3, closingIssuesReferences: { nodes: [] } }),
    ],
  });

  await reconcileOpenPullRequests({ ...board, context: { repo: { owner: 'o', repo: 'r' }, payload: {} } });

  assert.deepEqual(board.moves, ['ITEM_ISSUE_A:In Progress']);
});

test('the scheduled pass leaves cards blocked by failing CI for the CI result to clear', async () => {
  const board = fakeBoard({
    pullRequests: [
      openPr({ number: 1, closingIssuesReferences: { nodes: [{ id: 'ISSUE_A' }] } }),
      openPr({ number: 2, closingIssuesReferences: { nodes: [{ id: 'ISSUE_B' }] } }),
      openPr({ number: 3, isDraft: true, closingIssuesReferences: { nodes: [{ id: 'ISSUE_C' }] } }),
    ],
    statuses: { ITEM_ISSUE_A: STATUS.blocked, ITEM_ISSUE_B: STATUS.inProgress, ITEM_ISSUE_C: STATUS.blocked },
  });

  await reconcileOpenPullRequests({ ...board, context: { repo: { owner: 'o', repo: 'r' }, payload: {} } });

  assert.deepEqual(board.moves, ['ITEM_ISSUE_B:In Review', 'ITEM_ISSUE_C:In Progress']);
});

const { cardsInFlight } = require('./project-sync');

test('open PRs never pull closed issues back, and release PRs move no cards', () => {
  const refs = { nodes: [{ id: 'OPEN', closed: false }, { id: 'SHIPPED', closed: true }] };
  assert.deepEqual(cardsInFlight({ headRefName: 'feat/x', closingIssuesReferences: refs }), ['OPEN']);
  assert.deepEqual(cardsInFlight({ headRefName: 'staging', closingIssuesReferences: refs }), []);
});

test('the scheduled pass skips closed issues and release PRs', async () => {
  const board = fakeBoard({
    pullRequests: [
      openPr({ number: 1, isDraft: true, closingIssuesReferences: { nodes: [{ id: 'ISSUE_A', closed: true }, { id: 'ISSUE_B', closed: false }] } }),
      openPr({ number: 2, isDraft: true, headRefName: 'staging', closingIssuesReferences: { nodes: [{ id: 'ISSUE_C', closed: false }] } }),
    ],
  });

  await reconcileOpenPullRequests({ ...board, context: { repo: { owner: 'o', repo: 'r' }, payload: {} } });

  assert.deepEqual(board.moves, ['ITEM_ISSUE_B:In Progress']);
});

test('adding a card that another run already added returns the existing card', async () => {
  const { addItem } = require('./project-sync');
  const github = {
    graphql: async (query) => {
      if (query.includes('addProjectV2ItemById')) {
        throw new Error('Request failed due to following response errors:\n - Content already exists in this project');
      }
      return { node: { projectItems: { nodes: [{ id: 'OTHER', project: { id: 'X' } }, { id: 'ITEM_1', project: { id: 'P' } }] } } };
    },
  };
  assert.equal(await addItem(github, 'P', 'ISSUE_1'), 'ITEM_1');
});

test('other errors while adding a card still fail the run', async () => {
  const { addItem } = require('./project-sync');
  const github = { graphql: async () => { throw new Error('Resource not accessible by integration'); } };
  await assert.rejects(addItem(github, 'P', 'ISSUE_1'), /not accessible/);
});
