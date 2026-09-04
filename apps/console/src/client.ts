import { FetchHttpClient } from "@effect/platform";
import { RpcClient, RpcSerialization } from "@effect/rpc";
import type {
  Attempt,
  AttemptPage,
  AttemptPageRequest,
  CommandReceipt,
  EventPage,
  FactorySnapshot,
  LifecycleCommand,
  LifecycleCommandPage,
  LifecycleCommandKind,
  QueuePage,
  OperationsOverview,
  TranscriptPage,
  UsagePage,
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

export function listAttempts(page: AttemptPageRequest): Promise<AttemptPage> {
  return Effect.gen(function* () {
    const client = yield* RpcClient.make(FactoryRpcs);
    return yield* client.ReadAttempts({ page });
  }).pipe(Effect.scoped, Effect.provide(Protocol), Effect.runPromise);
}

export function loadAttempt(attemptId: string): Promise<Attempt | null> {
  return Effect.gen(function* () {
    const client = yield* RpcClient.make(FactoryRpcs);
    return yield* client.ReadAttempt({ attemptId });
  }).pipe(Effect.scoped, Effect.provide(Protocol), Effect.runPromise);
}

export function loadTranscript(
  attemptId: string,
  limit: number,
  cursor?: number,
  watermark?: string,
): Promise<TranscriptPage> {
  return Effect.gen(function* () {
    const client = yield* RpcClient.make(FactoryRpcs);
    return yield* client.ReadTranscript({
      attemptId,
      page: {
        limit,
        ...(cursor !== undefined ? { cursor } : {}),
        ...(watermark ? { watermark } : {}),
      },
    });
  }).pipe(Effect.scoped, Effect.provide(Protocol), Effect.runPromise);
}

export function loadEvents(
  attemptId: string,
  limit: number,
  cursor?: number,
  watermark?: string,
): Promise<EventPage> {
  return Effect.gen(function* () {
    const client = yield* RpcClient.make(FactoryRpcs);
    return yield* client.ReadEvents({
      attemptId,
      page: {
        limit,
        ...(cursor !== undefined ? { cursor } : {}),
        ...(watermark ? { watermark } : {}),
      },
    });
  }).pipe(Effect.scoped, Effect.provide(Protocol), Effect.runPromise);
}

export function loadUsage(attemptId: string): Promise<UsagePage> {
  return Effect.gen(function* () {
    const client = yield* RpcClient.make(FactoryRpcs);
    return yield* client.ReadUsage({ page: { limit: 1, attemptId } });
  }).pipe(Effect.scoped, Effect.provide(Protocol), Effect.runPromise);
}

export function controlAttempt(
  commandId: string,
  kind: LifecycleCommandKind,
  attemptId: string,
  expectedTargetVersion: number,
): Promise<LifecycleCommand> {
  return runCommandEffect(
    Effect.gen(function* () {
      const client = yield* RpcClient.make(FactoryRpcs);
      return yield* client.ControlAttempt({
        commandId,
        kind,
        attemptId,
        expectedTargetVersion,
      });
    }).pipe(Effect.scoped, Effect.provide(Protocol)),
  );
}

export function loadLifecycleCommands(
  targetAttemptId: string,
  commandId?: string,
): Promise<LifecycleCommandPage> {
  return Effect.gen(function* () {
    const client = yield* RpcClient.make(FactoryRpcs);
    return yield* client.ReadLifecycleCommands({
      page: {
        limit: commandId ? 1 : 100,
        targetAttemptId,
        ...(commandId ? { commandId } : {}),
      },
    });
  }).pipe(Effect.scoped, Effect.provide(Protocol), Effect.runPromise);
}
