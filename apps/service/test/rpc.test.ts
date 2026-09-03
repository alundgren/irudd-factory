import { afterEach, describe, expect, test } from "vite-plus/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { StateStore } from "@irudd-factory/application";
import { openStateStore } from "@irudd-factory/state-sqlite";
import { Effect } from "effect";
import {
  getFactorySnapshot,
  listQueue,
  runNextEligibleIssue,
  setCodexEnabled,
  setDispatchPaused,
  startIssue,
} from "../../cli/src/client.ts";
import { fixtureIssue } from "../fixtures/factories.ts";
import { fixtureDependencies, seedFixture } from "../fixtures/composition.ts";
import { getFixture, type FixtureName } from "../fixtures/registry.ts";
import { startFactoryService } from "../src/service.ts";
import type { FactoryConfig } from "../src/config.ts";

const roots: string[] = [];
const stops: Array<() => Promise<void>> = [];
const fixture = (name: FixtureName) => getFixture(name)!;
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

async function makeConsoleDist(root: string): Promise<string> {
  const dist = join(root, "console-dist");
  await mkdir(join(dist, "assets"), { recursive: true });
  await Promise.all([
    writeFile(
      join(dist, "index.html"),
      "<!doctype html><title>Irudd Factory</title>",
    ),
    writeFile(join(dist, "assets", "index.js"), "export {};\n"),
  ]);
  return dist;
}

async function waitForRpc(url: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      await getFactorySnapshot(url);
      return;
    } catch {
      await delay(20);
    }
  }
  throw new Error("RPC service did not start");
}

function gate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait: () => opened, release };
}

async function waitForAssignmentState(
  url: string,
  state:
    | "reserved"
    | "starting"
    | "running"
    | "completed"
    | "failed"
    | "ownership_uncertain",
): Promise<Awaited<ReturnType<typeof getFactorySnapshot>>> {
  const deadline = Date.now() + 3_000;
  let snapshot = await getFactorySnapshot(url);
  while (snapshot.assignment?.state !== state && Date.now() < deadline) {
    await delay(20);
    snapshot = await getFactorySnapshot(url);
  }
  expect(snapshot.assignment?.state).toBe(state);
  return snapshot;
}

