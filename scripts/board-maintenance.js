const { STATUS, iterationEnd, currentIteration, loadProject, setIteration } = require('./project-sync');

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_DAYS = 3;
const PLANNED = [STATUS.todo, STATUS.inProgress, STATUS.inReview, STATUS.blocked];
const HEALTH_LABEL = 'board-health';
const MAX_ASSIGNEES = 10;

function needsRollover(item, currentSprintId, today) {
  if (!currentSprintId || !item.open || item.status === STATUS.done || !item.sprint) return false;
  return item.sprint.iterationId !== currentSprintId && iterationEnd(item.sprint) <= today;
}

function planningGaps(item) {
  if (!PLANNED.includes(item.status)) return [];
  return [
    !item.assignees && 'assignee',
    !item.size && 'size',
    !item.sprint && 'sprint',
  ].filter(Boolean);
}

function isStale(item, now) {
  if (![STATUS.inReview, STATUS.blocked].includes(item.status)) return false;
  return now - Date.parse(item.updatedAt) >= STALE_DAYS * DAY_MS;
}

function missingParentAssignees(item) {
  if (!item.isIssue) return [];
  const have = new Set(item.assigneeLogins);
  const missing = [...new Set(item.subIssueAssignees)].filter((login) => !have.has(login));
  return missing.slice(0, Math.max(0, MAX_ASSIGNEES - have.size));
}

function normalize(node) {
  const values = {};
  for (const v of node.fieldValues.nodes) {
    if (v && v.field) values[v.field.name] = v;
  }
  const c = node.content;
  return {
    id: node.id,
    title: c.title,
    url: c.url,
    isIssue: c.__typename === 'Issue',
    owner: c.repository?.owner.login,
    repo: c.repository?.name,
    number: c.number,
    assigneeLogins: c.assignees.nodes.map((a) => a.login),
    subIssueAssignees: (c.subIssues?.nodes ?? []).flatMap((sub) => sub.assignees.nodes.map((a) => a.login)),
    open: c.state === 'OPEN',
    updatedAt: c.updatedAt,
    assignees: c.assignees.totalCount,
    status: values.Status?.name ?? null,
    size: values.Size?.name ?? null,
    sprint: values.Sprint ? { iterationId: values.Sprint.iterationId, startDate: values.Sprint.startDate, duration: values.Sprint.duration } : null,
  };
}

async function loadItems(github, projectId) {
  const items = [];
  let after = null;
  do {
    const { node } = await github.graphql(
      `query($id: ID!, $after: String) {
        node(id: $id) {
          ... on ProjectV2 {
            items(first: 100, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                content {
                  __typename
                  ... on Issue {
                    title url state updatedAt number
                    repository { name owner { login } }
                    assignees(first: 10) { totalCount nodes { login } }
                    subIssues(first: 50) { nodes { assignees(first: 10) { nodes { login } } } }
                  }
                  ... on PullRequest { title url state updatedAt assignees(first: 10) { totalCount nodes { login } } }
                }
                fieldValues(first: 20) {
                  nodes {
                    ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
                    ... on ProjectV2ItemFieldIterationValue { iterationId startDate duration field { ... on ProjectV2FieldCommon { name } } }
                  }
                }
              }
            }
          }
        }
      }`,
      { id: projectId, after },
    );
    const page = node.items;
    items.push(...page.nodes.filter((n) => n.content && n.content.url).map(normalize));
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return items;
}

function healthReport({ rolled, gaps, stale, parents = [], projectUrl }) {
  const link = (i) => `[${i.title}](${i.url})`;
  const section = (title, rows) => `### ${title}\n\n${rows.length ? rows.join('\n') : '_None_'}`;
  return [
    `Daily check of the [Reckot board](${projectUrl}). Updated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
    section('Planned items missing info', gaps.map(({ item, missing }) => `- [ ] ${link(item)} (${item.status}): missing ${missing.join(', ')}`)),
    section(`Stale (In Review / Blocked, no activity for ${STALE_DAYS}+ days)`, stale.map((i) => `- [ ] ${link(i)} (${i.status}, last update ${i.updatedAt.slice(0, 10)})`)),
    section('Rolled over to the current sprint', rolled.map((i) => `- ${link(i)}`)),
    section('Parents assigned from sub-issues', parents.map(({ item, added }) => `- ${link(item)}: ${added.join(', ')}`)),
  ].join('\n\n');
}

async function publishHealth(issuesApi, owner, repo, body) {
  const { data } = await issuesApi.rest.issues.listForRepo({ owner, repo, labels: HEALTH_LABEL, state: 'open', per_page: 1 });
  if (data.length) {
    await issuesApi.rest.issues.update({ owner, repo, issue_number: data[0].number, body });
  } else {
    await issuesApi.rest.issues.create({ owner, repo, title: 'Reckot board health', labels: [HEALTH_LABEL], body });
  }
}

async function run({ github, issuesApi, context, core, org, projectNumber }) {
  const project = await loadProject(github, org, projectNumber);
  const today = new Date().toISOString().slice(0, 10);
  const sprint = currentIteration(project.fields.Sprint.configuration.iterations, today);
  const items = await loadItems(github, project.id);

  const rolled = [];
  for (const item of items) {
    if (needsRollover(item, sprint?.id, today)) {
      await setIteration(github, project, item.id, 'Sprint', sprint.id);
      item.sprint = { iterationId: sprint.id, startDate: sprint.startDate, duration: sprint.duration };
      rolled.push(item);
    }
  }

  const open = items.filter((i) => i.open);

  const parents = [];
  for (const item of open) {
    const wanted = missingParentAssignees(item);
    if (!wanted.length) continue;
    const { data } = await github.rest.issues.addAssignees({ owner: item.owner, repo: item.repo, issue_number: item.number, assignees: wanted });
    const now = new Set(data.assignees.map((a) => a.login));
    const added = wanted.filter((login) => now.has(login));
    if (!added.length) continue;
    item.assigneeLogins.push(...added);
    item.assignees += added.length;
    parents.push({ item, added });
  }

  const gaps = open.map((item) => ({ item, missing: planningGaps(item) })).filter((g) => g.missing.length);
  const stale = open.filter((i) => isStale(i, Date.now()));

  const projectUrl = `https://github.com/orgs/${org}/projects/${projectNumber}`;
  await publishHealth(issuesApi, context.repo.owner, context.repo.repo, healthReport({ rolled, gaps, stale, parents, projectUrl }));
  core.info(`rolled=${rolled.length} parents=${parents.length} gaps=${gaps.length} stale=${stale.length} sprint=${sprint?.title ?? 'none'}`);
}

module.exports = { needsRollover, planningGaps, isStale, missingParentAssignees, run };
