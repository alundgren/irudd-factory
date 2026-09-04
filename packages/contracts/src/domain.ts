import { Schema } from "effect";

export const ASSIGNMENT_STATES = [
  "reserved",
  "starting",
  "running",
  "completed",
  "failed",
  "interrupted",
  "stopped",
  "stop_uncertain",
  "ownership_uncertain",
] as const;

export const AssignmentState = Schema.Literal(...ASSIGNMENT_STATES);
export type AssignmentState = typeof AssignmentState.Type;

/**
 * The states that consume a Codex slot. SQLite uses this list for slot counts,
 * active-issue uniqueness, recovery, and the console projection.
 */
export const ACTIVE_ASSIGNMENT_STATES = [
  "reserved",
  "starting",
  "running",
  "stop_uncertain",
  "ownership_uncertain",
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
  processGroupId: Schema.optional(Schema.NullOr(Schema.Number)),
  processStartIdentity: Schema.optional(Schema.NullOr(Schema.String)),
  processStartPending: Schema.optional(Schema.Boolean),
  pullRequest: Schema.NullOr(PullRequest),
  error: Schema.NullOr(NormalizedError),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  lastEventSequence: Schema.Number,
  archivedAt: Schema.optional(Schema.NullOr(Schema.String)),
});
export type Assignment = typeof Assignment.Type;

/** A retained console session. Assignment remains the command-side name. */
export const Attempt = Assignment;
export type Attempt = Assignment;

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
  {
    issueLinks: Schema.Array(Schema.String),
  },
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

export const LIFECYCLE_COMMAND_KINDS = [
  "stop",
  "return",
  "restart",
  "archive",
  "restore",
] as const;
export const LifecycleCommandKind = Schema.Literal(...LIFECYCLE_COMMAND_KINDS);
export type LifecycleCommandKind = typeof LifecycleCommandKind.Type;

export const LifecycleCommandPhase = Schema.Literal(
  "accepted",
  "executing",
  "final",
);
export type LifecycleCommandPhase = typeof LifecycleCommandPhase.Type;

export const LifecycleAdmission = Schema.Union(
  Schema.TaggedStruct("accepted", {
    sourceState: AssignmentState,
    sourceVersion: Schema.Number,
  }),
  Schema.TaggedStruct("rejected", {
    code: Schema.String,
    message: Schema.String,
  }),
);
export type LifecycleAdmission = typeof LifecycleAdmission.Type;

export const LifecycleConsequence = Schema.Union(
  Schema.TaggedStruct("stopped", {
    processResult: Schema.Literal("exited", "terminated"),
  }),
  Schema.TaggedStruct("stop_uncertain", {}),
  Schema.TaggedStruct("returned", { claimedRemoved: Schema.Boolean }),
  Schema.TaggedStruct("restarted", { siblingAttemptId: Schema.String }),
  Schema.TaggedStruct("archived", {}),
  Schema.TaggedStruct("restored", {}),
  Schema.TaggedStruct("rejected", {
    code: Schema.String,
    message: Schema.String,
  }),
);
export type LifecycleConsequence = typeof LifecycleConsequence.Type;

export const LifecycleCommand = Schema.Struct({
  commandId: Schema.String,
  kind: LifecycleCommandKind,
  targetAttemptId: Schema.String,
  expectedTargetVersion: Schema.Number,
  phase: LifecycleCommandPhase,
  effect: Schema.String,
  admission: LifecycleAdmission,
  consequence: Schema.NullOr(LifecycleConsequence),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type LifecycleCommand = typeof LifecycleCommand.Type;

export const QueueReason = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
});
export type QueueReason = typeof QueueReason.Type;

export const QueueEntry = Schema.Struct({
  tenureId: Schema.String,
  issue: IssueRef,
  eligibleSince: Schema.String,
  lastObservedAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
  startable: Schema.Boolean,
  reason: Schema.NullOr(QueueReason),
});
export type QueueEntry = typeof QueueEntry.Type;

export const QueuePage = Schema.Struct({
  items: Schema.Array(QueueEntry),
  watermark: Schema.String,
  nextCursor: Schema.NullOr(Schema.String),
});
export type QueuePage = typeof QueuePage.Type;

export const DispatchState = Schema.Struct({
  paused: Schema.Boolean,
  codexEnabled: Schema.Boolean,
  updatedAt: Schema.String,
});
export type DispatchState = typeof DispatchState.Type;

export const FactorySnapshot = Schema.Struct({
  receipt: Schema.NullOr(CommandReceipt),
  assignment: Schema.NullOr(Assignment),
  assignments: Schema.optional(Schema.Array(Assignment)),
  events: Schema.Array(AssignmentEvent),
  dispatch: Schema.optional(DispatchState),
  queue: Schema.optional(QueuePage),
  configuration: Schema.optional(
    Schema.Struct({
      repositories: Schema.Array(
        Schema.Struct({
          repository: Schema.String,
          codex: Schema.Struct({
            model: Schema.String,
            reasoningEffort: Schema.String,
          }),
        }),
      ),
      codexSlots: Schema.Number,
      pollIntervalMs: Schema.Number,
      access: Schema.optional(Schema.String),
    }),
  ),
});
export type FactorySnapshot = typeof FactorySnapshot.Type;

export function isProviderBusy(state: AssignmentState): boolean {
  return ACTIVE_ASSIGNMENT_STATES.some((active) => active === state);
}
