import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "@effect/platform";
import { RpcClient, RpcSerialization } from "@effect/rpc";
import { StateStore } from "@irudd-factory/application";
import { FactoryRpcs } from "@irudd-factory/contracts";
import { openStateStore } from "@irudd-factory/state-sqlite";
import { Effect, Layer } from "effect";
import {
  getFactorySnapshot,
  listQueue,
  readAttempts,
  readAttempt,
  readEvents,
  readIssues,
  readTimeline,
  readTranscript,
  readUsage,
  runNextEligibleIssue,
  setCodexEnabled,
  setDispatchPaused,
  startIssue,
  controlAttempt,
  readLifecycleCommands,
} from "../../cli/src/client.ts";
import { fixtureIssue } from "../fixtures/factories.ts";
import { fixtureDependencies, seedFixture } from "../fixtures/composition.ts";
import { getFixture, type FixtureName } from "../fixtures/registry.ts";
import {
  type FactoryDependencies,
  startFactoryService,
} from "../src/service.ts";
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

function serviceConfig(
  root: string,
  access: FactoryConfig["access"] = { mode: "local" },
): FactoryConfig {
  return {
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
    access,
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
}

function getSnapshotWithHeaders(
  url: string,
  headers: Readonly<Record<string, string>>,
) {
  const Protocol = RpcClient.layerProtocolHttp({
    url,
    transformClient: (client) =>
      HttpClient.mapRequest(client, HttpClientRequest.setHeaders(headers)),
  }).pipe(Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]));
  return Effect.gen(function* () {
    const client = yield* RpcClient.make(FactoryRpcs);
    return yield* client.GetFactorySnapshot();
  }).pipe(Effect.scoped, Effect.provide(Protocol), Effect.runPromise);
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
  test("allows same-origin local requests and rejects foreign browser origins", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-local-access-"));
    roots.push(root);
    const config = serviceConfig(root);
    const service = await startFactoryService(
      config,
      fixtureDependencies(config, fixture("empty")),
      await makeConsoleDist(root),
    );
    stops.push(service.stop);

    await expect(
      fetch(service.url, { headers: { Origin: service.url } }).then(
        (response) => response.status,
      ),
    ).resolves.toBe(200);
    const foreign = await fetch(service.url, {
      headers: { Origin: "https://foreign.example" },
    });
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get("x-factory-access-decision")).toBe(
      "origin_rejected",
    );
    await expect(
      getFactorySnapshot(`${service.url}/rpc`),
    ).resolves.toMatchObject({ assignment: null });
  });

  test("separates authenticated Tailscale access from the local CLI listener", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-tailscale-access-"));
    roots.push(root);
    const access = {
      mode: "tailscale" as const,
      operatorLogin: "operator@example.com",
      localCliPort: 0,
    };
    const config = serviceConfig(root, access);
    const service = await startFactoryService(
      config,
      fixtureDependencies(config, fixture("empty")),
      await makeConsoleDist(root),
    );
    stops.push(service.stop);
    expect(service.localCliUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const host = "factory.tailnet.ts.net";
    const main = await fetch(service.url, {
      headers: {
        Host: host,
        "Tailscale-User-Login": "operator@example.com",
      },
    });
    expect(main.status).toBe(200);
    await expect(
      getSnapshotWithHeaders(`${service.url}/rpc`, {
        Origin: service.url.replace("http://", "https://"),
        "Tailscale-User-Login": "operator@example.com",
      }),
    ).resolves.toMatchObject({ assignment: null });
    await expect(
      getFactorySnapshot(`${service.url}/rpc`),
    ).rejects.toBeDefined();

    const localCliUrl = service.localCliUrl!;
    expect(
      (
        await fetch(`${localCliUrl}/rpc`, {
          method: "POST",
          body: "[]",
        })
      ).status,
    ).not.toBe(403);
    await expect(
      getFactorySnapshot(`${localCliUrl}/rpc`),
    ).resolves.toMatchObject({ assignment: null });
    expect((await fetch(localCliUrl)).status).toBe(403);
    expect(
      (
        await fetch(`${localCliUrl}/rpc`, {
          headers: { Origin: "https://factory.tailnet.ts.net" },
        })
      ).status,
    ).toBe(403);
  });

  test("keeps the configured operator login out of denials, logs, events, and storage", async () => {
    const operatorLogin = "private-operator@example.com";
    const logged: unknown[] = [];
    const spies = [
      vi.spyOn(console, "debug").mockImplementation((...args) => {
        logged.push(args);
      }),
      vi.spyOn(console, "error").mockImplementation((...args) => {
        logged.push(args);
      }),
      vi.spyOn(console, "info").mockImplementation((...args) => {
        logged.push(args);
      }),
      vi.spyOn(console, "log").mockImplementation((...args) => {
        logged.push(args);
      }),
      vi.spyOn(console, "warn").mockImplementation((...args) => {
        logged.push(args);
      }),
    ];
    const root = await mkdtemp(join(tmpdir(), "factory-identity-redaction-"));
    roots.push(root);
    const config = serviceConfig(root, {
      mode: "tailscale",
      operatorLogin,
      localCliPort: 0,
    });
    const service = await startFactoryService(
      config,
      fixtureDependencies(config, fixture("empty")),
      await makeConsoleDist(root),
    );
    try {
      const denial = await fetch(service.url, {
        headers: {
          Host: "factory.tailnet.ts.net",
          Origin: "https://foreign.tailnet.ts.net",
          "Tailscale-User-Login": operatorLogin,
        },
      });
      const denialEvidence = JSON.stringify({
        status: denial.status,
        headers: Object.fromEntries(denial.headers),
        body: await denial.text(),
      });
      const snapshot = await getFactorySnapshot(`${service.localCliUrl!}/rpc`);
      expect(denial.status).toBe(403);
      expect(denialEvidence).not.toContain(operatorLogin);
      expect(JSON.stringify(snapshot)).not.toContain(operatorLogin);
    } finally {
      await service.stop();
      spies.forEach((spy) => spy.mockRestore());
    }
    expect(JSON.stringify(logged)).not.toContain(operatorLogin);
    expect((await readFile(config.databasePath)).includes(operatorLogin)).toBe(
      false,
    );
  });

  test("closes the main listener when the local CLI listener cannot bind", async () => {
    const occupied = createNetServer();
    await new Promise<void>((resolveListen) =>
      occupied.listen(0, "127.0.0.1", resolveListen),
    );
    const occupiedAddress = occupied.address();
    if (!occupiedAddress || typeof occupiedAddress === "string") {
      throw new Error("no TCP port");
    }
    const root = await mkdtemp(join(tmpdir(), "factory-atomic-listeners-"));
    roots.push(root);
    const config = serviceConfig(root, {
      mode: "tailscale",
      operatorLogin: "operator@example.com",
      localCliPort: occupiedAddress.port,
    });
    const mainServer = createHttpServer();
    try {
      await expect(
        startFactoryService(
          config,
          fixtureDependencies(config, fixture("empty")),
          await makeConsoleDist(root),
          mainServer,
        ),
      ).rejects.toThrow("listener failed to start");
      expect(mainServer.listening).toBe(false);
    } finally {
      await new Promise<void>((resolveClose, rejectClose) =>
        occupied.close((error) =>
          error ? rejectClose(error) : resolveClose(),
        ),
      );
    }
  });

  test("closes the local CLI listener when the main listener cannot bind", async () => {
    const occupied = createNetServer();
    await new Promise<void>((resolveListen) =>
      occupied.listen(0, "127.0.0.1", resolveListen),
    );
    const occupiedAddress = occupied.address();
    if (!occupiedAddress || typeof occupiedAddress === "string") {
      throw new Error("no TCP port");
    }
    const root = await mkdtemp(join(tmpdir(), "factory-atomic-main-"));
    roots.push(root);
    const config = {
      ...serviceConfig(root, {
        mode: "tailscale",
        operatorLogin: "operator@example.com",
        localCliPort: 0,
      }),
      port: occupiedAddress.port,
    };
    const localCliServer = createHttpServer();
    try {
      await expect(
        startFactoryService(
          config,
          fixtureDependencies(config, fixture("empty")),
          await makeConsoleDist(root),
          createHttpServer(),
          localCliServer,
        ),
      ).rejects.toThrow("listener failed to start");
      expect(localCliServer.listening).toBe(false);
    } finally {
      await new Promise<void>((resolveClose, rejectClose) =>
        occupied.close((error) =>
          error ? rejectClose(error) : resolveClose(),
        ),
      );
    }
  });

  test("opens neither listener when dependency initialization fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-atomic-init-"));
    roots.push(root);
    const config = serviceConfig(root, {
      mode: "tailscale",
      operatorLogin: "operator@example.com",
      localCliPort: 0,
    });
    const mainServer = createHttpServer();
    const localCliServer = createHttpServer();
    await expect(
      startFactoryService(
        config,
        Layer.fail("planned initialization failure") as FactoryDependencies,
        await makeConsoleDist(root),
        mainServer,
        localCliServer,
      ),
    ).rejects.toThrow("listener initialization");
    expect(mainServer.listening).toBe(false);
    expect(localCliServer.listening).toBe(false);
  });

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
        providerRecordsBeforeCompletion: [
          {
            kind: "transcript",
            timestamp: "2026-01-15T12:00:01.000Z",
            text: "Durable text observed before interruption.",
          },
          {
            kind: "usage",
            timestamp: "2026-01-15T12:00:02.000Z",
            usage: {
              total: {
                inputTokens: 10,
                cachedInputTokens: 1,
                outputTokens: 5,
                reasoningOutputTokens: 2,
                totalTokens: 15,
              },
              last: {
                inputTokens: 10,
                cachedInputTokens: 1,
                outputTokens: 5,
                reasoningOutputTokens: 2,
                totalTokens: 15,
              },
              modelContextWindow: null,
            },
          },
        ],
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
    const retained = openStateStore(config.databasePath);
    const transcript = await Effect.runPromise(
      retained.service.readTranscript("assignment-runnable-1", {}),
    );
    const usage = await Effect.runPromise(retained.service.readUsage({}));
    expect(transcript.items[0]?.text).toBe(
      "Durable text observed before interruption.",
    );
    expect(usage.items[0]?.total.totalTokens).toBe(15);
    retained.close();
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

  test("serves bounded retained history pages over RPC", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-rpc-history-"));
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
    const definition = fixture("retained-history");
    const store = openStateStore(config.databasePath, config.retention);
    await Effect.runPromise(
      seedFixture(definition).pipe(
        Effect.provideService(StateStore, store.service),
      ),
    );
    const interrupted = definition.state.history?.find(
      ({ assignment }) => assignment.id === "attempt-history-interrupted",
    )?.assignment;
    if (!interrupted?.workspace)
      throw new Error("History fixture lacks its interrupted workspace");
    await Effect.runPromise(
      store.service.appendEvent(interrupted.id, {
        type: "pull_request.lookup_started",
        timestamp: "2026-01-13T12:11:00.000Z",
        detail: {},
      }),
    );
    await Effect.runPromise(
      store.service.seedAssignment(
        {
          ...interrupted,
          id: "attempt-history-lookup",
          workspace: {
            ...interrupted.workspace,
            branch: "factory/attempt-history-lookup",
          },
          createdAt: "2026-01-13T13:00:00.000Z",
          updatedAt: "2026-01-13T13:10:00.000Z",
        },
        [
          {
            assignmentId: "attempt-history-lookup",
            type: "assignment.interrupted",
            timestamp: "2026-01-13T13:10:00.000Z",
            detail: { processReconciliation: "exited" },
          },
        ],
      ),
    );
    store.close();
    let pullRequestLookups = 0;
    const controls = {
      onPullRequestLookup: () => {
        pullRequestLookups += 1;
      },
    };
    const service = await startFactoryService(
      config,
      fixtureDependencies(config, definition, controls),
    );
    const rpcUrl = `${service.url}/rpc`;
    await waitForRpc(rpcUrl);

    const first = await readAttempts(rpcUrl, { limit: 2 });
    const second = await readAttempts(rpcUrl, {
      limit: 2,
      cursor: first.nextCursor ?? 0,
      watermark: first.watermark,
    });
    expect([...first.items, ...second.items]).toHaveLength(4);
    expect((await readIssues(rpcUrl)).items).toHaveLength(1);
    expect((await readTimeline(rpcUrl)).items).toHaveLength(4);
    expect((await readUsage(rpcUrl)).items).toHaveLength(1);
    const transcript = await readTranscript(rpcUrl, "attempt-history-failed");
    expect(transcript.items[0]?.truncated).toBe(true);
    expect(transcript.items[0]?.text).not.toContain("fixture-secret-123");
    expect(
      (await readEvents(rpcUrl, "attempt-history-failed")).items.length,
    ).toBeGreaterThan(1);
    expect(pullRequestLookups).toBe(1);
    await service.stop();
    const restarted = await startFactoryService(
      config,
      fixtureDependencies(config, definition, controls),
    );
    await waitForRpc(`${restarted.url}/rpc`);
    expect(pullRequestLookups).toBe(1);
    await restarted.stop();
  });

  test("controls retained attempts and preserves sibling history", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-rpc-lifecycle-"));
    roots.push(root);
    const config = serviceConfig(root);
    const definition = fixture("retained-history");
    const store = openStateStore(config.databasePath);
    await Effect.runPromise(
      seedFixture(definition).pipe(
        Effect.provideService(StateStore, store.service),
      ),
    );
    store.close();
    const service = await startFactoryService(
      config,
      fixtureDependencies(config, definition, { pullRequestLookup: null }),
    );
    stops.push(service.stop);
    const rpcUrl = `${service.url}/rpc`;
    await waitForRpc(rpcUrl);
    const initial = await readAttempts(rpcUrl);
    const interrupted = initial.items.find(
      ({ id }) => id === "attempt-history-interrupted",
    )!;
    const restarted = await controlAttempt(rpcUrl, {
      commandId: "restart-history",
      kind: "restart",
      attemptId: interrupted.id,
      expectedTargetVersion: interrupted.lastEventSequence,
    });
    expect(restarted.consequence).toEqual({
      _tag: "restarted",
      siblingAttemptId: expect.any(String),
    });
    if (restarted.consequence?._tag !== "restarted") {
      throw new Error("Restart did not produce a sibling attempt");
    }
    expect(restarted.consequence.siblingAttemptId).not.toBe(interrupted.id);
    expect(
      (await readAttempts(rpcUrl)).items.some(
        ({ id }) => id === interrupted.id,
      ),
    ).toBe(true);

    const failed = (await readAttempts(rpcUrl)).items.find(
      ({ id }) => id === "attempt-history-failed",
    )!;
    const returned = await controlAttempt(rpcUrl, {
      commandId: "return-history",
      kind: "return",
      attemptId: failed.id,
      expectedTargetVersion: failed.lastEventSequence,
    });
    expect(returned).toMatchObject({
      phase: "final",
      consequence: { _tag: "returned", claimedRemoved: true },
    });
    const replay = await controlAttempt(rpcUrl, {
      commandId: "return-history",
      kind: "archive",
      attemptId: failed.id,
      expectedTargetVersion: 999,
    });
    expect(replay).toEqual(returned);

    const completed = (await readAttempts(rpcUrl)).items.find(
      ({ id }) => id === "attempt-history-completed",
    )!;
    const archived = await controlAttempt(rpcUrl, {
      commandId: "archive-history",
      kind: "archive",
      attemptId: completed.id,
      expectedTargetVersion: completed.lastEventSequence,
    });
    expect(archived.consequence?._tag).toBe("archived");
    expect(
      (await readAttempts(rpcUrl)).items.some(({ id }) => id === completed.id),
    ).toBe(false);
    const restored = await controlAttempt(rpcUrl, {
      commandId: "restore-history",
      kind: "restore",
      attemptId: completed.id,
      expectedTargetVersion: (await readAttempt(rpcUrl, completed.id))!
        .lastEventSequence,
    });
    expect(restored.consequence?._tag).toBe("restored");
    expect(
      (await readAttempts(rpcUrl)).items.some(({ id }) => id === completed.id),
    ).toBe(true);
    expect((await readLifecycleCommands(rpcUrl)).items).toHaveLength(4);
  });

  test("keeps claimed when GitHub reports a pull request missing from local state", async () => {
    for (const targetState of ["failed", "stopped"] as const) {
      const root = await mkdtemp(join(tmpdir(), "factory-rpc-return-pr-"));
      roots.push(root);
      const config = serviceConfig(root);
      const definition = fixture("failed-long");
      const store = openStateStore(config.databasePath);
      await Effect.runPromise(
        seedFixture(definition).pipe(
          Effect.provideService(StateStore, store.service),
        ),
      );
      let attempt = (await Effect.runPromise(
        store.service.getAssignment("assignment-failed"),
      ))!;
      if (targetState === "stopped") {
        attempt = await Effect.runPromise(
          store.service.appendEvent(
            attempt.id,
            {
              type: "attempt.stopped",
              timestamp: "2026-01-15T12:00:30.000Z",
              detail: { processResult: "exited" },
            },
            { state: "stopped" },
          ),
        );
      }
      store.close();
      let removeCalls = 0;
      const service = await startFactoryService(
        config,
        fixtureDependencies(config, definition, {
          pullRequestLookup: {
            url: "https://github.com/factory/fixture/pull/99",
            number: 99,
            draft: false,
          },
          onRemoveClaim: () => {
            removeCalls += 1;
          },
        }),
      );
      const rpcUrl = `${service.url}/rpc`;
      await waitForRpc(rpcUrl);
      const result = await controlAttempt(rpcUrl, {
        commandId: `return-with-pr-${targetState}`,
        kind: "return",
        attemptId: attempt.id,
        expectedTargetVersion: attempt.lastEventSequence,
      });
      expect(result.consequence).toMatchObject({
        _tag: "rejected",
        code: "pull_request_present",
      });
      expect(removeCalls).toBe(0);
      await service.stop();
    }
  });

  test("stops an active provider and confirms capacity release", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-rpc-stop-"));
    roots.push(root);
    const config = serviceConfig(root);
    const completion = gate();
    let interrupted = false;
    const definition = fixture("runnable");
    const service = await startFactoryService(
      config,
      fixtureDependencies(config, definition, {
        beforeCompletion: completion.wait,
        onProviderInterrupted: () => {
          interrupted = true;
        },
      }),
    );
    stops.push(service.stop);
    const rpcUrl = `${service.url}/rpc`;
    await waitForRpc(rpcUrl);
    const receipt = await startIssue(
      rpcUrl,
      "start-for-stop",
      "factory/fixture",
      definition.state.candidates[0]!.number,
    );
    if (receipt.result._tag !== "started") {
      throw new Error("Fixture attempt did not start");
    }
    const running = await waitForAssignmentState(rpcUrl, "running");
    const stopped = await controlAttempt(rpcUrl, {
      commandId: "stop-running",
      kind: "stop",
      attemptId: receipt.result.assignment.id,
      expectedTargetVersion: running.assignment!.lastEventSequence,
    });
    expect(interrupted).toBe(true);
    expect(stopped).toMatchObject({
      phase: "final",
      consequence: { _tag: "stopped", processResult: "exited" },
    });
    expect((await getFactorySnapshot(rpcUrl)).assignment?.state).toBe(
      "stopped",
    );
  });

  test("reconciles every lifecycle effect checkpoint after restart", async () => {
    const recover = async (input: {
      fixtureName: FixtureName;
      attemptId: string;
      kind: "stop" | "return" | "restart" | "archive" | "restore";
      effect: string;
      beforeAdmission?: (
        store: ReturnType<typeof openStateStore>,
        attemptId: string,
      ) => Promise<void>;
      afterEffect?: (
        store: ReturnType<typeof openStateStore>,
        attemptId: string,
      ) => Promise<void>;
      claimInitiallyRemoved?: boolean;
    }) => {
      const root = await mkdtemp(join(tmpdir(), "factory-rpc-recovery-"));
      roots.push(root);
      const config = serviceConfig(root);
      const definition = fixture(input.fixtureName);
      const store = openStateStore(config.databasePath);
      await Effect.runPromise(
        seedFixture(definition).pipe(
          Effect.provideService(StateStore, store.service),
        ),
      );
      await input.beforeAdmission?.(store, input.attemptId);
      const attempt = (await Effect.runPromise(
        store.service.getAssignment(input.attemptId),
      ))!;
      await Effect.runPromise(
        store.service.beginLifecycleCommand({
          commandId: `recover-${input.kind}-${input.effect}`,
          kind: input.kind,
          targetAttemptId: input.attemptId,
          expectedTargetVersion: attempt.lastEventSequence,
          repositoryConfigured: true,
          timestamp: "2026-01-15T12:01:00.000Z",
        }),
      );
      if (input.effect !== "admitted") {
        await Effect.runPromise(
          store.service.markLifecycleCommandExecuting(
            `recover-${input.kind}-${input.effect}`,
            input.effect,
            "2026-01-15T12:02:00.000Z",
          ),
        );
      }
      await input.afterEffect?.(store, input.attemptId);
      store.close();
      let removeCalls = 0;
      let workspaceCalls = 0;
      let pullRequestLookups = 0;
      const service = await startFactoryService(
        config,
        fixtureDependencies(config, definition, {
          pullRequestLookup: null,
          ...(input.claimInitiallyRemoved === undefined
            ? {}
            : { claimInitiallyRemoved: input.claimInitiallyRemoved }),
          onRemoveClaim: () => {
            removeCalls += 1;
          },
          onWorkspace: () => {
            workspaceCalls += 1;
          },
          onPullRequestLookup: () => {
            pullRequestLookups += 1;
          },
        }),
      );
      const rpcUrl = `${service.url}/rpc`;
      await waitForRpc(rpcUrl);
      const command = (await readLifecycleCommands(rpcUrl)).items.find(
        ({ commandId }) =>
          commandId === `recover-${input.kind}-${input.effect}`,
      )!;
      let sibling = null;
      if (command.consequence?._tag === "restarted") {
        const deadline = Date.now() + 3_000;
        do {
          sibling = await readAttempt(
            rpcUrl,
            command.consequence.siblingAttemptId,
          );
          if (sibling?.workspace) break;
          await delay(20);
        } while (Date.now() < deadline);
      }
      await service.stop();
      return {
        command,
        removeCalls,
        workspaceCalls,
        pullRequestLookups,
        sibling,
      };
    };

    for (const effect of [
      "admitted",
      "process_interrupting",
      "process_resolved:exited",
    ]) {
      const { command } = await recover({
        fixtureName: "busy-reserved",
        attemptId: "assignment-reserved",
        kind: "stop",
        effect,
      });
      expect(command.consequence?._tag).toBe("stopped");
    }

    for (const effect of [
      "admitted",
      "pull_request_inspecting",
      "pull_request_absent",
      "label_removing",
      "label_removed",
    ]) {
      const labelMutationStarted =
        effect === "label_removing" || effect === "label_removed";
      const { command, removeCalls, pullRequestLookups } = await recover({
        fixtureName: "failed-long",
        attemptId: "assignment-failed",
        kind: "return",
        effect,
        claimInitiallyRemoved: labelMutationStarted,
      });
      expect(command.consequence?._tag).toBe("returned");
      expect(removeCalls).toBe(labelMutationStarted ? 0 : 1);
      expect(pullRequestLookups).toBe(
        effect === "admitted" || effect === "pull_request_inspecting" ? 1 : 0,
      );
    }

    for (const effect of [
      "admitted",
      "issue_revalidating",
      "issue_validated",
      "sibling_reserved",
    ]) {
      const { command, sibling, workspaceCalls } = await recover({
        fixtureName: "failed-long",
        attemptId: "assignment-failed",
        kind: "restart",
        effect,
        ...(effect === "issue_validated" || effect === "sibling_reserved"
          ? {
              afterEffect: async (store, attemptId) => {
                const attempt = (await Effect.runPromise(
                  store.service.getAssignment(attemptId),
                ))!;
                await Effect.runPromise(
                  store.service.admit({
                    commandId: `lifecycle:recover-restart-${effect}`,
                    provider: "codex",
                    candidates: [
                      {
                        issue: attempt.issue,
                        workflow: attempt.workflow,
                        requestedModel: "gpt-5.6-luna",
                        requestedEffort: "low",
                      },
                    ],
                    assignmentId: "recovered-sibling",
                    timestamp: "2026-01-15T12:02:30.000Z",
                    slots: 1,
                    allowRetry: true,
                  }),
                );
              },
            }
          : {}),
      });
      expect(command.consequence?._tag).toBe("restarted");
      expect(sibling?.workspace?.branch).toContain(
        sibling?.id ?? "__missing__",
      );
      expect(workspaceCalls).toBe(1);
    }

    for (const effect of ["admitted", "visibility_updating"]) {
      const archived = await recover({
        fixtureName: "completed-ready",
        attemptId: "assignment-completed",
        kind: "archive",
        effect,
      });
      expect(archived.command.consequence?._tag).toBe("archived");
    }

    const archivedBeforeRestore = async (
      store: ReturnType<typeof openStateStore>,
      attemptId: string,
    ) => {
      await Effect.runPromise(
        store.service.appendEvent(
          attemptId,
          {
            type: "attempt.archived",
            timestamp: "2026-01-15T12:00:30.000Z",
            detail: { commandId: "setup-archive" },
          },
          { archivedAt: "2026-01-15T12:00:30.000Z" },
        ),
      );
    };
    for (const effect of ["admitted", "visibility_updating"]) {
      const restored = await recover({
        fixtureName: "completed-ready",
        attemptId: "assignment-completed",
        kind: "restore",
        effect,
        beforeAdmission: archivedBeforeRestore,
      });
      expect(restored.command.consequence?._tag).toBe("restored");
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
