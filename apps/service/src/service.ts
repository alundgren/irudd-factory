import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { HttpRouter, HttpServerResponse } from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { RpcSerialization, RpcServer } from "@effect/rpc";
import {
  Clock,
  CODEX_PROVIDER,
  FactoryError,
  GitHub,
  type GitHubService,
  IdGenerator,
  makeApplication,
  Provider,
  StateStore,
  Workspaces,
} from "@irudd-factory/application";
import { layerCodexProvider } from "@irudd-factory/codex";
import { FactoryRpcs, RPC_PATH } from "@irudd-factory/contracts";
import { layerGitHub } from "@irudd-factory/github";
import { layerStateStore } from "@irudd-factory/state-sqlite";
import { layerWorkspaces } from "@irudd-factory/workspaces";
import { Effect, Fiber, Layer } from "effect";
import type { FactoryConfig } from "./config.ts";

export type FactoryDependencies = Layer.Layer<
  StateStore | GitHub | Workspaces | Provider | Clock | IdGenerator,
  unknown
>;

export function productionDependencies(
  config: FactoryConfig,
  github?: GitHubService,
): FactoryDependencies {
  return Layer.mergeAll(
    layerStateStore(config.databasePath),
    github ? Layer.succeed(GitHub, github) : layerGitHub(),
    layerWorkspaces({ root: config.workspaceRoot }),
    layerCodexProvider({
      runtimeRoot: join(config.workspaceRoot, "provider"),
      model: config.codex.model,
      reasoningEffort: config.codex.reasoningEffort,
      timeouts: config.timeouts,
    }),
    Layer.succeed(Clock, { now: () => new Date().toISOString() }),
    Layer.succeed(IdGenerator, { assignmentId: () => crypto.randomUUID() }),
  );
}

function handlerLayer(
  dependencies: FactoryDependencies,
  application: ReturnType<typeof makeApplication>,
) {
  return FactoryRpcs.toLayer(
    Effect.gen(function* () {
      const context = yield* Effect.context<
        StateStore | GitHub | Workspaces | Provider | Clock | IdGenerator
      >();
      return {
        RunNextEligibleIssue: ({ commandId }) =>
          application.runNextEligibleIssue(commandId).pipe(
            Effect.provide(context),
            Effect.mapError((error) => `${error.code}: ${error.message}`),
          ),
        StartIssue: ({ commandId, repository, issueNumber }) =>
          application.startIssue(commandId, repository, issueNumber).pipe(
            Effect.provide(context),
            Effect.mapError((error) => `${error.code}: ${error.message}`),
          ),
        GetFactorySnapshot: () =>
          application.getSnapshot().pipe(
            Effect.provide(context),
            Effect.mapError((error) => `${error.code}: ${error.message}`),
          ),
      };
    }),
  ).pipe(Layer.provide(dependencies));
}

