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
