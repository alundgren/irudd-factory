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
  const config: FactoryConfig = {
    repositories: [
      {
        repository: FIXTURE_REPOSITORY,
        codex: { model: FIXTURE_MODEL, reasoningEffort: FIXTURE_EFFORT },
      },
    ],
    databasePath,
    workspaceRoot: resolve(root, "workspaces"),
    bindHost: "127.0.0.1",
    port: Number(environment.FACTORY_FIXTURE_PORT ?? "4317"),
    codex: { model: FIXTURE_MODEL, reasoningEffort: FIXTURE_EFFORT, slots: 1 },
    pollIntervalMs: 30_000,
    timeouts: {
      childStartupMs: 1_000,
      initializationMs: 1_000,
      modelSchemaMs: 1_000,
      turnMs: 5_000,
      shutdownMs: 1_000,
    },
  };

  const seedStore = openStateStore(databasePath);
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
  console.log(`Factory fixture ${fixture.name} listening at ${service.url}`);
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
