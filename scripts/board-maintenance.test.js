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
