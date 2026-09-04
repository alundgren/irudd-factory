import { FetchHttpClient } from "@effect/platform";
import { RpcClient, RpcSerialization } from "@effect/rpc";
import type {
  CommandReceipt,
  FactorySnapshot,
  QueuePage,
  OperationsOverview,
} from "@irudd-factory/contracts";
import { FactoryRpcs, RPC_PATH } from "@irudd-factory/contracts";
import { Effect, Either, Layer } from "effect";
import { classifyRpcFailure } from "./errors.ts";

const Protocol = RpcClient.layerProtocolHttp({ url: RPC_PATH }).pipe(
  Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]),
);

export function runNext(commandId: string): Promise<CommandReceipt> {
  return Effect.gen(function* () {
    const client = yield* RpcClient.make(FactoryRpcs);
    return yield* client.RunNextEligibleIssue({ commandId });
  }).pipe(Effect.scoped, Effect.provide(Protocol), Effect.runPromise);
}

export function startIssue(
  commandId: string,
  repository: string,
  issueNumber: number,
): Promise<CommandReceipt> {
  return runCommandEffect(
    Effect.gen(function* () {
      const client = yield* RpcClient.make(FactoryRpcs);
      return yield* client.StartIssue({ commandId, repository, issueNumber });
    }).pipe(Effect.scoped, Effect.provide(Protocol)),
  );
}

export async function runCommandEffect<A>(
  effect: Effect.Effect<A, unknown>,
): Promise<A> {
  const outcome = await Effect.runPromise(Effect.either(effect));
  if (Either.isLeft(outcome)) throw classifyRpcFailure(outcome.left);
  return outcome.right;
}

export function setDispatchPaused(paused: boolean) {
  return runCommandEffect(
    Effect.gen(function* () {
      const client = yield* RpcClient.make(FactoryRpcs);
      return yield* client.SetDispatchPaused({ paused });
    }).pipe(Effect.scoped, Effect.provide(Protocol)),
  );
}

export function setCodexEnabled(enabled: boolean) {
  return runCommandEffect(
    Effect.gen(function* () {
      const client = yield* RpcClient.make(FactoryRpcs);
      return yield* client.SetCodexEnabled({ enabled });
    }).pipe(Effect.scoped, Effect.provide(Protocol)),
  );
}

export function listQueue(
  limit: number,
  cursor?: string,
  watermark?: string,
): Promise<QueuePage> {
  return Effect.gen(function* () {
    const client = yield* RpcClient.make(FactoryRpcs);
    return yield* client.ListQueue({
      limit,
      ...(cursor ? { cursor } : {}),
      ...(watermark ? { watermark } : {}),
    });
  }).pipe(Effect.scoped, Effect.provide(Protocol), Effect.runPromise);
}

export function loadOperationsOverview(): Promise<OperationsOverview> {
  return Effect.gen(function* () {
    const client = yield* RpcClient.make(FactoryRpcs);
    return yield* client.GetOperationsOverview();
  }).pipe(Effect.scoped, Effect.provide(Protocol), Effect.runPromise);
}

export function loadSnapshot(): Promise<FactorySnapshot> {
  return Effect.gen(function* () {
    const client = yield* RpcClient.make(FactoryRpcs);
    return yield* client.GetFactorySnapshot();
  }).pipe(Effect.scoped, Effect.provide(Protocol), Effect.runPromise);
}
