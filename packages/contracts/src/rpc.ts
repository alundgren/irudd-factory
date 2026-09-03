import { Rpc, RpcGroup } from "@effect/rpc";
import { Schema } from "effect";
import {
  CommandReceipt,
  DispatchState,
  FactorySnapshot,
  QueuePage,
} from "./domain.ts";

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
) {}
