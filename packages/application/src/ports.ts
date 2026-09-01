import type {
  Assignment,
  AssignmentEvent,
  AssignmentEventType,
  CommandReceipt,
  FactorySnapshot,
  IssueRef,
  NormalizedError,
  PullRequest,
  WorkflowRevision,
  WorkspacePaths,
} from "@irudd-factory/contracts";
import { Context, type Effect } from "effect";
import type { FactoryError } from "./errors.ts";

export interface Candidate {
  readonly issue: IssueRef;
  readonly workflow: WorkflowRevision;
}

export interface AdmissionInput {
  readonly commandId: string;
  readonly provider: string;
  readonly candidates: ReadonlyArray<Candidate>;
  readonly assignmentId: string;
  readonly requestedModel: string;
  readonly requestedEffort: string;
  readonly timestamp: string;
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
  readonly seedAssignment: (
    assignment: Assignment,
    events: ReadonlyArray<Omit<AssignmentEvent, "sequence">>,
  ) => Effect.Effect<void, FactoryError>;
}

export class StateStore extends Context.Tag(
  "@irudd-factory/application/StateStore",
)<StateStore, StateStoreService>() {}

export type ClaimOutcome = "confirmed" | "unclaimed" | "unknown";

export interface GitHubService {
  readonly discoverCandidates: (
    repository: string,
  ) => Effect.Effect<ReadonlyArray<Candidate>, FactoryError>;
  readonly claimIssue: (
    issue: IssueRef,
  ) => Effect.Effect<ClaimOutcome, FactoryError>;
  readonly verifyPullRequest: (
    repository: string,
    branch: string,
    issueNumber: number,
  ) => Effect.Effect<PullRequest, FactoryError>;
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
}

export interface TokenUsageBreakdown {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
  readonly cacheWriteInputTokens?: number;
}

export interface ProviderTokenUsage {
  readonly total: TokenUsageBreakdown;
  readonly last: TokenUsageBreakdown;
  readonly modelContextWindow: number | null;
}

export interface ProviderRunResult {
  readonly codexVersion: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly observedModel: string;
  readonly observedEffort: string;
  readonly finalResponse: string;
  readonly itemSummaries: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly tokenUsage: ProviderTokenUsage;
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
