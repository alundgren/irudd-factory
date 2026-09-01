import { Schema } from "effect";

export const ASSIGNMENT_STATES = [
  "reserved",
  "starting",
  "running",
  "completed",
  "failed",
] as const;

export const AssignmentState = Schema.Literal(...ASSIGNMENT_STATES);
export type AssignmentState = typeof AssignmentState.Type;

/**
 * The states that hold a provider. The SQLite schema enforces one assignment
 * per provider across exactly this set, so the list drives both that SQL and
 * the projection the console reads.
 */
export const ACTIVE_ASSIGNMENT_STATES = [
  "reserved",
  "starting",
  "running",
] as const satisfies ReadonlyArray<AssignmentState>;

export const IssueRef = Schema.Struct({
  nodeId: Schema.String,
  repository: Schema.String,
  number: Schema.Number,
  url: Schema.String,
  title: Schema.String,
});
export type IssueRef = typeof IssueRef.Type;

export const WorkflowRevision = Schema.Struct({
  startingCommit: Schema.String,
  blobId: Schema.String,
  digest: Schema.String,
  body: Schema.String,
});
export type WorkflowRevision = typeof WorkflowRevision.Type;

export const WorkspacePaths = Schema.Struct({
  clonePath: Schema.String,
  worktreePath: Schema.String,
  worktreeGitDir: Schema.String,
  commonGitDir: Schema.String,
  branch: Schema.String,
});
export type WorkspacePaths = typeof WorkspacePaths.Type;

export const PullRequest = Schema.Struct({
  url: Schema.String,
  number: Schema.Number,
  draft: Schema.Boolean,
});
export type PullRequest = typeof PullRequest.Type;

export const NormalizedError = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  stage: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
});
export type NormalizedError = typeof NormalizedError.Type;

export const Assignment = Schema.Struct({
  id: Schema.String,
  provider: Schema.String,
  issue: IssueRef,
  state: AssignmentState,
  workflow: WorkflowRevision,
  workspace: Schema.NullOr(WorkspacePaths),
  requestedModel: Schema.String,
  requestedEffort: Schema.String,
  observedModel: Schema.NullOr(Schema.String),
  observedEffort: Schema.NullOr(Schema.String),
  codexVersion: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(Schema.String),
  turnId: Schema.NullOr(Schema.String),
  pullRequest: Schema.NullOr(PullRequest),
  error: Schema.NullOr(NormalizedError),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  lastEventSequence: Schema.Number,
});
export type Assignment = typeof Assignment.Type;

export const AssignmentEvent = Schema.Struct({
  sequence: Schema.Number,
  assignmentId: Schema.String,
  type: Schema.String,
  timestamp: Schema.String,
  detail: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});
export type AssignmentEvent = typeof AssignmentEvent.Type;

export const StartedResult = Schema.TaggedStruct("started", {
  assignment: Assignment,
});
export const NoCandidateResult = Schema.TaggedStruct("no_candidate", {});
export const SelectionAmbiguousResult = Schema.TaggedStruct(
  "selection_ambiguous",
  { issueLinks: Schema.Array(Schema.String) },
);
export const ProviderBusyResult = Schema.TaggedStruct("provider_busy", {
  assignment: Assignment,
});
export const CommandResult = Schema.Union(
  StartedResult,
  NoCandidateResult,
  SelectionAmbiguousResult,
  ProviderBusyResult,
);
export type CommandResult = typeof CommandResult.Type;

export const CommandReceipt = Schema.Struct({
  commandId: Schema.String,
  result: CommandResult,
  createdAt: Schema.String,
});
export type CommandReceipt = typeof CommandReceipt.Type;

export const FactorySnapshot = Schema.Struct({
  receipt: Schema.NullOr(CommandReceipt),
  assignment: Schema.NullOr(Assignment),
  events: Schema.Array(AssignmentEvent),
});
export type FactorySnapshot = typeof FactorySnapshot.Type;

export function isProviderBusy(state: AssignmentState): boolean {
  return ACTIVE_ASSIGNMENT_STATES.some((active) => active === state);
}
