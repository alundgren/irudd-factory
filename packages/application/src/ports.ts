import type {
  Assignment,
  AssignmentEvent,
  AssignmentEventType,
  AttemptPage,
  AttemptUsage,
  CommandReceipt,
  DispatchState,
  EventPage,
  FactorySnapshot,
  IssuePage,
  IssueRef,
  NormalizedError,
  PageRequest,
  PullRequest,
  RetainedProviderRecord,
  TimelinePage,
  TranscriptPage,
  UsagePage,
  WorkflowRevision,
  WorkspacePaths,
  QueuePage,
  QueueReason,
  LifecycleCommand,
  LifecycleCommandKind,
  LifecycleConsequence,
  LifecycleCommandPage,
  OperationsOverview,
} from "@irudd-factory/contracts";
import { Context, type Effect } from "effect";
import type { FactoryError } from "./errors.ts";

export interface Candidate {
  readonly issue: IssueRef;
  readonly workflow: WorkflowRevision;
}

export interface AdmissionCandidate extends Candidate {
  readonly requestedModel: string;
  readonly requestedEffort: string;
}

export interface AdmissionInput {
  readonly commandId: string;
  readonly provider: string;
  readonly candidates: ReadonlyArray<AdmissionCandidate>;
  readonly assignmentId: string;
  readonly timestamp: string;
  readonly slots?: number;
  readonly allowRetry?: boolean;
  readonly queueTenureId?: string;
  readonly source?: "manual" | "automatic";
}

export interface AdmissionResult {
  readonly receipt: CommandReceipt;
  readonly created: boolean;
}

export interface QueueTenureCandidate extends Candidate {
  readonly tenureId: string;
  readonly eligibleSince: string;
}

export interface QueueObservationInput {
  readonly repository: string;
  readonly candidates: ReadonlyArray<{
    readonly tenureId?: string;
    readonly candidate: Candidate;
  }>;
  readonly timestamp: string;
}

export interface EligibilityObservation {
  readonly sequence: number;
  readonly assignmentId: string;
  readonly issueNodeId: string;
  readonly observedAt: string;
  readonly eligible: false;
  readonly reason: QueueReason;
}

export interface AssignmentPatch {
  readonly state?: Assignment["state"];
  readonly workspace?: WorkspacePaths;
  readonly observedModel?: string;
  readonly observedEffort?: string;
  readonly codexVersion?: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly processGroupId?: number | null;
  readonly processStartIdentity?: string | null;
  readonly processStartPending?: boolean;
  readonly pullRequest?: PullRequest;
  readonly error?: NormalizedError;
  readonly archivedAt?: string | null;
}

export interface LifecycleCommandInput {
  readonly commandId: string;
  readonly kind: LifecycleCommandKind;
  readonly targetAttemptId: string;
  readonly expectedTargetVersion: number;
  readonly repositoryConfigured: boolean;
  readonly timestamp: string;
}

