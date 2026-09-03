import type {
  Assignment,
  AssignmentEvent,
  AssignmentEventType,
  AttemptPage,
  AttemptUsage,
  CommandReceipt,
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
}

export interface AdmissionResult {
  readonly receipt: CommandReceipt;
  readonly created: boolean;
}

export interface AssignmentPatch {
  readonly state?: Assignment["state"];
  readonly workspace?: WorkspacePaths;
  readonly observedModel?: string;
  readonly observedEffort?: string;
  readonly codexVersion?: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly processGroupId?: number;
  readonly processStartIdentity?: string;
  readonly processStartPending?: boolean;
  readonly pullRequest?: PullRequest;
  readonly error?: NormalizedError;
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

export interface GitHubService {
  readonly discoverCandidates: (
    repository: string,
  ) => Effect.Effect<ReadonlyArray<Candidate>, FactoryError>;
  readonly revalidateIssue?: (
    candidate: Candidate,
  ) => Effect.Effect<Candidate, FactoryError>;
  readonly claimIssue: (
    issue: IssueRef,
  ) => Effect.Effect<ClaimOutcome, FactoryError>;
  readonly verifyPullRequest: (
    repository: string,
    branch: string,
    issueNumber: number,
  ) => Effect.Effect<PullRequest, FactoryError>;
  readonly lookupPullRequest?: (
    repository: string,
    branch: string,
    issueNumber: number,
  ) => Effect.Effect<PullRequest | null, FactoryError>;
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
