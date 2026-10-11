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

test('PR and its linked issues all get cards; only the PR card takes the repo Area', () => {
  const pr = { id: 'PR1', closingIssuesReferences: { nodes: [{ id: 'I1' }, { id: 'I2' }] } };
  assert.deepEqual(cardsForPullRequest(pr), [
    { contentId: 'I1', setArea: false },
    { contentId: 'I2', setArea: false },
    { contentId: 'PR1', setArea: true },
  ]);
  assert.deepEqual(cardsForPullRequest({ id: 'PR2', closingIssuesReferences: { nodes: [] } }), [
    { contentId: 'PR2', setArea: true },
  ]);
});
