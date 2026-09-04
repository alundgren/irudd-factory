import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { StateStore } from "@irudd-factory/application";
import { openStateStore } from "@irudd-factory/state-sqlite";
import { Effect } from "effect";
import type { FactoryConfig } from "../src/config.ts";
import { startFactoryService } from "../src/service.ts";
import { fixtureDependencies, seedFixture } from "./composition.ts";
import {
  FIXTURE_EFFORT,
  FIXTURE_MODEL,
  FIXTURE_REPOSITORY,
} from "./factories.ts";
import type { FixtureDefinition } from "./types.ts";

export async function launchFixture(
  fixture: FixtureDefinition,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const root = resolve(".factory", "fixtures", fixture.name);
  await mkdir(root, { recursive: true });
  const databasePath = resolve(root, "factory.db");
  for (const path of [
    databasePath,
    `${databasePath}-shm`,
    `${databasePath}-wal`,
  ]) {
    await rm(path, { force: true });
  }
  const repositories = Array.from(
    new Set([
      FIXTURE_REPOSITORY,
      ...fixture.state.candidates.map(({ repository }) => repository),
      ...(fixture.state.queue?.candidates.map(({ repository }) => repository) ??
        []),
    ]),
  );
  const config: FactoryConfig = {
    repositories: repositories.map((repository) => ({
      repository,
      codex: { model: FIXTURE_MODEL, reasoningEffort: FIXTURE_EFFORT },
    })),
    databasePath,
    workspaceRoot: resolve(root, "workspaces"),
    bindHost: "127.0.0.1",
    port: Number(environment.FACTORY_FIXTURE_PORT ?? "4317"),
    codex: { model: FIXTURE_MODEL, reasoningEffort: FIXTURE_EFFORT, slots: 1 },
    pollIntervalMs: 30_000,
    retention: {
      sensitivePatterns: ["fixture-secret-[0-9]+"],
      maxTextBytes: 512,
    },
    timeouts: {
      childStartupMs: 1_000,
      initializationMs: 1_000,
      modelSchemaMs: 1_000,
      turnMs: 5_000,
      shutdownMs: 1_000,
    },
  };

  const seedStore = openStateStore(databasePath, {
    ...config.retention,
    now: () => fixture.state.now,
  });
  await Effect.runPromise(
    seedFixture(fixture).pipe(
      Effect.provideService(StateStore, seedStore.service),
    ),
  );
  seedStore.close();

  const service = await startFactoryService(
    config,
    fixtureDependencies(config, fixture),
  );
  const consoleParameters = new URLSearchParams();
  if (fixture.consoleNetwork) {
    consoleParameters.set("fixture-network", fixture.consoleNetwork);
  }
  if (fixture.consoleClipboard) {
    consoleParameters.set("fixture-clipboard", fixture.consoleClipboard);
  }
  const consoleUrl = consoleParameters.size
    ? `${service.url}/?${consoleParameters.toString()}`
    : service.url;
  console.log(`Factory fixture ${fixture.name} listening at ${consoleUrl}`);
  console.log(
    `Second RPC client: node apps/cli/src/main.ts run-next --command-id second-${fixture.name} --url ${service.url}/rpc`,
  );

  await new Promise<void>((resolveStop) => {
    const stop = () => resolveStop();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await service.stop();
}
