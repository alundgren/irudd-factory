import type { Assignment, WorkspacePaths } from "@irudd-factory/contracts";
export function makeAssignment(workspace: WorkspacePaths): Assignment {
  const assignment: Assignment = {
    id: "assignment-1",
    provider: "codex",
    issue: {
      nodeId: "I_1",
      repository: "owner/repository",
      number: 1,
      url: "https://github.com/owner/repository/issues/1",
      title: "Issue",
    },
    state: "starting",
    workflow: {
      startingCommit: "a".repeat(40),
      blobId: "b".repeat(40),
      digest: "c".repeat(64),
      body: "Do the work.",
    },
    workspace,
    requestedModel: "gpt-5.6-luna",
    requestedEffort: "low",
    observedModel: null,
    observedEffort: null,
    codexVersion: null,
    threadId: null,
    turnId: null,
    pullRequest: null,
    error: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastEventSequence: 1,
  };
  return assignment;
}