export async function startFactoryService(
  config: FactoryConfig,
  dependencies: FactoryDependencies,
  consoleDistPath = resolve("apps/console/dist"),
  nodeServer: Server = createServer(),
) {
  await Promise.all([
    mkdir(dirname(config.databasePath), { recursive: true }),
    mkdir(config.workspaceRoot, { recursive: true }),
  ]);
  const application = makeApplication({
    repositories: config.repositories.map((entry) => ({
      repository: entry.repository,
      model: entry.codex.model,
      reasoningEffort: entry.codex.reasoningEffort,
    })),
    provider: CODEX_PROVIDER,
    slots: config.codex.slots,
    pollIntervalMs: config.pollIntervalMs,
  });
  const RpcLive = RpcServer.layer(FactoryRpcs).pipe(
    Layer.provide(handlerLayer(dependencies, application)),
  );
  const ProtocolLive = RpcServer.layerProtocolHttp({ path: RPC_PATH }).pipe(
    Layer.provide(RpcSerialization.layerJson),
  );
  const StaticLive = existsSync(join(consoleDistPath, "index.html"))
    ? HttpRouter.Default.use((router) =>
        Effect.all([
          router.get(
            "/",
            HttpServerResponse.file(join(consoleDistPath, "index.html")),
          ),
          router.get(
            "/assets/:file",
            Effect.gen(function* () {
              const params = yield* HttpRouter.params;
              const file = params.file;
              if (!file || !/^[A-Za-z0-9._-]+$/.test(file)) {
                return HttpServerResponse.empty({ status: 404 });
              }
              return yield* HttpServerResponse.file(
                join(consoleDistPath, "assets", file),
              ).pipe(
                Effect.catchAll(() =>
                  Effect.succeed(HttpServerResponse.empty({ status: 404 })),
                ),
              );
            }),
          ),
        ]).pipe(Effect.asVoid),
      )
    : Layer.empty;
  const Main = HttpRouter.Default.serve().pipe(
    Layer.provide(RpcLive),
    Layer.provide(ProtocolLive),
    Layer.provide(StaticLive),
    Layer.provide(
      NodeHttpServer.layer(() => nodeServer, {
        host: config.bindHost,
        port: config.port,
      }),
    ),
  );
  let resolveListenerTermination!: () => void;
  const listenerTermination = new Promise<void>((resolveTermination) => {
    resolveListenerTermination = resolveTermination;
  });
  const onRuntimeError = () => resolveListenerTermination();
  const onRuntimeClose = () => resolveListenerTermination();
  const cleanupListenerObservers = () => {
    nodeServer.off("error", onRuntimeError);
    nodeServer.off("close", onRuntimeClose);
  };
  let cleanupStartupObservers = () => undefined;
  const listening = new Promise<void>((resolveListening, rejectListening) => {
    cleanupStartupObservers = () => {
      nodeServer.off("listening", onListening);
      nodeServer.off("error", onError);
    };
    const onListening = () => {
      cleanupStartupObservers();
      nodeServer.on("error", onRuntimeError);
      nodeServer.once("close", onRuntimeClose);
      resolveListening();
    };
    const onError = (error: Error) => {
      cleanupStartupObservers();
      rejectListening(error);
    };
    nodeServer.once("listening", onListening);
    nodeServer.once("error", onError);
  });
  const fiber = Effect.runFork(Layer.launch(Main));
  const exit = Effect.runPromise(Fiber.await(fiber));
  try {
    await Promise.race([
      listening,
      exit.then((cause) => {
        throw new FactoryError({
          code: "service_start_failed",
          message: "Factory service stopped before its listener became ready",
          detail: String(cause),
        });
      }),
    ]);
  } catch (error) {
    await Effect.runPromise(
      application.shutdown().pipe(Effect.zipRight(Fiber.interrupt(fiber))),
    );
    cleanupStartupObservers();
    cleanupListenerObservers();
    throw error instanceof FactoryError
      ? error
      : new FactoryError({
          code: "service_start_failed",
          message: "Factory service listener failed to start",
          detail: String(error),
        });
  }
  const address = nodeServer.address() as AddressInfo | null;
  if (!address) {
    await Effect.runPromise(
      application.shutdown().pipe(Effect.zipRight(Fiber.interrupt(fiber))),
    );
    cleanupStartupObservers();
    cleanupListenerObservers();
    throw new FactoryError({
      code: "service_start_failed",
      message: "Factory service listener has no bound address",
    });
  }
  let stopPromise: Promise<void> | null = null;
  const stop = () => {
    stopPromise ??= Effect.runPromise(
      application.shutdown().pipe(Effect.zipRight(Fiber.interrupt(fiber))),
    )
      .then(() => undefined)
      .finally(cleanupListenerObservers);
    return stopPromise;
  };
  return {
    url: `http://${config.bindHost.includes(":") ? `[${config.bindHost}]` : config.bindHost}:${address.port}`,
    terminated: Promise.race([exit.then(() => undefined), listenerTermination]),
    stop,
  };
}
