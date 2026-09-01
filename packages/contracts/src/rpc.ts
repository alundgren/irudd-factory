import { Rpc, RpcGroup } from "@effect/rpc";
import { Schema } from "effect";
import { CommandReceipt, FactorySnapshot } from "./domain.ts";

/** The HTTP path the service serves and both clients call. */
export const RPC_PATH = "/rpc";

export class FactoryRpcs extends RpcGroup.make(
  Rpc.make("RunNextEligibleIssue", {
    payload: { commandId: Schema.String },
    success: CommandReceipt,
    error: Schema.String,
  }),
  Rpc.make("GetFactorySnapshot", {
    success: FactorySnapshot,
    error: Schema.String,
  }),
) {}
