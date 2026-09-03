import { FetchHttpClient } from "@effect/platform";
import { RpcClient, RpcSerialization } from "@effect/rpc";
import type {
  CommandReceipt,
  DispatchState,
  FactorySnapshot,
  QueuePage,
} from "@irudd-factory/contracts";
import { FactoryRpcs } from "@irudd-factory/contracts";
import { Effect, Layer } from "effect";

function protocol(url: string) {
  return RpcClient.layerProtocolHttp({ url }).pipe(
    Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]),
  );
}

export function runNextEligibleIssue(
  url: string,
  commandId: string,
): Promise<CommandReceipt> {
  return Effect.gen(function* () {
    const client = yield* RpcClient.make(FactoryRpcs);
    return yield* client.RunNextEligibleIssue({ commandId });
  }).pipe(Effect.scoped, Effect.provide(protocol(url)), Effect.runPromise);
}

export function startIssue(
  url: string,
  commandId: string,
  repository: string,
  issueNumber: number,
): Promise<CommandReceipt> {
  return Effect.gen(function* () {
    const client = yield* RpcClient.make(FactoryRpcs);
    return yield* client.StartIssue({ commandId, repository, issueNumber });
  }).pipe(Effect.scoped, Effect.provide(protocol(url)), Effect.runPromise);
}

export function getFactorySnapshot(url: string): Promise<FactorySnapshot> {
  return Effect.gen(function* () {
    const client = yield* RpcClient.make(FactoryRpcs);
    return yield* client.GetFactorySnapshot();
  }).pipe(Effect.scoped, Effect.provide(protocol(url)), Effect.runPromise);
}

export function listQueue(
  url: string,
  input: {
    readonly limit: number;
    readonly cursor?: string;
    readonly watermark?: string;
  },
): Promise<QueuePage> {
  return Effect.gen(function* () {
    const client = yield* RpcClient.make(FactoryRpcs);
    return yield* client.ListQueue(input);
  }).pipe(Effect.scoped, Effect.provide(protocol(url)), Effect.runPromise);
}

export function setDispatchPaused(
  url: string,
  paused: boolean,
): Promise<DispatchState> {
  return Effect.gen(function* () {
    const client = yield* RpcClient.make(FactoryRpcs);
    return yield* client.SetDispatchPaused({ paused });
  }).pipe(Effect.scoped, Effect.provide(protocol(url)), Effect.runPromise);
}

export function setCodexEnabled(
  url: string,
  enabled: boolean,
): Promise<DispatchState> {
  return Effect.gen(function* () {
    const client = yield* RpcClient.make(FactoryRpcs);
    return yield* client.SetCodexEnabled({ enabled });
  }).pipe(Effect.scoped, Effect.provide(protocol(url)), Effect.runPromise);
}
