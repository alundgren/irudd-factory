import { Schema } from "effect";
import {
  Assignment,
  Attempt,
  AssignmentEvent,
  IssueRef,
  PullRequest,
  LifecycleCommand,
} from "./domain.ts";

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;
export const RETAINED_TEXT_TRUNCATION_MARKER = "\n[truncated]";

export const PageRequest = Schema.Struct({
  limit: Schema.optional(Schema.Number),
  cursor: Schema.optional(Schema.Number),
  watermark: Schema.optional(Schema.String),
});
export type PageRequest = typeof PageRequest.Type;

export const AttemptPageRequest = Schema.Struct({
  ...PageRequest.fields,
  includeArchived: Schema.optional(Schema.Boolean),
  issueNodeId: Schema.optional(Schema.String),
});
export type AttemptPageRequest = typeof AttemptPageRequest.Type;

export const UsagePageRequest = Schema.Struct({
  ...PageRequest.fields,
  attemptId: Schema.optional(Schema.String),
});
export type UsagePageRequest = typeof UsagePageRequest.Type;

export const LifecycleCommandPageRequest = Schema.Struct({
  ...PageRequest.fields,
  targetAttemptId: Schema.optional(Schema.String),
  commandId: Schema.optional(Schema.String),
});
export type LifecycleCommandPageRequest =
  typeof LifecycleCommandPageRequest.Type;

export interface Page<A> {
  readonly items: ReadonlyArray<A>;
  readonly nextCursor: number | null;
  readonly watermark: string;
}

export const TranscriptEntry = Schema.Struct({
  sequence: Schema.Number,
  attemptId: Schema.String,
  timestamp: Schema.String,
  role: Schema.Literal("agent"),
  text: Schema.String,
  truncated: Schema.Boolean,
});
export type TranscriptEntry = typeof TranscriptEntry.Type;

export const TokenUsageBreakdown = Schema.Struct({
  inputTokens: Schema.Number,
  cachedInputTokens: Schema.Number,
  outputTokens: Schema.Number,
  reasoningOutputTokens: Schema.Number,
  totalTokens: Schema.Number,
  cacheWriteInputTokens: Schema.optional(Schema.Number),
});
export type TokenUsageBreakdown = typeof TokenUsageBreakdown.Type;

export const AttemptUsage = Schema.Struct({
  attemptId: Schema.String,
  timestamp: Schema.String,
  total: TokenUsageBreakdown,
  last: TokenUsageBreakdown,
  modelContextWindow: Schema.NullOr(Schema.Number),
});
export type AttemptUsage = typeof AttemptUsage.Type;

export const RetainedProviderEventType = Schema.Literal(
  "item.started",
  "item.completed",
  "provider.error",
  "process.exited",
  "usage.updated",
);
export type RetainedProviderEventType = typeof RetainedProviderEventType.Type;

export const RetainedProviderEvent = Schema.Struct({
  sequence: Schema.Number,
  attemptId: Schema.String,
  timestamp: Schema.String,
  type: RetainedProviderEventType,
  detail: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});
export type RetainedProviderEvent = typeof RetainedProviderEvent.Type;

export const PullRequestEvidence = Schema.Union(
  Schema.TaggedStruct("verified", { pullRequest: PullRequest }),
  Schema.TaggedStruct("unknown", {}),
);
export type PullRequestEvidence = typeof PullRequestEvidence.Type;

export type RetainedProviderRecord =
  | {
      readonly kind: "transcript";
      readonly timestamp: string;
      readonly text: string;
    }
  | {
      readonly kind: "item";
      readonly timestamp: string;
      readonly phase: "started" | "completed";
      readonly id?: string;
      readonly itemType?: string;
      readonly status?: string;
    }
  | {
      readonly kind: "usage";
      readonly timestamp: string;
      readonly usage: Omit<AttemptUsage, "attemptId" | "timestamp">;
    }
  | {
      readonly kind: "error";
      readonly timestamp: string;
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly kind: "process_exit";
      readonly timestamp: string;
      readonly code: number | null;
      readonly signal: string | null;
      readonly cleanupTimedOut: boolean;
    };

function pageSchema<A, I>(item: Schema.Schema<A, I>) {
  return Schema.Struct({
    items: Schema.Array(item),
    nextCursor: Schema.NullOr(Schema.Number),
    watermark: Schema.String,
  });
}

export const IssuePage = pageSchema(IssueRef);
export type IssuePage = typeof IssuePage.Type;
export const AttemptPage = pageSchema(Attempt);
export type AttemptPage = typeof AttemptPage.Type;
export const TranscriptPage = pageSchema(TranscriptEntry);
export type TranscriptPage = typeof TranscriptPage.Type;
export const EventPage = pageSchema(
  Schema.Union(AssignmentEvent, RetainedProviderEvent),
);
export type EventPage = typeof EventPage.Type;
export const UsagePage = pageSchema(AttemptUsage);
export type UsagePage = typeof UsagePage.Type;
export const TimelineAttempt = Schema.Struct({
  ...Assignment.fields,
  startedAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
});
export type TimelineAttempt = typeof TimelineAttempt.Type;
export const TimelinePage = Schema.Struct({
  ...pageSchema(TimelineAttempt).fields,
  readAt: Schema.String,
});
export type TimelinePage = typeof TimelinePage.Type;
export const LifecycleCommandPage = pageSchema(LifecycleCommand);
export type LifecycleCommandPage = typeof LifecycleCommandPage.Type;

export const OperationsOverview = Schema.Struct({
  usage: Schema.Array(AttemptUsage),
  recentActivity: Schema.Array(Assignment),
  lifecycleCommands: Schema.Array(LifecycleCommand),
});
export type OperationsOverview = typeof OperationsOverview.Type;
