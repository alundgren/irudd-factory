import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { HttpRouter, HttpServerResponse } from "@effect/platform";
import { BunHttpServer } from "@effect/platform-bun";
import { RpcSerialization, RpcServer } from "@effect/rpc";
import {
  Clock,
  GitHub,
  IdGenerator,
  makeApplication,
  Provider,
  StateStore,
  Workspaces,
} from "@irudd-factory/application";
import { layerCodexProvider } from "@irudd-factory/codex";
import { FactoryRpcs } from "@irudd-factory/contracts";
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
): FactoryDependencies {
  return Layer.mergeAll(
    layerStateStore(config.databasePath),
    layerGitHub(),
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
  config: FactoryConfig,
  dependencies: FactoryDependencies,
) {
  const application = makeApplication({
    repository: config.repository,
    provider: "codex",
    model: config.codex.model,
    reasoningEffort: config.codex.reasoningEffort,
  });
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
  dependencies: FactoryDependencies = productionDependencies(config),
  consoleDistPath = resolve("apps/console/dist"),
) {
  await Promise.all([
    mkdir(dirname(config.databasePath), { recursive: true }),
    mkdir(config.workspaceRoot, { recursive: true }),
  ]);
  const RpcLive = RpcServer.layer(FactoryRpcs).pipe(
    Layer.provide(handlerLayer(config, dependencies)),
  );
  const ProtocolLive = RpcServer.layerProtocolHttp({ path: "/rpc" }).pipe(
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
      BunHttpServer.layer({
        hostname: config.bindHost,
        port: config.port,
      }),
    ),
  );
  const fiber = Effect.runFork(Layer.launch(Main));
  return {
    url: `http://${config.bindHost.includes(":") ? `[${config.bindHost}]` : config.bindHost}:${config.port}`,
    stop: () => Effect.runPromise(Fiber.interrupt(fiber)).then(() => undefined),
  };
}