describe("Factory RPC service", () => {
  test("returns an assigned port only after RPC is ready", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-rpc-ready-"));
    roots.push(root);
    const config: FactoryConfig = {
      repositories: [
        {
          repository: "factory/fixture",
          codex: { model: "gpt-5.6-luna", reasoningEffort: "low" },
        },
      ],
      databasePath: join(root, "factory.db"),
      workspaceRoot: join(root, "workspaces"),
      bindHost: "127.0.0.1",
      port: 0,
      codex: { model: "gpt-5.6-luna", reasoningEffort: "low", slots: 1 },
      pollIntervalMs: 30_000,
      timeouts: {
        childStartupMs: 1_000,
        initializationMs: 1_000,
        modelSchemaMs: 1_000,
        turnMs: 5_000,
        shutdownMs: 1_000,
      },
    };
    const service = await startFactoryService(
      config,
      fixtureDependencies(config, fixture("empty")),
    );
    expect(service.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(service.url.endsWith(":0")).toBe(false);
    await expect(
      getFactorySnapshot(`${service.url}/rpc`),
    ).resolves.toMatchObject({ assignment: null });
    const terminated = service.terminated;
    await service.stop();
    await expect(terminated).resolves.toBeUndefined();
  });

  test("reports listener startup failure", async () => {
    const occupied = createNetServer();
    await new Promise<void>((resolveListen) =>
      occupied.listen(0, "127.0.0.1", resolveListen),
    );
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("no TCP port");
    const root = await mkdtemp(join(tmpdir(), "factory-rpc-bind-failure-"));
    roots.push(root);
    const config: FactoryConfig = {
      repositories: [
        {
          repository: "factory/fixture",
          codex: { model: "gpt-5.6-luna", reasoningEffort: "low" },
        },
      ],
      databasePath: join(root, "factory.db"),
      workspaceRoot: join(root, "workspaces"),
      bindHost: "127.0.0.1",
      port: address.port,
      codex: { model: "gpt-5.6-luna", reasoningEffort: "low", slots: 1 },
      pollIntervalMs: 30_000,
      timeouts: {
        childStartupMs: 1_000,
        initializationMs: 1_000,
        modelSchemaMs: 1_000,
        turnMs: 5_000,
        shutdownMs: 1_000,
      },
    };
    try {
      await expect(
        startFactoryService(
          config,
          fixtureDependencies(config, fixture("empty")),
        ),
      ).rejects.toThrow("listener failed to start");
    } finally {
      await new Promise<void>((resolveClose, rejectClose) =>
        occupied.close((error) =>
          error ? rejectClose(error) : resolveClose(),
        ),
      );
    }
  });

  test("exposes unexpected listener termination", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-rpc-termination-"));
    roots.push(root);
    const config: FactoryConfig = {
      repositories: [
        {
          repository: "factory/fixture",
          codex: { model: "gpt-5.6-luna", reasoningEffort: "low" },
        },
      ],
      databasePath: join(root, "factory.db"),
      workspaceRoot: join(root, "workspaces"),
      bindHost: "127.0.0.1",
      port: 0,
      codex: { model: "gpt-5.6-luna", reasoningEffort: "low", slots: 1 },
      pollIntervalMs: 30_000,
      timeouts: {
        childStartupMs: 1_000,
        initializationMs: 1_000,
        modelSchemaMs: 1_000,
        turnMs: 5_000,
        shutdownMs: 1_000,
      },
    };
    const listener = createHttpServer();
    const service = await startFactoryService(
      config,
      fixtureDependencies(config, fixture("empty")),
      await makeConsoleDist(root),
      listener,
    );
    const terminated = service.terminated;
    await new Promise<void>((resolveClose, rejectClose) =>
      listener.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
    await expect(terminated).resolves.toBeUndefined();
    await service.stop();
  });

  test("takes one fake issue through a durable completed pull request", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-rpc-test-"));
    roots.push(root);
    const config: FactoryConfig = {
      repositories: [
        {
          repository: "factory/fixture",
          codex: { model: "gpt-5.6-luna", reasoningEffort: "low" },
        },
      ],
      databasePath: join(root, "factory.db"),
      workspaceRoot: join(root, "workspaces"),
      bindHost: "127.0.0.1",
      port: 0,
      codex: { model: "gpt-5.6-luna", reasoningEffort: "low", slots: 1 },
      pollIntervalMs: 30_000,
      timeouts: {
        childStartupMs: 1_000,
        initializationMs: 1_000,
        modelSchemaMs: 1_000,
        turnMs: 5_000,
        shutdownMs: 1_000,
      },
    };
    const enterRunning = gate();
    const finish = gate();
    const service = await startFactoryService(
      config,
      fixtureDependencies(config, fixture("runnable"), {
        beforeRunning: enterRunning.wait,
        beforeCompletion: finish.wait,
      }),
      await makeConsoleDist(root),
    );
    stops.push(service.stop);
    const rpcUrl = `${service.url}/rpc`;
    await waitForRpc(rpcUrl);
    const consoleResponse = await fetch(service.url);
    expect(consoleResponse.status).toBe(200);
    expect(await consoleResponse.text()).toContain(
      "<title>Irudd Factory</title>",
    );

    const receipt = await runNextEligibleIssue(rpcUrl, "command-1");
    expect(receipt.result._tag).toBe("started");
    const replay = await runNextEligibleIssue(rpcUrl, "command-1");
    expect(replay).toEqual(receipt);

    await waitForAssignmentState(rpcUrl, "starting");
    enterRunning.release();
    await waitForAssignmentState(rpcUrl, "running");
    finish.release();
    const snapshot = await waitForAssignmentState(rpcUrl, "completed");
    expect(snapshot.assignment?.pullRequest).toEqual({
      url: "https://github.com/factory/fixture/pull/99",
      number: 99,
      draft: false,
    });
    expect(snapshot.events.map(({ type }) => type)).toEqual([
      "assignment.reserved",
      "provider.start.requested",
      "workspace.created",
      "provider.process.start_pending",
      "provider.thread.started",
      "provider.turn.finished",
      "assignment.completed",
    ]);

    const afterHistory = await runNextEligibleIssue(rpcUrl, "command-2");
    expect(afterHistory.result._tag).toBe("no_candidate");
  });

  test("starts side effects once for concurrent replay of one command", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-rpc-replay-race-"));
    roots.push(root);
    const config: FactoryConfig = {
      repositories: [
        {
          repository: "factory/fixture",
          codex: { model: "gpt-5.6-luna", reasoningEffort: "low" },
        },
      ],
      databasePath: join(root, "factory.db"),
      workspaceRoot: join(root, "workspaces"),
      bindHost: "127.0.0.1",
      port: 0,
      codex: { model: "gpt-5.6-luna", reasoningEffort: "low", slots: 1 },
      pollIntervalMs: 30_000,
      timeouts: {
        childStartupMs: 1_000,
        initializationMs: 1_000,
        modelSchemaMs: 1_000,
        turnMs: 5_000,
        shutdownMs: 1_000,
      },
    };
    const enterRunning = gate();
    const finish = gate();
    const calls = { claim: 0, workspace: 0, provider: 0 };
    const service = await startFactoryService(
      config,
      fixtureDependencies(config, fixture("runnable"), {
        beforeRunning: enterRunning.wait,
        beforeCompletion: finish.wait,
        onClaim: () => calls.claim++,
        onWorkspace: () => calls.workspace++,
        onProviderRun: () => calls.provider++,
      }),
    );
    stops.push(service.stop);
    const rpcUrl = `${service.url}/rpc`;
    await waitForRpc(rpcUrl);

    const receipts = await Promise.all([
      runNextEligibleIssue(rpcUrl, "same-command"),
      runNextEligibleIssue(rpcUrl, "same-command"),
    ]);
    expect(receipts[0]).toEqual(receipts[1]);
    await waitForAssignmentState(rpcUrl, "starting");
    expect(calls).toEqual({ claim: 1, workspace: 1, provider: 1 });

    enterRunning.release();
    await waitForAssignmentState(rpcUrl, "running");
    finish.release();
    await waitForAssignmentState(rpcUrl, "completed");
    expect(calls).toEqual({ claim: 1, workspace: 1, provider: 1 });
  });

  test("persists observed provider values before mismatch failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-rpc-mismatch-"));
    roots.push(root);
    const config: FactoryConfig = {
      repositories: [
        {
          repository: "factory/fixture",
          codex: { model: "gpt-5.6-luna", reasoningEffort: "low" },
        },
      ],
      databasePath: join(root, "factory.db"),
      workspaceRoot: join(root, "workspaces"),
      bindHost: "127.0.0.1",
      port: 0,
      codex: { model: "gpt-5.6-luna", reasoningEffort: "low", slots: 1 },
      pollIntervalMs: 30_000,
      timeouts: {
        childStartupMs: 1_000,
        initializationMs: 1_000,
        modelSchemaMs: 1_000,
        turnMs: 5_000,
        shutdownMs: 1_000,
      },
    };
    const service = await startFactoryService(
      config,
      fixtureDependencies(config, fixture("runnable"), {
        failAfterObservation: {
          model: "unexpected-model",
          effort: "high",
        },
      }),
    );
    stops.push(service.stop);
    const rpcUrl = `${service.url}/rpc`;
    await waitForRpc(rpcUrl);
    await runNextEligibleIssue(rpcUrl, "mismatch-command");

    const snapshot = await waitForAssignmentState(rpcUrl, "failed");
    expect(snapshot.assignment).toMatchObject({
      observedModel: "unexpected-model",
      observedEffort: "high",
      error: { code: "observed_model_mismatch" },
    });
  });

  test("stop interrupts an in-flight assignment instead of leaving it running", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-rpc-shutdown-"));
    roots.push(root);
    const config: FactoryConfig = {
      repositories: [
        {
          repository: "factory/fixture",
          codex: { model: "gpt-5.6-luna", reasoningEffort: "low" },
        },
      ],
      databasePath: join(root, "factory.db"),
      workspaceRoot: join(root, "workspaces"),
      bindHost: "127.0.0.1",
      port: 0,
      codex: { model: "gpt-5.6-luna", reasoningEffort: "low", slots: 1 },
      pollIntervalMs: 30_000,
      timeouts: {
        childStartupMs: 1_000,
        initializationMs: 1_000,
        modelSchemaMs: 1_000,
        turnMs: 5_000,
        shutdownMs: 1_000,
      },
    };
    const enterRunning = gate();
    const neverFinishes = gate();
    let interrupted = false;
    const service = await startFactoryService(
      config,
      fixtureDependencies(config, fixture("runnable"), {
        beforeRunning: enterRunning.wait,
        beforeCompletion: neverFinishes.wait,
        onProviderInterrupted: () => {
          interrupted = true;
        },
      }),
    );
    const rpcUrl = `${service.url}/rpc`;
    await waitForRpc(rpcUrl);

    await runNextEligibleIssue(rpcUrl, "shutdown-command");
    await waitForAssignmentState(rpcUrl, "starting");
    enterRunning.release();
    await waitForAssignmentState(rpcUrl, "running");

    await Promise.race([
      service.stop(),
      delay(2_000).then(() => {
        throw new Error("service.stop() hung waiting for the blocked run");
      }),
    ]);
    expect(interrupted).toBe(true);
  });

  test("returns every command result through the same RPC", async () => {
    for (const [fixtureName, expected] of [
      ["empty", "no_candidate"],
      ["ambiguous", "selection_ambiguous"],
      ["busy-reserved", "provider_busy"],
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), `factory-rpc-${fixtureName}-`));
      roots.push(root);
      const config: FactoryConfig = {
        repositories: [
          {
            repository: "factory/fixture",
            codex: { model: "gpt-5.6-luna", reasoningEffort: "low" },
          },
        ],
        databasePath: join(root, "factory.db"),
        workspaceRoot: join(root, "workspaces"),
        bindHost: "127.0.0.1",
        port: 0,
        codex: { model: "gpt-5.6-luna", reasoningEffort: "low", slots: 1 },
        pollIntervalMs: 30_000,
        timeouts: {
          childStartupMs: 1_000,
          initializationMs: 1_000,
          modelSchemaMs: 1_000,
          turnMs: 5_000,
          shutdownMs: 1_000,
        },
      };
      const store = openStateStore(config.databasePath);
      await Effect.runPromise(
        seedFixture(fixture(fixtureName)).pipe(
          Effect.provideService(StateStore, store.service),
        ),
      );
      store.close();
      const service = await startFactoryService(
        config,
        fixtureDependencies(config, fixture(fixtureName)),
      );
      const rpcUrl = `${service.url}/rpc`;
      await waitForRpc(rpcUrl);
      const receipt = await runNextEligibleIssue(
        rpcUrl,
        `command-${fixtureName}`,
      );
      expect(receipt.result._tag).toBe(expected);
      if (receipt.result._tag === "selection_ambiguous") {
        expect(receipt.result.issueLinks).toHaveLength(2);
      }
      if (receipt.result._tag === "provider_busy") {
        expect(receipt.result.assignment.state).toBe("reserved");
      }
      await service.stop();
    }
  });

  test("starts issues from two repositories with effective Codex settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-rpc-pool-"));
    roots.push(root);
    const config: FactoryConfig = {
      repositories: [
        {
          repository: "owner/one",
          codex: { model: "model-one", reasoningEffort: "medium" },
        },
        {
          repository: "owner/two",
          codex: { model: "model-two", reasoningEffort: "high" },
        },
      ],
      databasePath: join(root, "factory.db"),
      workspaceRoot: join(root, "workspaces"),
      bindHost: "127.0.0.1",
      port: 0,
      pollIntervalMs: 30_000,
      codex: { model: "global-model", reasoningEffort: "low", slots: 2 },
      timeouts: {
        childStartupMs: 1_000,
        initializationMs: 1_000,
        modelSchemaMs: 1_000,
        turnMs: 5_000,
        shutdownMs: 1_000,
      },
    };
    const base = fixture("runnable");
    const poolFixture = {
      ...base,
      name: "repository-pool",
      state: {
        ...base.state,
        candidates: [
          { ...fixtureIssue(11), repository: "owner/one" },
          { ...fixtureIssue(22), repository: "owner/two" },
        ],
      },
    };
    const service = await startFactoryService(
      config,
      fixtureDependencies(config, poolFixture),
    );
    stops.push(service.stop);
    const rpcUrl = `${service.url}/rpc`;
    await waitForRpc(rpcUrl);
    const receipts = await Promise.all([
      startIssue(rpcUrl, "start-one", "OWNER/ONE", 11),
      startIssue(rpcUrl, "start-two", "owner/two", 22),
    ]);
    expect(receipts.map(({ result }) => result._tag)).toEqual([
      "started",
      "started",
    ]);
    const snapshot = await getFactorySnapshot(rpcUrl);
    expect(
      snapshot.assignments
        ?.map((assignment) => ({
          repository: assignment.issue.repository,
          model: assignment.requestedModel,
          effort: assignment.requestedEffort,
        }))
        .toSorted((left, right) =>
          left.repository.localeCompare(right.repository),
        ),
    ).toEqual([
      { repository: "owner/one", model: "model-one", effort: "medium" },
      { repository: "owner/two", model: "model-two", effort: "high" },
    ]);
    expect(snapshot.configuration).toMatchObject({
      codexSlots: 2,
      pollIntervalMs: 30_000,
    });
  });

  test("keeps a slot occupied when provider cleanup is unconfirmed", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-rpc-cleanup-"));
    roots.push(root);
    const config: FactoryConfig = {
      repositories: [
        {
          repository: "factory/fixture",
          codex: { model: "gpt-5.6-luna", reasoningEffort: "low" },
        },
      ],
      databasePath: join(root, "factory.db"),
      workspaceRoot: join(root, "workspaces"),
      bindHost: "127.0.0.1",
      port: 0,
      pollIntervalMs: 30_000,
      codex: { model: "gpt-5.6-luna", reasoningEffort: "low", slots: 1 },
      timeouts: {
        childStartupMs: 1_000,
        initializationMs: 1_000,
        modelSchemaMs: 1_000,
        turnMs: 5_000,
        shutdownMs: 1_000,
      },
    };
    const service = await startFactoryService(
      config,
      fixtureDependencies(config, fixture("runnable"), {
        cleanupUncertain: true,
      }),
    );
    stops.push(service.stop);
    const rpcUrl = `${service.url}/rpc`;
    await waitForRpc(rpcUrl);
    await runNextEligibleIssue(rpcUrl, "cleanup-first");
    const uncertain = await waitForAssignmentState(
      rpcUrl,
      "ownership_uncertain",
    );
    expect(uncertain.assignment?.error).toMatchObject({
      code: "cleanup_timeout",
    });
    const second = await runNextEligibleIssue(rpcUrl, "cleanup-second");
    expect(second.result._tag).toBe("provider_busy");
  });

  test("run-next keeps the selected candidate's repository settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-rpc-next-settings-"));
    roots.push(root);
    const config: FactoryConfig = {
      repositories: [
        {
          repository: "owner/one",
          codex: { model: "global-model", reasoningEffort: "medium" },
        },
        {
          repository: "owner/two",
          codex: { model: "override-model", reasoningEffort: "high" },
        },
      ],
      databasePath: join(root, "factory.db"),
      workspaceRoot: join(root, "workspaces"),
      bindHost: "127.0.0.1",
      port: 0,
      pollIntervalMs: 30_000,
      codex: { model: "global-model", reasoningEffort: "medium", slots: 1 },
      timeouts: {
        childStartupMs: 1_000,
        initializationMs: 1_000,
        modelSchemaMs: 1_000,
        turnMs: 5_000,
        shutdownMs: 1_000,
      },
    };
    const issueOne = { ...fixtureIssue(11), repository: "owner/one" };
    const issueTwo = { ...fixtureIssue(22), repository: "owner/two" };
    const seed = openStateStore(config.databasePath);
    await Effect.runPromise(
      seed.service.seedAssignment(
        {
          ...fixture("completed-ready").state.assignment!,
          id: "historical-attempt",
          issue: issueOne,
        },
        [],
      ),
    );
    seed.close();
    const base = fixture("runnable");
    const poolFixture = {
      ...base,
      name: "run-next-settings",
      state: { ...base.state, candidates: [issueOne, issueTwo] },
    };
    const service = await startFactoryService(
      config,
      fixtureDependencies(config, poolFixture),
    );
    stops.push(service.stop);
    const receipt = await runNextEligibleIssue(
      `${service.url}/rpc`,
      "run-next-settings",
    );
    expect(receipt.result._tag).toBe("started");
    if (receipt.result._tag === "started") {
      expect(receipt.result.assignment.issue.repository).toBe("owner/two");
      expect(receipt.result.assignment.requestedModel).toBe("override-model");
      expect(receipt.result.assignment.requestedEffort).toBe("high");
    }
  });

  test("automatic dispatch fills the configured Codex slots", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-rpc-auto-fill-"));
    roots.push(root);
    const config: FactoryConfig = {
      repositories: [
        {
          repository: "factory/fixture",
          codex: { model: "gpt-5.6-luna", reasoningEffort: "low" },
        },
      ],
      databasePath: join(root, "factory.db"),
      workspaceRoot: join(root, "workspaces"),
      bindHost: "127.0.0.1",
      port: 0,
      pollIntervalMs: 20,
      codex: { model: "gpt-5.6-luna", reasoningEffort: "low", slots: 2 },
      timeouts: {
        childStartupMs: 1_000,
        initializationMs: 1_000,
        modelSchemaMs: 1_000,
        turnMs: 5_000,
        shutdownMs: 1_000,
      },
    };
    const base = fixture("runnable");
    const automaticFixture = {
      ...base,
      name: "automatic-fill",
      state: {
        ...base.state,
        candidates: [fixtureIssue(31), fixtureIssue(32), fixtureIssue(33)],
      },
    };
    const firstFinishes = gate();
    const neverFinishes = gate();
    const calls = { claim: 0, workspace: 0, provider: 0 };
    const service = await startFactoryService(
      config,
      fixtureDependencies(config, automaticFixture, {
        beforeCompletion: (issueNumber) =>
          issueNumber === 31 ? firstFinishes.wait() : neverFinishes.wait(),
        hideClaimedCandidates: true,
        onClaim: () => calls.claim++,
        onWorkspace: () => calls.workspace++,
        onProviderRun: () => calls.provider++,
      }),
    );
    stops.push(service.stop);
    const rpcUrl = `${service.url}/rpc`;
    const deadline = Date.now() + 3_000;
    let snapshot = await getFactorySnapshot(rpcUrl);
    while (
      ((snapshot.assignments?.length ?? 0) !== 2 || calls.provider !== 2) &&
      Date.now() < deadline
    ) {
      await delay(20);
      snapshot = await getFactorySnapshot(rpcUrl);
    }
    expect(snapshot.assignments).toHaveLength(2);
    expect(calls).toEqual({ claim: 2, workspace: 2, provider: 2 });
    firstFinishes.release();
    while (calls.provider !== 3 && Date.now() < deadline) {
      await delay(20);
    }
    expect(calls).toEqual({ claim: 3, workspace: 3, provider: 3 });
    snapshot = await getFactorySnapshot(rpcUrl);
    expect(
      snapshot.assignments?.map(({ issue }) => issue.number).sort(),
    ).toEqual([32, 33]);
  });

  test("fresh validation rejects stale queue work before side effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-rpc-auto-stale-"));
    roots.push(root);
    const config: FactoryConfig = {
      repositories: [
        {
          repository: "factory/fixture",
          codex: { model: "gpt-5.6-luna", reasoningEffort: "low" },
        },
      ],
      databasePath: join(root, "factory.db"),
      workspaceRoot: join(root, "workspaces"),
      bindHost: "127.0.0.1",
      port: 0,
      pollIntervalMs: 50,
      codex: { model: "gpt-5.6-luna", reasoningEffort: "low", slots: 1 },
      timeouts: {
        childStartupMs: 1_000,
        initializationMs: 1_000,
        modelSchemaMs: 1_000,
        turnMs: 5_000,
        shutdownMs: 1_000,
      },
    };
    const calls = { claim: 0, workspace: 0, provider: 0, revalidate: 0 };
    const service = await startFactoryService(
      config,
      fixtureDependencies(config, fixture("runnable"), {
        revalidateFailure: "The issue changed after polling",
        onRevalidate: () => calls.revalidate++,
        onClaim: () => calls.claim++,
        onWorkspace: () => calls.workspace++,
        onProviderRun: () => calls.provider++,
      }),
    );
    stops.push(service.stop);
    const rpcUrl = `${service.url}/rpc`;
    const deadline = Date.now() + 3_000;
    let queue = await listQueue(rpcUrl, { limit: 10 });
    while (
      !queue.items.some(({ reason }) => reason?.code === "issue_ineligible") &&
      Date.now() < deadline
    ) {
      await delay(20);
      queue = await listQueue(rpcUrl, { limit: 10 });
    }
    expect(queue.items.some(({ startable }) => !startable)).toBe(true);
    expect(calls.revalidate).toBeGreaterThan(0);
    expect(calls).toMatchObject({ claim: 0, workspace: 0, provider: 0 });
    expect((await getFactorySnapshot(rpcUrl)).assignment).toBeNull();
  });

  test("does not retry a failed claim while discovery stays eligible", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-rpc-claim-tenure-"));
    roots.push(root);
    const config: FactoryConfig = {
      repositories: [
        {
          repository: "factory/fixture",
          codex: { model: "gpt-5.6-luna", reasoningEffort: "low" },
        },
      ],
      databasePath: join(root, "factory.db"),
      workspaceRoot: join(root, "workspaces"),
      bindHost: "127.0.0.1",
      port: 0,
      pollIntervalMs: 20,
      codex: { model: "gpt-5.6-luna", reasoningEffort: "low", slots: 1 },
      timeouts: {
        childStartupMs: 1_000,
        initializationMs: 1_000,
        modelSchemaMs: 1_000,
        turnMs: 5_000,
        shutdownMs: 1_000,
      },
    };
    const base = fixture("runnable");
    const claimFailureFixture = {
      ...base,
      name: "claim-tenure",
      behavior: { ...base.behavior, claimOutcome: "unclaimed" as const },
    };
    let claimCalls = 0;
    const service = await startFactoryService(
      config,
      fixtureDependencies(config, claimFailureFixture, {
        onClaim: () => claimCalls++,
      }),
    );
    stops.push(service.stop);
    const rpcUrl = `${service.url}/rpc`;
    await waitForAssignmentState(rpcUrl, "failed");
    await delay(120);
    expect(claimCalls).toBe(1);
  });

  test("does not enqueue a manual pre-poll start while it remains eligible", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-rpc-manual-tenure-"));
    roots.push(root);
    const config: FactoryConfig = {
      repositories: [
        {
          repository: "factory/fixture",
          codex: { model: "gpt-5.6-luna", reasoningEffort: "low" },
        },
      ],
      databasePath: join(root, "factory.db"),
      workspaceRoot: join(root, "workspaces"),
      bindHost: "127.0.0.1",
      port: 0,
      pollIntervalMs: 60,
      codex: { model: "gpt-5.6-luna", reasoningEffort: "low", slots: 1 },
      timeouts: {
        childStartupMs: 1_000,
        initializationMs: 1_000,
        modelSchemaMs: 1_000,
        turnMs: 5_000,
        shutdownMs: 1_000,
      },
    };
    const base = fixture("runnable");
    const manualFixture = {
      ...base,
      name: "manual-pre-poll",
      behavior: { ...base.behavior, claimOutcome: "unclaimed" as const },
    };
    let claimCalls = 0;
    const service = await startFactoryService(
      config,
      fixtureDependencies(config, manualFixture, {
        onClaim: () => claimCalls++,
      }),
    );
    stops.push(service.stop);
    const rpcUrl = `${service.url}/rpc`;
    const issue = base.state.candidates[0]!;
    const receipt = await startIssue(
      rpcUrl,
      "manual-before-poll",
      issue.repository,
      issue.number,
    );
    expect(receipt.result._tag).toBe("started");
    await waitForAssignmentState(rpcUrl, "failed");
    await delay(220);
    expect(claimCalls).toBe(1);
    expect((await listQueue(rpcUrl, { limit: 10 })).items).toEqual([]);

    await service.stop();
    stops.pop();
    const database = new DatabaseSync(config.databasePath);
    expect(
      database.prepare("SELECT count(*) AS count FROM assignments").get(),
    ).toEqual({ count: 1 });
    database.close();
  });

  test("dispatches a new tenure after fresh validation recovers", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-rpc-stale-recovery-"));
    roots.push(root);
    const config: FactoryConfig = {
      repositories: [
        {
          repository: "factory/fixture",
          codex: { model: "gpt-5.6-luna", reasoningEffort: "low" },
        },
      ],
      databasePath: join(root, "factory.db"),
      workspaceRoot: join(root, "workspaces"),
      bindHost: "127.0.0.1",
      port: 0,
      pollIntervalMs: 40,
      codex: { model: "gpt-5.6-luna", reasoningEffort: "low", slots: 1 },
      timeouts: {
        childStartupMs: 1_000,
        initializationMs: 1_000,
        modelSchemaMs: 1_000,
        turnMs: 5_000,
        shutdownMs: 1_000,
      },
    };
    let rejectNextValidation = true;
    const completion = gate();
    const calls = { claim: 0, workspace: 0, provider: 0 };
    const service = await startFactoryService(
      config,
      fixtureDependencies(config, fixture("runnable"), {
        revalidateFailure: () => {
          if (!rejectNextValidation) return null;
          rejectNextValidation = false;
          return "The queued workflow revision is stale";
        },
        beforeCompletion: () => completion.wait(),
        onClaim: () => calls.claim++,
        onWorkspace: () => calls.workspace++,
        onProviderRun: () => calls.provider++,
      }),
    );
    stops.push(service.stop);
    const rpcUrl = `${service.url}/rpc`;
    await waitForAssignmentState(rpcUrl, "running");
    expect(calls).toEqual({ claim: 1, workspace: 1, provider: 1 });
    const database = new DatabaseSync(config.databasePath);
    expect(
      database.prepare("SELECT count(*) AS count FROM queue_tenures").get(),
    ).toEqual({ count: 2 });
    database.close();
    completion.release();
  });

  test("preserves queue tenure across an operational validation failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-rpc-validation-retry-"));
    roots.push(root);
    const config: FactoryConfig = {
      repositories: [
        {
          repository: "factory/fixture",
          codex: { model: "gpt-5.6-luna", reasoningEffort: "low" },
        },
      ],
      databasePath: join(root, "factory.db"),
      workspaceRoot: join(root, "workspaces"),
      bindHost: "127.0.0.1",
      port: 0,
      pollIntervalMs: 40,
      codex: { model: "gpt-5.6-luna", reasoningEffort: "low", slots: 1 },
      timeouts: {
        childStartupMs: 1_000,
        initializationMs: 1_000,
        modelSchemaMs: 1_000,
        turnMs: 5_000,
        shutdownMs: 1_000,
      },
    };
    let validationUnavailable = true;
    const completion = gate();
    const calls = { revalidate: 0, claim: 0, workspace: 0, provider: 0 };
    const service = await startFactoryService(
      config,
      fixtureDependencies(config, fixture("runnable"), {
        revalidateFailure: () =>
          validationUnavailable ? "GitHub validation is unavailable" : null,
        revalidateFailureCode: "github_discovery_failed",
        beforeCompletion: () => completion.wait(),
        onRevalidate: () => calls.revalidate++,
        onClaim: () => calls.claim++,
        onWorkspace: () => calls.workspace++,
        onProviderRun: () => calls.provider++,
      }),
    );
    stops.push(service.stop);
    const rpcUrl = `${service.url}/rpc`;
    const deadline = Date.now() + 3_000;
    while (calls.revalidate === 0 && Date.now() < deadline) await delay(20);
    expect(calls.revalidate).toBeGreaterThan(0);
    await setDispatchPaused(rpcUrl, true);
    const first = await listQueue(rpcUrl, { limit: 10 });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({ startable: true, reason: null });
    expect(calls).toMatchObject({ claim: 0, workspace: 0, provider: 0 });

    await delay(100);
    const second = await listQueue(rpcUrl, { limit: 10 });
    expect(second.items[0]?.tenureId).toBe(first.items[0]?.tenureId);
    expect(second.items[0]?.eligibleSince).toBe(first.items[0]?.eligibleSince);
    expect(calls).toMatchObject({ claim: 0, workspace: 0, provider: 0 });

    validationUnavailable = false;
    await setDispatchPaused(rpcUrl, false);
    await waitForAssignmentState(rpcUrl, "running");
    expect(calls).toMatchObject({ claim: 1, workspace: 1, provider: 1 });
    completion.release();
  });

  test("exposes durable dispatch controls and stable queue pages", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-rpc-controls-"));
    roots.push(root);
    const config: FactoryConfig = {
      repositories: [
        {
          repository: "factory/fixture",
          codex: { model: "gpt-5.6-luna", reasoningEffort: "low" },
        },
      ],
      databasePath: join(root, "factory.db"),
      workspaceRoot: join(root, "workspaces"),
      bindHost: "127.0.0.1",
      port: 0,
      pollIntervalMs: 30_000,
      codex: { model: "gpt-5.6-luna", reasoningEffort: "low", slots: 1 },
      timeouts: {
        childStartupMs: 1_000,
        initializationMs: 1_000,
        modelSchemaMs: 1_000,
        turnMs: 5_000,
        shutdownMs: 1_000,
      },
    };
    const base = fixture("empty");
    const queuedFixture = {
      ...base,
      name: "queued-controls",
      state: {
        ...base.state,
        candidates: [fixtureIssue(41), fixtureIssue(42), fixtureIssue(43)],
        queue: {
          candidates: [fixtureIssue(41), fixtureIssue(42), fixtureIssue(43)],
        },
      },
    };
    const seed = openStateStore(config.databasePath);
    await Effect.runPromise(
      seedFixture(queuedFixture).pipe(
        Effect.provideService(StateStore, seed.service),
      ),
    );
    seed.close();
    const service = await startFactoryService(
      config,
      fixtureDependencies(config, queuedFixture),
    );
    stops.push(service.stop);
    const rpcUrl = `${service.url}/rpc`;
    expect(await setDispatchPaused(rpcUrl, true)).toMatchObject({
      paused: true,
      codexEnabled: true,
    });
    await expect(
      startIssue(rpcUrl, "paused-start", "factory/fixture", 41),
    ).rejects.toThrow("dispatch_paused: Dispatch is paused");
    expect(await setCodexEnabled(rpcUrl, false)).toMatchObject({
      paused: true,
      codexEnabled: false,
    });
    await setDispatchPaused(rpcUrl, false);
    await expect(
      startIssue(rpcUrl, "disabled-start", "factory/fixture", 41),
    ).rejects.toThrow("codex_disabled: Codex is disabled");
    expect((await getFactorySnapshot(rpcUrl)).assignment).toBeNull();
    const first = await listQueue(rpcUrl, { limit: 1 });
    const second = await listQueue(rpcUrl, {
      limit: 2,
      cursor: first.nextCursor!,
      watermark: first.watermark,
    });
    expect(first.items.map(({ issue }) => issue.number)).toEqual([41]);
    expect(second.items.map(({ issue }) => issue.number)).toEqual([42, 43]);
  });

  test("manual start consumes an existing queue tenure during admission", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-rpc-manual-queue-"));
    roots.push(root);
    const config: FactoryConfig = {
      repositories: [
        {
          repository: "factory/fixture",
          codex: { model: "gpt-5.6-luna", reasoningEffort: "low" },
        },
      ],
      databasePath: join(root, "factory.db"),
      workspaceRoot: join(root, "workspaces"),
      bindHost: "127.0.0.1",
      port: 0,
      pollIntervalMs: 30_000,
      codex: { model: "gpt-5.6-luna", reasoningEffort: "low", slots: 1 },
      timeouts: {
        childStartupMs: 1_000,
        initializationMs: 1_000,
        modelSchemaMs: 1_000,
        turnMs: 5_000,
        shutdownMs: 1_000,
      },
    };
    const issue = fixtureIssue(51);
    const base = fixture("runnable");
    const queuedFixture = {
      ...base,
      name: "manual-queue",
      state: {
        ...base.state,
        candidates: [issue],
        queue: { candidates: [issue] },
      },
    };
    const seed = openStateStore(config.databasePath);
    await Effect.runPromise(
      seedFixture(queuedFixture).pipe(
        Effect.provideService(StateStore, seed.service),
      ),
    );
    seed.close();
    const beforeRunning = gate();
    const service = await startFactoryService(
      config,
      fixtureDependencies(config, queuedFixture, {
        beforeRunning: beforeRunning.wait,
        hideClaimedCandidates: true,
      }),
    );
    stops.push(service.stop);
    const rpcUrl = `${service.url}/rpc`;
    const receipt = await startIssue(
      rpcUrl,
      "manual-queue-start",
      issue.repository,
      issue.number,
    );
    expect(receipt.result._tag).toBe("started");
    expect((await listQueue(rpcUrl, { limit: 10 })).items).toEqual([]);
    beforeRunning.release();
  });
});
