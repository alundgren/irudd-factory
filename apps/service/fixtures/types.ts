import type {
  Assignment,
  AssignmentEvent,
  AssignmentState,
  CommandResult,
  IssueRef,
  PullRequest,
  WorkflowRevision,
  WorkspacePaths,
} from "@irudd-factory/contracts";
import type {
  ClaimOutcome,
  ProviderRunResult,
} from "@irudd-factory/application";

export const FIXTURE_CHECKS = [
  "inspect-initial-snapshot",
  "run-next-command",
  "watch-lifecycle",
  "run-second-client",
] as const;
export type FixtureCheck = (typeof FIXTURE_CHECKS)[number];

export interface FixtureState {
  readonly now: string;
  readonly candidates: ReadonlyArray<IssueRef>;
  readonly assignment: Assignment | null;
  readonly events: ReadonlyArray<Omit<AssignmentEvent, "sequence">>;
  readonly queue?: {
    readonly candidates: ReadonlyArray<IssueRef>;
    readonly stale?: boolean;
  };
  readonly dispatch?: {
    readonly paused: boolean;
    readonly codexEnabled: boolean;
  };
}

export interface FixtureBehavior {
  readonly candidateWorkflow: WorkflowRevision;
  readonly claimOutcome: ClaimOutcome;
  readonly workspace: WorkspacePaths;
  readonly pullRequest: PullRequest;
  readonly provider: {
    readonly runningDelayMs: number;
    readonly completionDelayMs: number;
    readonly result: ProviderRunResult;
  };
}

export interface FixtureExpectations {
  readonly initial: {
    readonly candidateCount: number;
    readonly assignment: Assignment | null;
    readonly activeAssignmentCount: 0 | 1;
    readonly eventTypes: ReadonlyArray<string>;
  };
  readonly command?: {
    readonly result: CommandResult["_tag"];
    readonly issueLinkCount?: number;
    readonly assignmentState?: AssignmentState;
  };
  readonly lifecycle?: {
    readonly states: ReadonlyArray<AssignmentState>;
    readonly terminalState: "completed" | "failed";
    readonly terminalEventTypes: ReadonlyArray<string>;
    readonly pullRequest: PullRequest | null;
    readonly secondClientResult: "provider_busy";
    readonly afterTerminalResult: "no_candidate";
  };
  readonly reset: "deterministic";
  readonly checks: ReadonlyArray<FixtureCheck>;
}

export interface FixtureDefinition<Name extends string = string> {
  readonly name: Name;
  readonly summary: string;
  readonly tags: ReadonlyArray<string>;
  readonly purpose: string;
  readonly state: FixtureState;
  readonly behavior: FixtureBehavior;
  readonly expectations: FixtureExpectations;
}

export interface FixtureControls {
  readonly beforeRunning?: () => Promise<void>;
  readonly beforeCompletion?: () => Promise<void>;
  readonly onClaim?: () => void;
  readonly onWorkspace?: () => void;
  readonly onProviderRun?: () => void;
  readonly onProviderInterrupted?: () => void;
  readonly onRevalidate?: () => void;
  readonly revalidateFailure?: string;
  readonly cleanupUncertain?: boolean;
  readonly failAfterObservation?: {
    readonly model?: string;
    readonly effort?: string;
  };
}
