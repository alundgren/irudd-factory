import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  SCENARIO_EFFORT,
  SCENARIO_MODEL,
  SCENARIOS,
  SCENARIO_NAMES,
  seedScenario,
  StateStore,
  type ScenarioName,
} from "@irudd-factory/application";
import { openStateStore } from "@irudd-factory/state-sqlite";
import { Effect } from "effect";
import { fixtureDependencies } from "./fixtures.ts";
import { startFactoryService } from "./service.ts";
import type { FactoryConfig } from "./config.ts";

const requested = process.argv[2];
if (!SCENARIO_NAMES.includes(requested as ScenarioName)) {
  console.error(`usage: bun run fixture -- ${SCENARIO_NAMES.join("|")}`);
  process.exit(2);
}
const scenarioName = requested as ScenarioName;
const root = resolve(".factory", "fixtures", scenarioName);
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
  repository: "factory/fixture",
  databasePath,
  workspaceRoot: resolve(root, "workspaces"),
  bindHost: "127.0.0.1",
  port: Number(process.env.FACTORY_FIXTURE_PORT ?? "4317"),
  codex: { model: SCENARIO_MODEL, reasoningEffort: SCENARIO_EFFORT },
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
  seedScenario(SCENARIOS[scenarioName]).pipe(
    Effect.provideService(StateStore, seedStore.service),
  ),
);
seedStore.close();

const service = await startFactoryService(
  config,
  fixtureDependencies(config, scenarioName),
);
console.log(`Factory fixture ${scenarioName} listening at ${service.url}`);
console.log(
  `Second RPC client: bun run apps/cli/src/main.ts run-next --command-id second-${scenarioName} --url ${service.url}/rpc`,
);

await new Promise<void>((resolve) => {
  const stop = () => resolve();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
});
await service.stop();
