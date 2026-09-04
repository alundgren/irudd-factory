// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  Assignment,
  Attempt,
  FactorySnapshot,
  LifecycleCommand,
  QueuePage,
} from "@irudd-factory/contracts";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vite-plus/test";

vi.mock("../src/client.ts", () => ({
  controlAttempt: vi.fn(),
  listQueue: vi.fn(),
  listAttempts: vi.fn(),
  loadAttempt: vi.fn(),
  loadEvents: vi.fn(),
  loadLifecycleCommands: vi.fn(),
  loadOperationsOverview: vi.fn(),
  loadSnapshot: vi.fn(),
  loadTranscript: vi.fn(),
  loadUsage: vi.fn(),
  setCodexEnabled: vi.fn(),
  setDispatchPaused: vi.fn(),
  startIssue: vi.fn(),
}));

import App from "../src/App.tsx";
import * as client from "../src/client.ts";
import { ServiceRejection } from "../src/errors.ts";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const now = "2026-01-15T12:00:00.000Z";
const issue = {
  nodeId: "issue-41",
  repository: "factory/fixture",
  number: 41,
  url: "https://github.com/factory/fixture/issues/41",
  title: "A ready issue with enough title text to prove the mapped value",
};
const assignment = {
  id: "attempt-running",
  provider: "codex",
  issue,
  state: "running",
  requestedModel: "gpt-5.6-sol",
  requestedEffort: "high",
  observedModel: null,
  observedEffort: null,
  createdAt: now,
  updatedAt: now,
} as Assignment;
const retainedRunningAttempt: Attempt = {
  ...assignment,
  workflow: {
    startingCommit: "a".repeat(40),
    blobId: "b".repeat(40),
    digest: "c".repeat(64),
    body: "Fixture workflow",
  },
  workspace: null,
  codexVersion: null,
  threadId: null,
  turnId: null,
  processGroupId: null,
  processStartIdentity: null,
  processStartPending: false,
  pullRequest: null,
  error: null,
  lastEventSequence: 4,
  archivedAt: null,
};
const queue: QueuePage = {
  items: [
    {
      tenureId: "tenure-41",
      issue,
      eligibleSince: now,
      lastObservedAt: now,
      endedAt: null,
      startable: true,
      reason: null,
    },
  ],
  watermark: "queue-1",
  nextCursor: "1",
};
const snapshot = {
  receipt: null,
  assignment,
  assignments: [assignment],
  events: [],
  dispatch: { paused: false, codexEnabled: true, updatedAt: now },
  queue,
  configuration: {
    repositories: [
      {
        repository: "factory/fixture",
        codex: { model: "gpt-5.6-sol", reasoningEffort: "high" },
      },
    ],
    codexSlots: 2,
    pollIntervalMs: 30_000,
    access: "Local only",
  },
} satisfies FactorySnapshot;

function lifecycle(
  phase: LifecycleCommand["phase"],
  admission: LifecycleCommand["admission"] = {
    _tag: "accepted",
    sourceState: "running",
    sourceVersion: 1,
  },
): LifecycleCommand {
  return {
    commandId: `command-${phase}-${admission._tag}`,
    kind: "stop",
    targetAttemptId: assignment.id,
    expectedTargetVersion: 1,
    phase,
    effect: "Waiting for provider exit",
    admission,
    consequence:
      phase === "final" ? { _tag: "stopped", processResult: "exited" } : null,
    createdAt: now,
    updatedAt: now,
  };
}

let root: Root;

async function renderApp() {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<App />);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return container;
}

