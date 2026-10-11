const STATUS = {
  backlog: 'Backlog',
  inProgress: 'In Progress',
  inReview: 'In Review',
  blocked: 'Blocked',
  done: 'Done',
};

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

async function loadProject(github, org, number) {
  const { organization } = await github.graphql(
    `query($org: String!, $number: Int!) {
      organization(login: $org) {
        projectV2(number: $number) {
          id
          fields(first: 50) {
            nodes {
              ... on ProjectV2SingleSelectField { id name options { id name } }
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

async function setSingleSelect(github, project, itemId, fieldName, optionName, core) {
  const field = project.fields[fieldName];
  const option = field && field.options.find((o) => o.name === optionName);
  if (!option) {
    core.warning(`Project has no "${fieldName}" option named "${optionName}"`);
    return;
  }
  await github.graphql(
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId, itemId: $itemId, fieldId: $fieldId,
        value: { singleSelectOptionId: $optionId }
      }) { projectV2Item { id } }
    }`,
    { projectId: project.id, itemId, fieldId: field.id, optionId: option.id },
  );
}

async function boardContent(github, context) {
  const payload = context.payload;
  if (payload.issue && !payload.issue.pull_request) return { ids: [payload.issue.node_id], draft: false };

  const prNumber = payload.pull_request?.number ?? payload.workflow_run?.pull_requests?.[0]?.number;
  if (!prNumber) return { ids: [], draft: false };

  const { owner, repo } = context.repo;
  const pr = await pullRequestWithLinkedIssues(github, owner, repo, prNumber);
  const issues = pr.closingIssuesReferences.nodes.map((n) => n.id);
  return { ids: issues.length ? issues : [pr.id], draft: pr.isDraft };
}

async function run({ github, context, core, org, projectNumber, area }) {
  let status = targetStatus(context.eventName, context.payload);
  if (!status) {
    core.info(`No board change for ${context.eventName}.${context.payload.action}`);
    return;
  }

  const project = await loadProject(github, org, projectNumber);
  const { ids, draft } = await boardContent(github, context);
  if (status === STATUS.inReview && draft) status = STATUS.inProgress;

  for (const contentId of ids) {
    const itemId = await addItem(github, project.id, contentId);
    await setSingleSelect(github, project, itemId, 'Status', status, core);
    if (area) await setSingleSelect(github, project, itemId, 'Area', area, core);
    core.info(`${contentId} -> ${status}`);
  }
}

module.exports = { STATUS, targetStatus, run };
