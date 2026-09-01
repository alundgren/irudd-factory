import { afterEach, describe, expect, test } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SCENARIOS,
  SCENARIO_NAMES,
  seedScenario,
  StateStore,
} from "@irudd-factory/application";
import { openStateStore } from "@irudd-factory/state-sqlite";
import { Effect } from "effect";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("fixture composition inputs", () => {
  test("resets every scenario through the state port", async () => {
    for (const name of SCENARIO_NAMES) {
      const root = await mkdtemp(join(tmpdir(), `factory-${name}-`));
      roots.push(root);
      const opened = openStateStore(join(root, "fixture.db"));
      const seed = seedScenario(SCENARIOS[name]).pipe(
        Effect.provideService(StateStore, opened.service),
      );
      await Effect.runPromise(seed);
      const first = await Effect.runPromise(opened.service.getSnapshot());
      await Effect.runPromise(seed);
      const second = await Effect.runPromise(opened.service.getSnapshot());
      expect(second).toEqual(first);
      const active = opened.database
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM assignments WHERE state IN ('reserved', 'starting', 'running')",
        )
        .get()?.count;
      expect(active === 0 || active === 1).toBe(true);
      opened.close();
    }
  });
});
