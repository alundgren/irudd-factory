// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TimelineAttempt, TimelinePage } from "@irudd-factory/contracts";
import { afterEach, expect, test, vi } from "vite-plus/test";

vi.mock("../src/client.ts", () => ({
  listTimeline: vi.fn(),
  loadSnapshot: vi.fn(),
  loadUsage: vi.fn(),
}));
vi.mock("../src/AttemptInspector.tsx", () => ({
  default: ({ onChanged }: { onChanged: () => void }) => (
    <button onClick={onChanged}>Simulate inspector change</button>
  ),
}));

import Timeline from "../src/Timeline.tsx";
import * as client from "../src/client.ts";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const attempt = {
  id: "timeline-refresh",
  provider: "codex",
  issue: {
    nodeId: "timeline-refresh-issue",
    repository: "factory/fixture",
    number: 66,
    url: "https://github.com/factory/fixture/issues/66",
    title: "Refresh timeline after lifecycle action",
  },
  state: "completed",
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

function page(nextCursor: number | null, state = attempt.state): TimelinePage {
  return {
    items: [{ ...attempt, state }],
    nextCursor,
    watermark: "fixed-timeline",
    readAt: "2026-01-15T12:00:00.000Z",
  };
}

let root: Root;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

test("starts a fresh traversal after an inspector lifecycle change", async () => {
  vi.mocked(client.listTimeline)
    .mockResolvedValueOnce(page(1))
    .mockResolvedValueOnce(page(null))
    .mockResolvedValueOnce(page(null, "stopped"));
  vi.mocked(client.loadSnapshot).mockResolvedValue({
    receipt: null,
    assignment: null,
    events: [],
    configuration: {
      repositories: [],
      codexSlots: 1,
      pollIntervalMs: 30_000,
      access: "Local only",
    },
  });
  vi.mocked(client.loadUsage).mockResolvedValue({
    items: [],
    nextCursor: null,
    watermark: "usage",
  });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<Timeline />);
    await new Promise((resolve) => setTimeout(resolve, 20));
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
    button("Simulate inspector change").click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  expect(client.listTimeline).toHaveBeenLastCalledWith({ limit: 12 });
  expect(container.textContent).toContain("Stopped");
  expect(container.textContent).toContain("Page 1");
});