export interface StateStoreService {
  readonly getReceipt: (
    commandId: string,
  ) => Effect.Effect<CommandReceipt | null, FactoryError>;
  readonly admit: (
    input: AdmissionInput,
  ) => Effect.Effect<AdmissionResult, FactoryError>;
  readonly appendEvent: (
    assignmentId: string,
    event: Omit<AssignmentEvent, "sequence" | "assignmentId">,
    patch?: AssignmentPatch,
  ) => Effect.Effect<Assignment, FactoryError>;
  readonly getAssignment: (
    assignmentId: string,
  ) => Effect.Effect<Assignment | null, FactoryError>;
  readonly beginLifecycleCommand: (
    input: LifecycleCommandInput,
  ) => Effect.Effect<
    { readonly command: LifecycleCommand; readonly created: boolean },
    FactoryError
  >;
  readonly markLifecycleCommandExecuting: (
    commandId: string,
    effect: string,
    timestamp: string,
  ) => Effect.Effect<LifecycleCommand, FactoryError>;
  readonly finishLifecycleCommand: (
    commandId: string,
    consequence: LifecycleConsequence,
    timestamp: string,
    patch?: AssignmentPatch,
  ) => Effect.Effect<LifecycleCommand, FactoryError>;
  readonly unfinishedLifecycleCommands: () => Effect.Effect<
    ReadonlyArray<LifecycleCommand>,
    FactoryError
  >;
  readonly reconcileAttemptProcess: (
    attemptId: string,
  ) => Effect.Effect<"exited" | "terminated" | "uncertain", FactoryError>;
  readonly getSnapshot: () => Effect.Effect<FactorySnapshot, FactoryError>;
  readonly reset: () => Effect.Effect<void, FactoryError>;
  readonly interruptUnfinished: (
    timestamp: string,
    reconcileProcess: (identity: {
      readonly processGroupId: number;
      readonly processStartIdentity: string;
    }) => "exited" | "terminated" | "uncertain",
  ) => Effect.Effect<void, FactoryError>;
  readonly seedAssignment: (
    assignment: Assignment,
    events: ReadonlyArray<Omit<AssignmentEvent, "sequence">>,
  ) => Effect.Effect<void, FactoryError>;
  readonly reconcileQueue: (
    input: QueueObservationInput,
  ) => Effect.Effect<void, FactoryError>;
  readonly endQueueTenuresOutsideRepositories: (
    repositories: ReadonlyArray<string>,
    timestamp: string,
  ) => Effect.Effect<void, FactoryError>;
  readonly getDispatchableQueue: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<QueueTenureCandidate>, FactoryError>;
  readonly getActiveQueueTenureId: (
    issueNodeId: string,
  ) => Effect.Effect<string | null, FactoryError>;
  readonly markQueueTenureIneligible: (
    tenureId: string,
    timestamp: string,
    reason: QueueReason,
  ) => Effect.Effect<void, FactoryError>;
  readonly endQueueTenure: (
    tenureId: string,
    timestamp: string,
    reason: QueueReason,
  ) => Effect.Effect<void, FactoryError>;
  readonly listQueue: (input: {
    readonly limit: number;
    readonly cursor?: string;
    readonly watermark?: string;
  }) => Effect.Effect<QueuePage, FactoryError>;
  readonly getDispatchState: () => Effect.Effect<DispatchState, FactoryError>;
  readonly setDispatchPaused: (
    paused: boolean,
    timestamp: string,
  ) => Effect.Effect<DispatchState, FactoryError>;
  readonly setCodexEnabled: (
    enabled: boolean,
    timestamp: string,
  ) => Effect.Effect<DispatchState, FactoryError>;
  readonly getLatestEligibilityObservation: (
    assignmentId: string,
  ) => Effect.Effect<EligibilityObservation | null, FactoryError>;
  readonly appendProviderRecords: (
    attemptId: string,
    records: ReadonlyArray<RetainedProviderRecord>,
  ) => Effect.Effect<void, FactoryError>;
  readonly readIssues: (
    request: PageRequest,
  ) => Effect.Effect<IssuePage, FactoryError>;
  readonly readAttempts: (
    request: PageRequest,
  ) => Effect.Effect<AttemptPage, FactoryError>;
  readonly readTranscript: (
    attemptId: string,
    request: PageRequest,
  ) => Effect.Effect<TranscriptPage, FactoryError>;
  readonly readEvents: (
    attemptId: string,
    request: PageRequest,
  ) => Effect.Effect<EventPage, FactoryError>;
  readonly readUsage: (
    request: PageRequest,
  ) => Effect.Effect<UsagePage, FactoryError>;
  readonly readTimeline: (
    request: PageRequest,
  ) => Effect.Effect<TimelinePage, FactoryError>;
  readonly getOperationsOverview: () => Effect.Effect<
    OperationsOverview,
    FactoryError
  >;
  readonly readLifecycleCommands: (
    request: PageRequest,
  ) => Effect.Effect<LifecycleCommandPage, FactoryError>;
  readonly pullRequestRecoveryCandidates: () => Effect.Effect<
    ReadonlyArray<Assignment>,
    FactoryError
  >;
  readonly unfinishedPullRequestLookups: () => Effect.Effect<
    ReadonlyArray<Assignment>,
    FactoryError
  >;
}

