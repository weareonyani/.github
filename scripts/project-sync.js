const STATUS = {
  backlog: 'Backlog',
  todo: 'Todo',
  inProgress: 'In Progress',
  inReview: 'In Review',
  blocked: 'Blocked',
  done: 'Done',
};

const DAY_MS = 24 * 60 * 60 * 1000;

function targetStatus(eventName, payload) {
  const action = payload.action;

  if (eventName === 'issues') {
    if (['opened', 'transferred', 'reopened'].includes(action)) return STATUS.backlog;
    if (action === 'closed') return payload.issue.state_reason === 'completed' ? STATUS.done : null;
    return null;
  }

  if (eventName === 'pull_request') {
    const pr = payload.pull_request;
    if (action === 'closed') return pr.merged ? STATUS.done : null;
    if (['opened', 'reopened', 'ready_for_review', 'converted_to_draft', 'edited'].includes(action)) {
      return pr.draft ? STATUS.inProgress : STATUS.inReview;
    }
    return null;
  }

  if (eventName === 'pull_request_review') {
    if (action !== 'submitted') return null;
    return payload.review.state === 'changes_requested' ? STATUS.inProgress : null;
  }

  if (eventName === 'workflow_run') {
    const run = payload.workflow_run;
    if (action !== 'completed' || run.event !== 'pull_request') return null;
    if (['failure', 'timed_out', 'startup_failure'].includes(run.conclusion)) return STATUS.blocked;
    if (run.conclusion === 'success') return STATUS.inReview;
    return null;
  }

  return null;
}

function formAnswer(body, heading) {
  const match = (body || '').match(new RegExp(`^### ${heading}\\s*\\n+([^\\n]+)`, 'm'));
  const answer = match && match[1].trim();
  return answer && answer !== '_No response_' ? answer : null;
}

function parseIssueForm(body) {
  const area = formAnswer(body, 'Area');
  const severity = formAnswer(body, 'Severity');
  const priority = severity && severity.match(/^P[0-3]\b/);
  return { area: area ? area.split(',')[0].trim() : null, priority: priority ? priority[0] : null };
}

function fieldsForNewIssue(body, repoArea) {
  const { area, priority } = parseIssueForm(body);
  const urgent = priority === 'P0';
  return {
    area: area || repoArea || null,
    priority,
    status: urgent ? STATUS.todo : STATUS.backlog,
    currentSprint: urgent,
  };
}

function iterationEnd(iteration) {
  return new Date(Date.parse(iteration.startDate) + iteration.duration * DAY_MS).toISOString().slice(0, 10);
}

function currentIteration(iterations, today) {
  return iterations.find((it) => it.startDate <= today && today < iterationEnd(it)) || null;
}

async function loadProject(github, org, number) {
  const { organization } = await github.graphql(
    `query($org: String!, $number: Int!) {
      organization(login: $org) {
        projectV2(number: $number) {
          id
          fields(first: 50) {
            nodes {
              ... on ProjectV2SingleSelectField { id name options { id name } }
              ... on ProjectV2IterationField {
                id name
                configuration { iterations { id title startDate duration } }
              }
            }
          }
        }
      }
    }`,
    { org, number },
  );
  const project = organization.projectV2;
  const fields = Object.fromEntries(
    project.fields.nodes.filter((f) => f && f.name).map((f) => [f.name, f]),
  );
  return { id: project.id, fields };
}

async function pullRequestWithLinkedIssues(github, owner, repo, number) {
  const { repository } = await github.graphql(
    `query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          id
          isDraft
          state
          closingIssuesReferences(first: 20) { nodes { id } }
        }
      }
    }`,
    { owner, repo, number },
  );
  return repository.pullRequest;
}

async function addItem(github, projectId, contentId) {
  const { addProjectV2ItemById } = await github.graphql(
    `mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } }
    }`,
    { projectId, contentId },
  );
  return addProjectV2ItemById.item.id;
}

