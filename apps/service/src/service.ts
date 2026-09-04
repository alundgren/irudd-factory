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
import {
  IPV4_LOOPBACK_HOST,
  LOCAL_ACCESS_MODE,
  TAILSCALE_ACCESS_MODE,
  type FactoryConfig,
} from "./config.ts";
import { accessMiddleware } from "./access.ts";

class LocalCliRouter extends HttpRouter.Tag(
  "@irudd-factory/service/LocalCliRouter",
)<LocalCliRouter>() {}

export type FactoryDependencies = Layer.Layer<
  StateStore | GitHub | Workspaces | Provider | Clock | IdGenerator,
  unknown
>;

export function productionDependencies(
  config: FactoryConfig,
  github?: GitHubService,
): FactoryDependencies {
  return Layer.mergeAll(
    layerStateStore(config.databasePath, {
      recover: true,
      ...(config.retention
        ? {
            sensitivePatterns: config.retention.sensitivePatterns,
            maxTextBytes: config.retention.maxTextBytes,
          }
        : {}),
    }),
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
      yield* application
        .recoverInterruptedAttempts()
        .pipe(Effect.provide(context));
      yield* application.startDispatcher().pipe(Effect.provide(context));
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
        ListQueue: ({ limit, cursor, watermark }) =>
          application
            .listQueue({
              limit,
              ...(cursor ? { cursor } : {}),
              ...(watermark ? { watermark } : {}),
            })
            .pipe(
              Effect.provide(context),
              Effect.mapError((error) => `${error.code}: ${error.message}`),
            ),
        SetDispatchPaused: ({ paused }) =>
          application.setDispatchPaused(paused).pipe(
            Effect.provide(context),
            Effect.mapError((error) => `${error.code}: ${error.message}`),
          ),
        SetCodexEnabled: ({ enabled }) =>
          application.setCodexEnabled(enabled).pipe(
            Effect.provide(context),
            Effect.mapError((error) => `${error.code}: ${error.message}`),
          ),
        ReadIssues: ({ page }) =>
          application.readIssues(page).pipe(
            Effect.provide(context),
            Effect.mapError((error) => `${error.code}: ${error.message}`),
          ),
        ReadAttempts: ({ page }) =>
          application.readAttempts(page).pipe(
            Effect.provide(context),
            Effect.mapError((error) => `${error.code}: ${error.message}`),
          ),
        ReadTranscript: ({ attemptId, page }) =>
          application.readTranscript(attemptId, page).pipe(
            Effect.provide(context),
            Effect.mapError((error) => `${error.code}: ${error.message}`),
          ),
        ReadEvents: ({ attemptId, page }) =>
          application.readEvents(attemptId, page).pipe(
            Effect.provide(context),
            Effect.mapError((error) => `${error.code}: ${error.message}`),
          ),
        ReadUsage: ({ page }) =>
          application.readUsage(page).pipe(
            Effect.provide(context),
            Effect.mapError((error) => `${error.code}: ${error.message}`),
          ),
        ReadTimeline: ({ page }) =>
          application.readTimeline(page).pipe(
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
  localCliServer: Server = createServer(),
) {
  const access = config.access ?? { mode: LOCAL_ACCESS_MODE };
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
  const HandlerLive = handlerLayer(dependencies, application);
  const RpcLive = RpcServer.layer(FactoryRpcs).pipe(Layer.provide(HandlerLive));
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
  const Main = HttpRouter.Default.serve(accessMiddleware(access, "main")).pipe(
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
  const servers = [nodeServer];
  let LocalCli: Layer.Layer<never, unknown, never> | null = null;
  if (access.mode === TAILSCALE_ACCESS_MODE) {
    const LocalCliRpcLive = RpcServer.layer(FactoryRpcs).pipe(
      Layer.provide(HandlerLive),
    );
    const LocalCliProtocolLive = RpcServer.layerProtocolHttp({
      path: RPC_PATH,
      routerTag: LocalCliRouter,
    }).pipe(Layer.provide(RpcSerialization.layerJson));
    LocalCli = LocalCliRouter.serve(accessMiddleware(access, "local-cli")).pipe(
      Layer.provide(LocalCliRpcLive),
      Layer.provide(LocalCliProtocolLive),
      Layer.provide(
        NodeHttpServer.layer(() => localCliServer, {
          host: IPV4_LOOPBACK_HOST,
          port: access.localCliPort,
        }),
      ),
    );
    servers.push(localCliServer);
  }
  let resolveListenerTermination!: () => void;
  const listenerTermination = new Promise<void>((resolveTermination) => {
    resolveListenerTermination = resolveTermination;
  });
  const runtimeObservers = servers.map((server) => {
    const onRuntimeError = () => resolveListenerTermination();
    const onRuntimeClose = () => resolveListenerTermination();
    return {
      install: () => {
        server.on("error", onRuntimeError);
        server.once("close", onRuntimeClose);
      },
      cleanup: () => {
        server.off("error", onRuntimeError);
        server.off("close", onRuntimeClose);
      },
    };
  });
  const startupObservers = servers.map((server, index) => {
    let cleanup = () => undefined;
    const listening = new Promise<void>((resolveListening, rejectListening) => {
      const onListening = () => {
        cleanup();
        runtimeObservers[index]!.install();
        resolveListening();
      };
      const onError = (error: Error) => {
        cleanup();
        rejectListening(error);
      };
      cleanup = () => {
        server.off("listening", onListening);
        server.off("error", onError);
      };
      server.once("listening", onListening);
      server.once("error", onError);
    });
    return { listening, cleanup };
  });
  const Service = LocalCli ? Layer.merge(Main, LocalCli) : Main;
  const fibers = [Effect.runFork(Layer.launch(Service))];
  const exits = fibers.map((fiber) => Effect.runPromise(Fiber.await(fiber)));
  try {
    await Promise.race([
      Promise.all(startupObservers.map(({ listening }) => listening)),
      Promise.race(exits).then((cause) => {
        throw new FactoryError({
          code: "service_start_failed",
          message: "Factory service stopped before every listener became ready",
          detail: String(cause),
        });
      }),
    ]);
    const earlyExit = await Promise.race([
      Promise.race(exits).then((cause) => ({ cause })),
      new Promise<null>((resolveReady) =>
        setImmediate(() => resolveReady(null)),
      ),
    ]);
    if (earlyExit) {
      throw new FactoryError({
        code: "service_start_failed",
        message: "Factory service stopped during listener initialization",
        detail: String(earlyExit.cause),
      });
    }
  } catch (error) {
    await Effect.runPromise(
      application.shutdown().pipe(
        Effect.zipRight(
          Effect.all(
            fibers.map((fiber) => Fiber.interrupt(fiber)),
            {
              discard: true,
            },
          ),
        ),
      ),
    );
    startupObservers.forEach(({ cleanup }) => cleanup());
    runtimeObservers.forEach(({ cleanup }) => cleanup());
    throw error instanceof FactoryError
      ? error
      : new FactoryError({
          code: "service_start_failed",
          message: "Factory service listener failed to start",
          detail: String(error),
        });
  }
  const addresses = servers.map(
    (server) => server.address() as AddressInfo | null,
  );
  if (addresses.some((address) => !address)) {
    await Effect.runPromise(
      application.shutdown().pipe(
        Effect.zipRight(
          Effect.all(
            fibers.map((fiber) => Fiber.interrupt(fiber)),
            {
              discard: true,
            },
          ),
        ),
      ),
    );
    startupObservers.forEach(({ cleanup }) => cleanup());
    runtimeObservers.forEach(({ cleanup }) => cleanup());
    throw new FactoryError({
      code: "service_start_failed",
      message: "A Factory service listener has no bound address",
    });
  }
  const address = addresses[0]!;
  const localCliAddress = addresses[1];
  let stopPromise: Promise<void> | null = null;
  const stop = () => {
    stopPromise ??= Effect.runPromise(
      application.shutdown().pipe(
        Effect.zipRight(
          Effect.all(
            fibers.map((fiber) => Fiber.interrupt(fiber)),
            {
              discard: true,
            },
          ),
        ),
      ),
    )
      .then(() => undefined)
      .finally(() => runtimeObservers.forEach(({ cleanup }) => cleanup()));
    return stopPromise;
  };
  return {
    url: `http://${config.bindHost.includes(":") ? `[${config.bindHost}]` : config.bindHost}:${address.port}`,
    ...(localCliAddress
      ? { localCliUrl: `http://${IPV4_LOOPBACK_HOST}:${localCliAddress.port}` }
      : {}),
    terminated: Promise.race([
      Promise.race(exits).then(() => undefined),
      listenerTermination,
    ]),
    stop,
  };
}
