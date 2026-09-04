import { Rpc, RpcGroup } from "@effect/rpc";
import { Schema } from "effect";
import {
  CommandReceipt,
  DispatchState,
  FactorySnapshot,
  QueuePage,
} from "./domain.ts";
import {
  AttemptPage,
  EventPage,
  IssuePage,
  PageRequest,
  TimelinePage,
  TranscriptPage,
  UsagePage,
} from "./history.ts";

/** The HTTP path the service serves and both clients call. */
export const RPC_PATH = "/rpc";

export class FactoryRpcs extends RpcGroup.make(
  Rpc.make("RunNextEligibleIssue", {
    payload: { commandId: Schema.String },
    success: CommandReceipt,
    error: Schema.String,
  }),
  Rpc.make("StartIssue", {
    payload: {
      commandId: Schema.String,
      repository: Schema.String,
      issueNumber: Schema.Number,
    },
    success: CommandReceipt,
    error: Schema.String,
  }),
  Rpc.make("GetFactorySnapshot", {
    success: FactorySnapshot,
    error: Schema.String,
  }),
  Rpc.make("ListQueue", {
    payload: {
      limit: Schema.Number,
      cursor: Schema.optional(Schema.String),
      watermark: Schema.optional(Schema.String),
    },
    success: QueuePage,
    error: Schema.String,
  }),
  Rpc.make("SetDispatchPaused", {
    payload: { paused: Schema.Boolean },
    success: DispatchState,
    error: Schema.String,
  }),
  Rpc.make("SetCodexEnabled", {
    payload: { enabled: Schema.Boolean },
    success: DispatchState,
    error: Schema.String,
  }),
  Rpc.make("ReadIssues", {
    payload: { page: PageRequest },
    success: IssuePage,
    error: Schema.String,
  }),
  Rpc.make("ReadAttempts", {
    payload: { page: PageRequest },
    success: AttemptPage,
    error: Schema.String,
  }),
  Rpc.make("ReadTranscript", {
    payload: { attemptId: Schema.String, page: PageRequest },
    success: TranscriptPage,
    error: Schema.String,
  }),
  Rpc.make("ReadEvents", {
    payload: { attemptId: Schema.String, page: PageRequest },
    success: EventPage,
    error: Schema.String,
  }),
  Rpc.make("ReadUsage", {
    payload: { page: PageRequest },
    success: UsagePage,
    error: Schema.String,
  }),
  Rpc.make("ReadTimeline", {
    payload: { page: PageRequest },
    success: TimelinePage,
    error: Schema.String,
  }),
) {}