async function setFieldValue(github, project, itemId, fieldId, value) {
  await github.graphql(
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value
      }) { projectV2Item { id } }
    }`,
    { projectId: project.id, itemId, fieldId, value },
  );
}

async function setSingleSelect(github, project, itemId, fieldName, optionName, core) {
  const field = project.fields[fieldName];
  const option = field && field.options && field.options.find((o) => o.name === optionName);
  if (!option) {
    core.warning(`Project has no "${fieldName}" option named "${optionName}"`);
    return;
  }
  await setFieldValue(github, project, itemId, field.id, { singleSelectOptionId: option.id });
}

async function setIteration(github, project, itemId, fieldName, iterationId) {
  await setFieldValue(github, project, itemId, project.fields[fieldName].id, { iterationId });
}

function cardsForPullRequest(pr) {
  return [
    ...pr.closingIssuesReferences.nodes.map((n) => ({ contentId: n.id, setArea: false })),
    { contentId: pr.id, setArea: true },
  ];
}

function ciResultIsStale(eventName, prState) {
  return eventName === 'workflow_run' && prState !== 'OPEN';
}

async function boardCards(github, context) {
  const payload = context.payload;
  if (payload.issue && !payload.issue.pull_request) {
    return { cards: [{ contentId: payload.issue.node_id, setArea: false }], draft: false, state: null };
  }

  const prNumber = payload.pull_request?.number ?? payload.workflow_run?.pull_requests?.[0]?.number;
  if (!prNumber) return { cards: [], draft: false, state: null };

  const { owner, repo } = context.repo;
  const pr = await pullRequestWithLinkedIssues(github, owner, repo, prNumber);
  return { cards: cardsForPullRequest(pr), draft: pr.isDraft, state: pr.state };
}

const CLOSING_REF = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:([\w.-]+)\/([\w.-]+))?#(\d+)\b/gi;

function closingReferences(body, owner, repo) {
  const refs = new Map();
  for (const m of (body || '').matchAll(CLOSING_REF)) {
    const ref = { owner: m[1] || owner, repo: m[2] || repo, number: Number(m[3]) };
    refs.set(`${ref.owner}/${ref.repo}#${ref.number}`, ref);
  }
  return [...refs.values()];
}

function closesOnMerge(eventName, payload) {
  const pr = payload.pull_request;
  return (
    eventName === 'pull_request' &&
    payload.action === 'closed' &&
    Boolean(pr?.merged) &&
    pr.base.ref !== payload.repository?.default_branch
  );
}

async function closeLinkedIssues({ github, context, core }) {
  const pull = context.payload.pull_request;
  const { owner, repo } = context.repo;
  for (const ref of closingReferences(pull.body, owner, repo)) {
    const label = `${ref.owner}/${ref.repo}#${ref.number}`;
    try {
      const { data: issue } = await github.rest.issues.get({ owner: ref.owner, repo: ref.repo, issue_number: ref.number });
      if (issue.pull_request || issue.state === 'closed') continue;
      await github.rest.issues.createComment({
        owner: ref.owner, repo: ref.repo, issue_number: ref.number,
        body: `Closed by ${owner}/${repo}#${pull.number}, merged into \`${pull.base.ref}\`. GitHub only auto-closes issues for merges into the default branch.`,
      });
      await github.rest.issues.update({
        owner: ref.owner, repo: ref.repo, issue_number: ref.number, state: 'closed', state_reason: 'completed',
      });
      core.info(`${label} closed`);
    } catch (error) {
      core.warning(`Could not close ${label}: ${error.message}`);
    }
  }
}

async function syncNewIssue({ github, context, core, project, area }) {
  const fields = fieldsForNewIssue(context.payload.issue.body, area);
  const itemId = await addItem(github, project.id, context.payload.issue.node_id);
  await setSingleSelect(github, project, itemId, 'Status', fields.status, core);
  if (fields.area) await setSingleSelect(github, project, itemId, 'Area', fields.area, core);
  if (fields.priority) await setSingleSelect(github, project, itemId, 'Priority', fields.priority, core);
  if (fields.currentSprint) {
    const today = new Date().toISOString().slice(0, 10);
    const sprint = currentIteration(project.fields.Sprint.configuration.iterations, today);
    if (sprint) await setIteration(github, project, itemId, 'Sprint', sprint.id);
  }
  core.info(`${context.payload.issue.node_id} -> ${JSON.stringify(fields)}`);
}

async function run({ github, context, core, org, projectNumber, area }) {
  let status = targetStatus(context.eventName, context.payload);
  if (!status) {
    core.info(`No board change for ${context.eventName}.${context.payload.action}`);
    return;
  }

  const project = await loadProject(github, org, projectNumber);

  if (context.eventName === 'issues' && context.payload.action === 'opened') {
    await syncNewIssue({ github, context, core, project, area });
    return;
  }

  const { cards, draft, state } = await boardCards(github, context);
  if (ciResultIsStale(context.eventName, state)) {
    core.info(`Ignoring CI result for a ${state} pull request`);
    return;
  }
  if (status === STATUS.inReview && draft) status = STATUS.inProgress;

  for (const { contentId, setArea } of cards) {
    const itemId = await addItem(github, project.id, contentId);
    await setSingleSelect(github, project, itemId, 'Status', status, core);
    if (area && setArea) await setSingleSelect(github, project, itemId, 'Area', area, core);
    core.info(`${contentId} -> ${status}`);
  }

  if (closesOnMerge(context.eventName, context.payload)) {
    await closeLinkedIssues({ github, context, core });
  }
}

module.exports = {
  STATUS,
  targetStatus,
  ciResultIsStale,
  parseIssueForm,
  fieldsForNewIssue,
  cardsForPullRequest,
  iterationEnd,
  currentIteration,
  loadProject,
  setIteration,
  run,
  closingReferences,
  closesOnMerge,
  closeLinkedIssues,
};
