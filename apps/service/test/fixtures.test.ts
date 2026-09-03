import { afterEach, describe, expect, test } from "vite-plus/test";
import { readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { StateStore } from "@irudd-factory/application";
import { openStateStore } from "@irudd-factory/state-sqlite";
import { Effect } from "effect";
import {
  getFactorySnapshot,
  runNextEligibleIssue,
} from "../../cli/src/client.ts";
import {
  fixtureCatalogEntry,
  fixtureDescription,
  renderFixtureCatalog,
  renderFixtureDescription,
} from "../fixtures/catalog.ts";
import { fixtureDependencies, seedFixture } from "../fixtures/composition.ts";
import {
  FIXTURE_EFFORT,
  FIXTURE_MODEL,
  FIXTURE_REPOSITORY,
} from "../fixtures/factories.ts";
import {
  FIXTURE_REGISTRY,
  validateFixtureRegistry,
} from "../fixtures/registry.ts";
import type {
  FixtureControls,
  FixtureDefinition,
  FixtureExpectations,
} from "../fixtures/types.ts";
import type { FactoryConfig } from "../src/config.ts";
import { startFactoryService } from "../src/service.ts";

const roots: string[] = [];
const stops: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function gate() {
  let release!: () => void;
  const opened = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  return { wait: () => opened, release };
}

function config(root: string): FactoryConfig {
  return {
    repositories: [
      {
        repository: FIXTURE_REPOSITORY,
        codex: { model: FIXTURE_MODEL, reasoningEffort: FIXTURE_EFFORT },
      },
    ],
    databasePath: join(root, "factory.db"),
    workspaceRoot: join(root, "workspaces"),
    bindHost: "127.0.0.1",
    port: 0,
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
}

async function waitForState(
  url: string,
  state: "starting" | "running" | "completed" | "failed",
) {
  const deadline = Date.now() + 3_000;
  let snapshot = await getFactorySnapshot(url);
  while (snapshot.assignment?.state !== state && Date.now() < deadline) {
    await delay(20);
    snapshot = await getFactorySnapshot(url);
  }
  expect(snapshot.assignment?.state).toBe(state);
  return snapshot;
}

async function seedAndInspect(
  fixture: FixtureDefinition,
  fixtureConfig: FactoryConfig,
) {
  const opened = openStateStore(fixtureConfig.databasePath);
  const seed = seedFixture(fixture).pipe(
    Effect.provideService(StateStore, opened.service),
  );
  await Effect.runPromise(seed);
  const first = await Effect.runPromise(opened.service.getSnapshot());
  await Effect.runPromise(seed);
  const second = await Effect.runPromise(opened.service.getSnapshot());
  const active = (
    opened.database
      .prepare(
        "SELECT count(*) AS count FROM assignments WHERE state IN ('reserved', 'starting', 'running')",
      )
      .get() as { count: number }
  ).count;
  opened.close();
  return { first, second, active };
}

describe("fixture catalog", () => {
  test("uses valid metadata in deterministic registry order", () => {
    expect(validateFixtureRegistry(FIXTURE_REGISTRY)).toBe(FIXTURE_REGISTRY);
    expect(FIXTURE_REGISTRY.map(({ name }) => name)).toEqual([
      "empty",
      "ambiguous",
      "busy-reserved",
      "busy-starting",
      "busy-running",
      "runnable",
      "failed-long",
      "completed-ready",
      "completed-draft",
    ]);
    for (const fixture of FIXTURE_REGISTRY) {
      expect(fixture.summary.length).toBeGreaterThan(0);
      expect(fixture.summary.length).toBeLessThanOrEqual(100);
      expect(fixture.summary).not.toMatch(/[\r\n]/);
      expect(fixture.tags.length).toBeLessThanOrEqual(5);
      expect(new Set(fixture.tags).size).toBe(fixture.tags.length);
      for (const tag of fixture.tags) {
        expect(tag).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
        expect(tag.length).toBeLessThanOrEqual(24);
      }
    }
  });

  test("rejects duplicate names, invalid summaries, and invalid tags", () => {
    const base = FIXTURE_REGISTRY[0];
    const invalid = (fixture: FixtureDefinition) => () =>
      validateFixtureRegistry([fixture]);
    expect(() => validateFixtureRegistry([base, base])).toThrow(
      "Duplicate fixture name",
    );
    expect(invalid({ ...base, summary: "" })).toThrow("invalid summary");
    expect(invalid({ ...base, summary: "first\nsecond" })).toThrow(
      "invalid summary",
    );
    expect(invalid({ ...base, summary: "x".repeat(101) })).toThrow(
      "invalid summary",
    );
    expect(invalid({ ...base, tags: ["same", "same"] })).toThrow(
      "invalid tags",
    );
    expect(invalid({ ...base, tags: ["Not-Lowercase"] })).toThrow(
      "invalid tag",
    );
    expect(invalid({ ...base, tags: ["x".repeat(25)] })).toThrow("invalid tag");
    expect(invalid({ ...base, tags: ["a", "b", "c", "d", "e", "f"] })).toThrow(
      "invalid tags",
    );
  });

  test("registers every fixture directory under the matching name", async () => {
    const fixtureRoot = resolve("apps/service/fixtures");
    const entries = await readdir(fixtureRoot, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(directories).toEqual(
      FIXTURE_REGISTRY.map(({ name }) => name).toSorted(),
    );
    for (const fixture of FIXTURE_REGISTRY) {
      const source = await import(`../fixtures/${fixture.name}/fixture.ts`);
      expect(
        Object.values(source).some(
          (value) =>
            typeof value === "object" &&
            value !== null &&
            "name" in value &&
            value.name === fixture.name,
        ),
      ).toBe(true);
    }
  });

  test("renders compact and detailed output from the registered definitions", () => {
    const compact = FIXTURE_REGISTRY.map(fixtureCatalogEntry);
    expect(Object.keys(compact[0]!)).toEqual(["name", "summary", "tags"]);
    const humanCatalog = renderFixtureCatalog(FIXTURE_REGISTRY);
    for (const fixture of FIXTURE_REGISTRY) {
      expect(humanCatalog).toContain(fixture.name);
      expect(humanCatalog).toContain(fixture.summary);
    }
    const runnable = FIXTURE_REGISTRY.find(({ name }) => name === "runnable")!;
    const detailed = fixtureDescription(runnable);
    expect(detailed.expectations).toBe(runnable.expectations);
    const human = renderFixtureDescription(runnable);
    expect(human).toContain(runnable.purpose);
    expect(human).toContain("Candidate count: 1");
    expect(human).toContain("Command result: started");
    expect(human).toContain("Second client result: provider_busy");
    for (const check of detailed.expectations.checks) {
      expect(human).toContain(`- ${check}`);
    }
  });
});

describe("fixture contract", () => {
  test("executes every registered fixture expectation through real SQLite and service composition", async () => {
    for (const fixture of FIXTURE_REGISTRY) {
      const root = await mkdtemp(join(tmpdir(), `factory-${fixture.name}-`));
      roots.push(root);
      const fixtureConfig = config(root);
      const { first, second, active } = await seedAndInspect(
        fixture,
        fixtureConfig,
      );
      const expected: FixtureExpectations = fixture.expectations;
      expect(second).toEqual(first);
      expect(expected.reset).toBe("deterministic");
      expect(fixture.state.candidates).toHaveLength(
        expected.initial.candidateCount,
      );
      expect(first.assignment).toEqual(expected.initial.assignment);
      expect(active).toBe(expected.initial.activeAssignmentCount);
      expect(first.events.map(({ type }) => type)).toEqual(
        expected.initial.eventTypes,
      );
      if (!expected.command) continue;

      const enterRunning = gate();
      const finish = gate();
      const controls: FixtureControls = expected.lifecycle
        ? {
            beforeRunning: enterRunning.wait,
            beforeCompletion: finish.wait,
          }
        : {};
      const service = await startFactoryService(
        fixtureConfig,
        fixtureDependencies(fixtureConfig, fixture, controls),
        join(root, "no-console"),
      );
      stops.push(service.stop);
      const rpcUrl = `${service.url}/rpc`;
      const receipt = await runNextEligibleIssue(
        rpcUrl,
        `contract-${fixture.name}`,
      );
      expect(receipt.result._tag).toBe(expected.command.result);
      if (
        receipt.result._tag === "selection_ambiguous" &&
        expected.command.issueLinkCount !== undefined
      ) {
        expect(receipt.result.issueLinks).toHaveLength(
          expected.command.issueLinkCount,
        );
      }
      if (
        (receipt.result._tag === "started" ||
          receipt.result._tag === "provider_busy") &&
        expected.command.assignmentState !== undefined
      ) {
        expect(receipt.result.assignment.state).toBe(
          expected.command.assignmentState,
        );
      }

      if (expected.lifecycle) {
        const observedStates = [
          receipt.result._tag === "started"
            ? receipt.result.assignment.state
            : null,
        ];
        await waitForState(rpcUrl, "starting");
        observedStates.push("starting");
        const secondClient = await runNextEligibleIssue(
          rpcUrl,
          `second-${fixture.name}`,
        );
        expect(secondClient.result._tag).toBe(
          expected.lifecycle.secondClientResult,
        );
        enterRunning.release();
        await waitForState(rpcUrl, "running");
        observedStates.push("running");
        finish.release();
        const terminal = await waitForState(
          rpcUrl,
          expected.lifecycle.terminalState,
        );
        observedStates.push(terminal.assignment?.state ?? null);
        expect(observedStates).toEqual(expected.lifecycle.states);
        expect(terminal.events.map(({ type }) => type)).toEqual(
          expected.lifecycle.terminalEventTypes,
        );
        expect(terminal.assignment?.pullRequest).toEqual(
          expected.lifecycle.pullRequest,
        );
        const after = await runNextEligibleIssue(
          rpcUrl,
          `after-${fixture.name}`,
        );
        expect(after.result._tag).toBe(expected.lifecycle.afterTerminalResult);
      }
      await service.stop();
      stops.pop();
    }
  });
});
