// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  FactorySnapshot,
  TimelineAttempt,
  TimelinePage,
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
  listAttempts: vi.fn(),
  listTimeline: vi.fn(),
  loadAttempt: vi.fn(),
  loadEvents: vi.fn(),
  loadLifecycleCommands: vi.fn(),
  loadSnapshot: vi.fn(),
  loadTranscript: vi.fn(),
  loadUsage: vi.fn(),
}));

import Timeline from "../src/Timeline.tsx";
import * as client from "../src/client.ts";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const issue = {
  nodeId: "issue-timeline",
  repository: "factory/fixture",
  number: 66,
  url: "https://github.com/factory/fixture/issues/66",
  title: "Compare retained attempts on a provider timeline",
};
const base = {
  provider: "codex",
  issue,
  requestedModel: "gpt-5.6-sol",
  requestedEffort: "high",
  observedModel: null,
  observedEffort: null,
  createdAt: "2026-01-15T10:00:00.000Z",
  updatedAt: "2026-01-15T11:00:00.000Z",
  startedAt: "2026-01-15T10:00:00.000Z",
  endedAt: "2026-01-15T11:00:00.000Z",
  archivedAt: null,
} as TimelineAttempt;
const attempts: TimelineAttempt[] = [
  { ...base, id: "attempt-running", state: "running", endedAt: null },
  { ...base, id: "attempt-completed", state: "completed" },
  {
    ...base,
    id: "attempt-failed",
    state: "failed",
    endedAt: "2026-01-15T10:01:00.000Z",
    archivedAt: "2026-01-15T11:30:00.000Z",
  },
  {
    ...base,
    id: "attempt-interrupted",
    state: "interrupted",
    startedAt: "2026-01-15T10:02:00.000Z",
    endedAt: "2026-01-15T10:03:00.000Z",
  },
  { ...base, id: "attempt-stopped", state: "stopped" },
  {
    ...base,
    id: "attempt-stop-uncertain",
    state: "stop_uncertain",
    endedAt: null,
  },
];
const firstPage: TimelinePage = {
  items: attempts,
  watermark: "timeline-watermark",
  nextCursor: attempts.length,
  readAt: "2026-01-15T12:00:00.000Z",
};
const snapshot = {
  receipt: null,
  assignment: null,
  events: [],
  configuration: {
    repositories: [],
    codexSlots: 3,
    pollIntervalMs: 30_000,
    access: "Local only",
  },
  dispatch: {
    paused: false,
    codexEnabled: true,
    updatedAt: "2026-01-15T12:00:00.000Z",
  },
} as FactorySnapshot;

let root: Root;

async function renderTimeline() {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<Timeline />);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return container;
}

beforeEach(() => {
  window.history.replaceState(null, "", "/?view=timeline");
  vi.mocked(client.listTimeline).mockResolvedValue(firstPage);
  vi.mocked(client.loadSnapshot).mockResolvedValue(snapshot);
  vi.mocked(client.loadUsage).mockImplementation(async (attemptId) => ({
    items:
      attemptId === "attempt-running"
        ? [
            {
              attemptId,
              timestamp: "2026-01-15T11:00:00.000Z",
              total: {
                inputTokens: 70,
                cachedInputTokens: 0,
                outputTokens: 30,
                reasoningOutputTokens: 0,
                totalTokens: 100,
              },
              last: {
                inputTokens: 70,
                cachedInputTokens: 0,
                outputTokens: 30,
                reasoningOutputTokens: 0,
                totalTokens: 100,
              },
              modelContextWindow: null,
            },
          ]
        : [],
    watermark: `usage-${attemptId}`,
    nextCursor: null,
  }));
  vi.mocked(client.loadAttempt).mockResolvedValue(null);
  vi.mocked(client.listAttempts).mockResolvedValue({
    items: [],
    watermark: "attempts",
    nextCursor: null,
  });
  vi.mocked(client.loadEvents).mockResolvedValue({
    items: [],
    watermark: "events",
    nextCursor: null,
  });
  vi.mocked(client.loadLifecycleCommands).mockResolvedValue({
    items: [],
    watermark: "commands",
    nextCursor: null,
  });
  vi.mocked(client.loadTranscript).mockResolvedValue({
    items: [],
    watermark: "transcript",
    nextCursor: null,
  });
});

afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("Codex timeline", () => {
  test("shows explicit states, archived attempts, usage, and the UTC label", async () => {
    const container = await renderTimeline();
    expect(container.textContent).toContain("Times shown in UTC");
    expect(container.textContent).toContain("3 configured slots");
    expect(container.textContent).toContain("Running");
    expect(container.textContent).toContain("Completed");
    expect(container.textContent).toContain("Failed · Archived");
    expect(container.textContent).toContain("Interrupted");
    expect(container.textContent).toContain("Stopped");
    expect(container.textContent).toContain("Stop unconfirmed");
    expect(container.textContent).toContain("100 tokens");
    expect(container.textContent).toContain("Tokens unknown");
    const failedPoint = container
      .querySelector('[data-attempt-id="attempt-failed"]')!
      .closest(".timeline-point")!;
    const interruptedPoint = container
      .querySelector('[data-attempt-id="attempt-interrupted"]')!
      .closest(".timeline-point")!;
    expect(failedPoint.textContent).toContain("factory/fixture #66");
    expect(failedPoint.textContent).toContain("Failed · Archived");
    expect(
      failedPoint.querySelector(".timeline-point-marker")!.textContent,
    ).not.toBe(
      interruptedPoint.querySelector(".timeline-point-marker")!.textContent,
    );
  });

  test("opens the shared inspector destination when an attempt is selected", async () => {
    const container = await renderTimeline();
    const card = container.querySelector<HTMLButtonElement>(
      '[data-attempt-id="attempt-running"]',
    )!;
    await act(async () => card.click());
    expect(new URLSearchParams(window.location.search).get("attempt")).toBe(
      "attempt-running",
    );
    expect(client.loadAttempt).toHaveBeenCalledWith("attempt-running");
  });

  test("carries the first page watermark into the next bounded read", async () => {
    const container = await renderTimeline();
    vi.mocked(client.listTimeline).mockResolvedValueOnce({
      items: [],
      watermark: "timeline-watermark",
      nextCursor: null,
      readAt: "2026-01-15T12:00:00.000Z",
    });
    const next = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Next")!;
    await act(async () => {
      next.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(client.listTimeline).toHaveBeenLastCalledWith({
      limit: 12,
      cursor: attempts.length,
      watermark: "timeline-watermark",
    });
  });

  test("returns to page one with the original watermark and read time", async () => {
    const container = await renderTimeline();
    const firstAxis = container.querySelector(".timeline-axis")!.textContent;
    const initialReads = vi.mocked(client.listTimeline).mock.calls.length;
    vi.mocked(client.listTimeline).mockResolvedValueOnce({
      items: [{ ...attempts[1]!, id: "attempt-page-two" }],
      watermark: "timeline-watermark",
      nextCursor: null,
      readAt: firstPage.readAt,
    });
    const button = (label: string) =>
      [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent === label,
      )!;

    await act(async () => {
      button("Next").click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await act(async () => {
      button("Previous").click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(vi.mocked(client.listTimeline).mock.calls).toHaveLength(
      initialReads + 1,
    );
    expect(container.textContent).toContain("Page 1");
    expect(container.textContent).toContain("Running");
    expect(container.querySelector(".timeline-axis")!.textContent).toBe(
      firstAxis,
    );
  });

  test("keeps page one when the next timeline read fails", async () => {
    const container = await renderTimeline();
    vi.mocked(client.listTimeline).mockRejectedValueOnce(
      new Error("next timeline page unavailable"),
    );
    const findButton = (label: string) =>
      [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent === label,
      )!;

    await act(async () => {
      findButton("Next").click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(container.textContent).toContain("Page 1");
    expect(container.textContent).toContain("Running");
    expect(container.textContent).toContain("next timeline page unavailable");
    expect(findButton("Previous").disabled).toBe(true);
  });
});
