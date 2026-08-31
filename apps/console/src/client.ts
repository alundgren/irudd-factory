import { FetchHttpClient } from "@effect/platform";
import { RpcClient, RpcSerialization } from "@effect/rpc";
import type { CommandReceipt, FactorySnapshot } from "@irudd-factory/contracts";
import { FactoryRpcs } from "@irudd-factory/contracts";
import { Effect, Layer } from "effect";

const Protocol = RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
  Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]),
);

export function runNext(commandId: string): Promise<CommandReceipt> {
  return Effect.gen(function* () {
    const client = yield* RpcClient.make(FactoryRpcs);
    return yield* client.RunNextEligibleIssue({ commandId });
  }).pipe(Effect.scoped, Effect.provide(Protocol), Effect.runPromise);
}

export function loadSnapshot(): Promise<FactorySnapshot> {
  return Effect.gen(function* () {
    const client = yield* RpcClient.make(FactoryRpcs);
    return yield* client.GetFactorySnapshot();
  }).pipe(Effect.scoped, Effect.provide(Protocol), Effect.runPromise);
}
