import { afterEach, describe, expect, test } from "vite-plus/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import {
  SCENARIOS,
  seedScenario,
  StateStore,
  type ScenarioName,
} from "@irudd-factory/application";
import { openStateStore } from "@irudd-factory/state-sqlite";
import { Effect } from "effect";
import {
  getFactorySnapshot,
  runNextEligibleIssue,
} from "../../cli/src/client.ts";
import { fixtureDependencies } from "../src/fixtures.ts";
import { startFactoryService } from "../src/service.ts";
import type { FactoryConfig } from "../src/config.ts";

const roots: string[] = [];
const stops: Array<() => Promise<void>> = [];
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

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no TCP port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
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
  state: "reserved" | "starting" | "running" | "completed" | "failed",
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
  test("takes one fake issue through a durable completed pull request", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-rpc-test-"));
    roots.push(root);
    const config: FactoryConfig = {
      repository: "factory/fixture",
      databasePath: join(root, "factory.db"),
      workspaceRoot: join(root, "workspaces"),
      bindHost: "127.0.0.1",
      port: await availablePort(),
      codex: { model: "gpt-5.6-luna", reasoningEffort: "low" },
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
      fixtureDependencies(config, "runnable", {
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
      repository: "factory/fixture",
      databasePath: join(root, "factory.db"),
      workspaceRoot: join(root, "workspaces"),
      bindHost: "127.0.0.1",
      port: await availablePort(),
      codex: { model: "gpt-5.6-luna", reasoningEffort: "low" },
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
      fixtureDependencies(config, "runnable", {
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
      repository: "factory/fixture",
      databasePath: join(root, "factory.db"),
      workspaceRoot: join(root, "workspaces"),
      bindHost: "127.0.0.1",
      port: await availablePort(),
      codex: { model: "gpt-5.6-luna", reasoningEffort: "low" },
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
      fixtureDependencies(config, "runnable", {
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
      repository: "factory/fixture",
      databasePath: join(root, "factory.db"),
      workspaceRoot: join(root, "workspaces"),
      bindHost: "127.0.0.1",
      port: await availablePort(),
      codex: { model: "gpt-5.6-luna", reasoningEffort: "low" },
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
      fixtureDependencies(config, "runnable", {
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
    for (const [scenarioName, expected] of [
      ["empty", "no_candidate"],
      ["ambiguous", "selection_ambiguous"],
      ["busy-reserved", "provider_busy"],
    ] as const) {
      const root = await mkdtemp(
        join(tmpdir(), `factory-rpc-${scenarioName}-`),
      );
      roots.push(root);
      const config: FactoryConfig = {
        repository: "factory/fixture",
        databasePath: join(root, "factory.db"),
        workspaceRoot: join(root, "workspaces"),
        bindHost: "127.0.0.1",
        port: await availablePort(),
        codex: { model: "gpt-5.6-luna", reasoningEffort: "low" },
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
        seedScenario(SCENARIOS[scenarioName as ScenarioName]).pipe(
          Effect.provideService(StateStore, store.service),
        ),
      );
      store.close();
      const service = await startFactoryService(
        config,
        fixtureDependencies(config, scenarioName as ScenarioName),
      );
      const rpcUrl = `${service.url}/rpc`;
      await waitForRpc(rpcUrl);
      const receipt = await runNextEligibleIssue(
        rpcUrl,
        `command-${scenarioName}`,
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
});