beforeEach(() => {
  vi.mocked(client.listAttempts).mockResolvedValue({
    items: [],
    watermark: "attempts-1",
    nextCursor: null,
  });
  vi.mocked(client.loadAttempt).mockResolvedValue(null);
  vi.mocked(client.loadEvents).mockResolvedValue({
    items: [],
    watermark: "events-1",
    nextCursor: null,
  });
  vi.mocked(client.loadLifecycleCommands).mockResolvedValue({
    items: [],
    watermark: "lifecycle-1",
    nextCursor: null,
  });
  vi.mocked(client.loadTranscript).mockResolvedValue({
    items: [],
    watermark: "transcript-1",
    nextCursor: null,
  });
  vi.mocked(client.loadUsage).mockResolvedValue({
    items: [],
    watermark: "usage-1",
    nextCursor: null,
  });
  vi.mocked(client.loadSnapshot).mockResolvedValue(snapshot);
  vi.mocked(client.loadOperationsOverview).mockResolvedValue({
    usage: [
      {
        attemptId: assignment.id,
        timestamp: now,
        total: {
          inputTokens: 80,
          cachedInputTokens: 0,
          outputTokens: 40,
          reasoningOutputTokens: 0,
          totalTokens: 120,
        },
        last: {
          inputTokens: 80,
          cachedInputTokens: 0,
          outputTokens: 40,
          reasoningOutputTokens: 0,
          totalTokens: 120,
        },
        modelContextWindow: null,
      },
    ],
    recentActivity: [assignment],
    lifecycleCommands: [
      lifecycle("accepted"),
      lifecycle("executing"),
      lifecycle("final"),
      lifecycle("final", {
        _tag: "rejected",
        code: "state_changed",
        message: "Attempt state changed",
      }),
    ],
  });
  vi.mocked(client.listQueue).mockResolvedValue(queue);
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("Operations overview", () => {
  test("renders mapped data and durable lifecycle command phases", async () => {
    const states: ReadonlyArray<Assignment["state"]> = [
      "reserved",
      "starting",
      "running",
      "completed",
      "failed",
      "interrupted",
      "stopped",
      "stop_uncertain",
      "ownership_uncertain",
    ];
    vi.mocked(client.loadOperationsOverview).mockResolvedValue({
      usage: [
        {
          attemptId: assignment.id,
          timestamp: now,
          total: {
            inputTokens: 80,
            cachedInputTokens: 0,
            outputTokens: 40,
            reasoningOutputTokens: 0,
            totalTokens: 120,
          },
          last: {
            inputTokens: 80,
            cachedInputTokens: 0,
            outputTokens: 40,
            reasoningOutputTokens: 0,
            totalTokens: 120,
          },
          modelContextWindow: null,
        },
      ],
      recentActivity: states.map((state) => ({
        ...assignment,
        id: `attempt-${state}`,
        state,
      })),
      lifecycleCommands: [
        lifecycle("accepted"),
        lifecycle("executing"),
        lifecycle("final"),
        lifecycle("final", {
          _tag: "rejected",
          code: "state_changed",
          message: "Attempt state changed",
        }),
      ],
    });
    const container = await renderApp();
    expect(container.textContent).toContain(issue.title);
    expect(container.textContent).toContain("Running");
    expect(container.textContent).toContain("gpt-5.6-sol");
    expect(container.textContent).toContain("high effort");
    expect(container.textContent).toContain("120 tokens");
    expect(container.textContent).toContain("1 of 2 slots occupied");
    expect(container.textContent).toContain("Local only");
    for (const phase of ["Accepted", "Executing", "Final", "Rejected"]) {
      expect(container.textContent).toContain(phase);
    }
    for (const state of [
      "Reserved",
      "Starting",
      "Running",
      "Completed",
      "Failed",
      "Interrupted",
      "Stopped",
      "Stop unconfirmed",
      "Process ownership uncertain",
    ]) {
      expect(container.textContent).toContain(state.toLowerCase());
    }
  });

  test("renders final service receipts and unresolved transport outcomes", async () => {
    vi.mocked(client.loadOperationsOverview).mockResolvedValue({
      usage: [],
      recentActivity: [assignment],
      lifecycleCommands: [],
    });
    vi.mocked(client.startIssue)
      .mockResolvedValueOnce({
        commandId: "start-41",
        result: { _tag: "started", assignment },
        createdAt: now,
      })
      .mockRejectedValueOnce(new TypeError("fetch failed"));
    const container = await renderApp();
    const start = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Start now",
    )!;

    await act(async () => {
      start.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).toContain("Final");
    expect(container.textContent).toContain("was reserved");

    await act(async () => {
      start.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).toContain("Transport failure");
    expect(container.textContent).toContain(
      "Check activity before starting again",
    );
  });

  test("keeps a final receipt when the following refresh fails", async () => {
    vi.mocked(client.startIssue).mockResolvedValue({
      commandId: "start-41",
      result: { _tag: "started", assignment },
      createdAt: now,
    });
    vi.mocked(client.listQueue)
      .mockResolvedValueOnce(queue)
      .mockRejectedValueOnce(new TypeError("fetch failed"));
    const container = await renderApp();
    const start = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Start now",
    )!;
    await act(async () => {
      start.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).toContain("Final");
    expect(container.textContent).toContain("was reserved");
    expect(container.textContent).not.toContain("Transport failure");
  });

  test("lets a recovered durable receipt replace an unresolved transport result", async () => {
    const commandId = "00000000-0000-4000-8000-000000000041";
    vi.spyOn(crypto, "randomUUID").mockReturnValue(commandId);
    vi.mocked(client.startIssue).mockRejectedValue(
      new TypeError("fetch failed"),
    );
    vi.mocked(client.setDispatchPaused).mockResolvedValue({
      paused: true,
      codexEnabled: true,
      updatedAt: now,
    });
    vi.mocked(client.loadSnapshot)
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce({
        ...snapshot,
        receipt: {
          commandId,
          result: { _tag: "started", assignment },
          createdAt: now,
        },
      });
    const container = await renderApp();
    const start = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Start now",
    )!;
    await act(async () => {
      start.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).toContain("Transport failure");

    const pause = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Pause",
    )!;
    await act(async () => {
      pause.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).toContain("was reserved");
    expect(container.textContent).not.toContain("Transport failure");
  });

  test("renders missing snapshot fields as unknown and disables controls", async () => {
    vi.mocked(client.loadSnapshot).mockResolvedValue({
      receipt: null,
      assignment: null,
      events: [],
    });
    const container = await renderApp();
    expect(container.textContent).toContain("Active attempts unknown");
    expect(container.textContent).toContain("Capacity unknown");
    expect(container.textContent).toContain("ProviderUnknown");
    expect(container.textContent).toContain("DispatchUnknown");
    expect(container.textContent).toContain("Codex slotsUnknown");
    const start = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Start now",
    )!;
    expect(start.disabled).toBe(true);
  });

  test("shows declared service errors as rejections", async () => {
    vi.mocked(client.startIssue).mockRejectedValue(
      new ServiceRejection(
        "repository_not_configured: Repository is not configured",
      ),
    );
    const container = await renderApp();
    const start = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Start now",
    )!;
    await act(async () => {
      start.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).toContain("Rejected");
    expect(container.textContent).toContain("repository_not_configured");
    expect(container.textContent).not.toContain("Transport failure");
  });

  test("blocks admission while dispatch is paused", async () => {
    vi.mocked(client.loadSnapshot).mockResolvedValue({
      ...snapshot,
      dispatch: { ...snapshot.dispatch, paused: true },
    });
    const container = await renderApp();
    const start = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Start now",
    )!;
    expect(start.disabled).toBe(true);
  });

  test("applies returned dispatch state when the follow-up refresh fails", async () => {
    vi.mocked(client.setDispatchPaused).mockResolvedValue({
      paused: true,
      codexEnabled: true,
      updatedAt: now,
    });
    vi.mocked(client.loadSnapshot)
      .mockResolvedValueOnce(snapshot)
      .mockRejectedValueOnce(new TypeError("fetch failed"));
    const container = await renderApp();
    const pause = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Pause",
    )!;
    await act(async () => {
      pause.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).toContain("Dispatch paused");
    expect(container.textContent).toContain("Resume");
    expect(container.textContent).toContain("Final");
  });

  test("applies returned provider state when the follow-up refresh fails", async () => {
    vi.mocked(client.loadSnapshot)
      .mockResolvedValueOnce({
        ...snapshot,
        dispatch: { ...snapshot.dispatch, codexEnabled: false },
      })
      .mockRejectedValueOnce(new TypeError("fetch failed"));
    vi.mocked(client.setCodexEnabled).mockResolvedValue({
      paused: false,
      codexEnabled: true,
      updatedAt: now,
    });
    const container = await renderApp();
    const enable = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Enable Codex",
    )!;
    await act(async () => {
      enable.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).toContain("ProviderEnabled");
    expect(container.textContent).toContain("Disable Codex");
    expect(container.textContent).toContain("Final");
  });

  test("requests and restores stable queue pages", async () => {
    const secondPage: QueuePage = {
      items: [
        {
          ...queue.items[0]!,
          tenureId: "tenure-42",
          issue: { ...issue, number: 42, title: "Second page issue" },
        },
      ],
      watermark: queue.watermark,
      nextCursor: null,
    };
    vi.mocked(client.listQueue)
      .mockResolvedValueOnce(queue)
      .mockResolvedValueOnce(secondPage);
    const container = await renderApp();
    const queuePagination = container.querySelector(
      '[aria-label="Ready queue pages"]',
    )!;
    const next = [...queuePagination.querySelectorAll("button")].find(
      (button) => button.textContent === "Next",
    )!;
    await act(async () => {
      next.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(client.listQueue).toHaveBeenLastCalledWith(6, "1", "queue-1");
    expect(container.textContent).toContain("Second page issue");
    const previous = [...queuePagination.querySelectorAll("button")].find(
      (button) => button.textContent === "Previous",
    )!;
    await act(async () => previous.click());
    expect(container.textContent).toContain(issue.title);
  });

  test("does not let a page-one refresh replace page-two queue rows", async () => {
    let finishRefresh!: (value: FactorySnapshot) => void;
    const delayedSnapshot = new Promise<FactorySnapshot>((resolve) => {
      finishRefresh = resolve;
    });
    const secondPage: QueuePage = {
      items: [
        {
          ...queue.items[0]!,
          tenureId: "tenure-42",
          issue: { ...issue, number: 42, title: "Second page issue" },
        },
      ],
      watermark: queue.watermark,
      nextCursor: null,
    };
    vi.mocked(client.setDispatchPaused).mockResolvedValue({
      paused: true,
      codexEnabled: true,
      updatedAt: now,
    });
    const container = await renderApp();
    vi.mocked(client.loadSnapshot).mockReturnValueOnce(delayedSnapshot);
    vi.mocked(client.listQueue)
      .mockResolvedValueOnce(queue)
      .mockResolvedValueOnce(secondPage);
    const pause = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Pause",
    )!;
    await act(async () => {
      pause.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const next = [
      ...container.querySelectorAll<HTMLButtonElement>(
        '[aria-label="Ready queue pages"] button',
      ),
    ].find((button) => button.textContent === "Next")!;
    await act(async () => {
      next.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).toContain("Second page issue");
    await act(async () => {
      finishRefresh(snapshot);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).toContain("Second page issue");
    expect(container.textContent).toContain("Page 2");
  });

  test("disables inspector controls when an application refresh is delayed", async () => {
    let finishRefresh!: (value: FactorySnapshot) => void;
    const delayedSnapshot = new Promise<FactorySnapshot>((resolve) => {
      finishRefresh = resolve;
    });
    vi.mocked(client.loadAttempt).mockResolvedValue(retainedRunningAttempt);
    vi.mocked(client.listAttempts).mockImplementation(async (request) => ({
      items: request.issueNodeId ? [retainedRunningAttempt] : [],
      watermark: "attempts-running",
      nextCursor: null,
    }));
    vi.mocked(client.setDispatchPaused).mockResolvedValue({
      paused: true,
      codexEnabled: true,
      updatedAt: now,
    });
    const container = await renderApp();
    const activeAttempt = container.querySelector<HTMLButtonElement>(
      ".issue-title-button",
    )!;
    await act(async () => {
      activeAttempt.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const stop = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Stop attempt")!;
    expect(stop.disabled).toBe(false);

    vi.mocked(client.loadSnapshot).mockReturnValueOnce(delayedSnapshot);
    const pause = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Pause")!;
    await act(async () => {
      pause.click();
      await new Promise((resolve) => setTimeout(resolve, 1_600));
    });
    expect(container.textContent).toContain("Refresh delayed");
    expect(stop.disabled).toBe(true);

    await act(async () => {
      finishRefresh(snapshot);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  });
});
