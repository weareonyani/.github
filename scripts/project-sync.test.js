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