export class StateStore extends Context.Tag(
  "@irudd-factory/application/StateStore",
)<StateStore, StateStoreService>() {}

export type ClaimOutcome = "confirmed" | "unclaimed" | "unknown";

export type PullRequestLookupOutcome =
  | { readonly _tag: "absent" }
  | { readonly _tag: "present"; readonly pullRequest: PullRequest }
  | { readonly _tag: "unknown" };

export interface GitHubService {
  readonly discoverCandidates: (
    repository: string,
  ) => Effect.Effect<ReadonlyArray<Candidate>, FactoryError>;
  readonly revalidateIssue: (
    candidate: Candidate,
  ) => Effect.Effect<Candidate, FactoryError>;
  readonly claimIssue: (
    issue: IssueRef,
  ) => Effect.Effect<ClaimOutcome, FactoryError>;
  readonly revalidateClaimedIssue?: (
    issue: IssueRef,
  ) => Effect.Effect<Candidate, FactoryError>;
  readonly inspectClaim?: (
    issue: IssueRef,
  ) => Effect.Effect<ClaimOutcome, FactoryError>;
  readonly removeClaim?: (
    issue: IssueRef,
  ) => Effect.Effect<ClaimOutcome, FactoryError>;
  readonly inspectAttemptPullRequest?: (
    repository: string,
    branch: string,
  ) => Effect.Effect<PullRequestLookupOutcome, FactoryError>;
  readonly verifyPullRequest: (
    repository: string,
    branch: string,
    issueNumber: number,
  ) => Effect.Effect<PullRequest, FactoryError>;
  readonly lookupPullRequest?: (
    repository: string,
    branch: string,
    issueNumber: number,
  ) => Effect.Effect<PullRequestLookupOutcome, FactoryError>;
}

export class GitHub extends Context.Tag("@irudd-factory/application/GitHub")<
  GitHub,
  GitHubService
>() {}

export interface WorkspaceService {
  readonly create: (input: {
    readonly repository: string;
    readonly assignmentId: string;
    readonly startingCommit: string;
  }) => Effect.Effect<WorkspacePaths, FactoryError>;
}

export class Workspaces extends Context.Tag(
  "@irudd-factory/application/Workspaces",
)<Workspaces, WorkspaceService>() {}

export interface ProviderEvent {
  readonly type: AssignmentEventType;
  readonly timestamp: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly patch?: AssignmentPatch;
  readonly records?: ReadonlyArray<RetainedProviderRecord>;
}

export type TokenUsageBreakdown = AttemptUsage["total"];
export type ProviderTokenUsage = Omit<AttemptUsage, "attemptId" | "timestamp">;

export interface ProviderRunResult {
  readonly codexVersion: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly observedModel: string;
  readonly observedEffort: string;
  readonly finalResponse: string;
  readonly itemSummaries: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly tokenUsage: ProviderTokenUsage | null;
  readonly records?: ReadonlyArray<RetainedProviderRecord>;
  readonly approvalCount: number;
  readonly processExit: Readonly<Record<string, unknown>>;
}

export interface ProviderService {
  readonly run: (
    input: {
      readonly assignment: Assignment;
      readonly prompt: string;
      readonly workspace: WorkspacePaths;
    },
    emit: (event: ProviderEvent) => Effect.Effect<void, FactoryError>,
    retain?: (
      records: ReadonlyArray<RetainedProviderRecord>,
    ) => Effect.Effect<void, FactoryError>,
  ) => Effect.Effect<ProviderRunResult, FactoryError>;
}

export class Provider extends Context.Tag(
  "@irudd-factory/application/Provider",
)<Provider, ProviderService>() {}

export interface ClockService {
  readonly now: () => string;
}

export class Clock extends Context.Tag("@irudd-factory/application/Clock")<
  Clock,
  ClockService
>() {}

export interface IdGeneratorService {
  readonly assignmentId: () => string;
}

export class IdGenerator extends Context.Tag(
  "@irudd-factory/application/IdGenerator",
)<IdGenerator, IdGeneratorService>() {}
