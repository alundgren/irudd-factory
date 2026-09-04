// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  Attempt,
  AttemptPage,
  EventPage,
  LifecycleCommand,
  TranscriptPage,
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
  loadAttempt: vi.fn(),
  loadEvents: vi.fn(),
  loadLifecycleCommands: vi.fn(),
  loadTranscript: vi.fn(),
  loadUsage: vi.fn(),
}));

import AttemptInspector from "../src/AttemptInspector.tsx";
import * as client from "../src/client.ts";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const now = "2026-01-15T12:00:00.000Z";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function attempt(
  id: string,
  state: Attempt["state"],
  overrides: Partial<Attempt> = {},
): Attempt {
  return {
    id,
    provider: "codex",
    issue: {
      nodeId: "issue-65",
      repository: "factory/fixture",
      number: 65,
      url: "https://github.com/factory/fixture/issues/65",
      title: "Inspect retained attempts",
    },
    state,
    workflow: {
      startingCommit: "a".repeat(40),
      blobId: "b".repeat(40),
      digest: "c".repeat(64),
      body: "Fixture workflow",
    },
    workspace: {
      clonePath: "/fixture/clones/factory-fixture",
      worktreePath: `/fixture/worktrees/${id}`,
      worktreeGitDir: `/fixture/clones/factory-fixture/.git/worktrees/${id}`,
      commonGitDir: "/fixture/clones/factory-fixture/.git",
      branch: `factory/${id}`,
    },
    requestedModel: "gpt-5.6-sol",
    requestedEffort: "high",
    observedModel: "gpt-5.6-sol",
    observedEffort: "high",
    codexVersion: "codex-cli fixture",
    threadId: "thread-fixture",
    turnId: "turn-fixture",
    processGroupId: null,
    processStartIdentity: null,
    processStartPending: false,
    pullRequest: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    lastEventSequence: 4,
    archivedAt: null,
    ...overrides,
  };
}

const failed = attempt("attempt-failed", "failed", {
  observedModel: null,
  observedEffort: null,
  error: { code: "provider_failed", message: "The provider exited." },
});
const completed = attempt("attempt-completed", "completed", {
  pullRequest: {
    url: "https://github.com/factory/fixture/pull/70",
    number: 70,
    draft: false,
  },
});
const archived = attempt("attempt-archived", "stopped", {
  archivedAt: "2026-01-15T12:30:00.000Z",
});
const running = attempt("attempt-running", "running");

let root: Root;

function SelectableInspector({
  initialAttemptId,
}: {
  readonly initialAttemptId: string;
}) {
  const [selectedAttemptId, setSelectedAttemptId] = useState<string | null>(
    initialAttemptId,
  );
  return (
    <AttemptInspector
      selectedAttemptId={selectedAttemptId}
      controlsDisabled={false}
      refreshVersion={0}
      onSelect={setSelectedAttemptId}
      onChanged={() => {}}
    />
  );
}

async function renderInspector(selectedAttemptId: string | null = null) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <AttemptInspector
        selectedAttemptId={selectedAttemptId}
        controlsDisabled={false}
        refreshVersion={0}
        onSelect={() => {}}
        onChanged={() => {}}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return container;
}

async function renderSelectableInspector(initialAttemptId: string) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<SelectableInspector initialAttemptId={initialAttemptId} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return container;
}

beforeEach(() => {
  vi.mocked(client.listAttempts).mockImplementation(async (request) => ({
    items: request.issueNodeId
      ? [failed, completed, archived]
      : [failed, completed],
    watermark: "attempts-1",
    nextCursor: request.issueNodeId ? null : 2,
  }));
  vi.mocked(client.loadAttempt).mockImplementation(
    async (id) =>
      [failed, completed, archived].find((item) => item.id === id) ?? null,
  );
  vi.mocked(client.loadTranscript).mockResolvedValue({
    items: [
      {
        sequence: 1,
        attemptId: failed.id,
        timestamp: now,
        role: "agent",
        text: "Retained work output",
        truncated: true,
      },
    ],
    watermark: "transcript-1",
    nextCursor: 1,
  });
  vi.mocked(client.loadEvents).mockResolvedValue({
    items: [
      {
        sequence: 1,
        assignmentId: failed.id,
        timestamp: now,
        type: "assignment.failed",
        detail: { code: "provider_failed" },
      },
    ],
    watermark: "events-1",
    nextCursor: null,
  });
  vi.mocked(client.loadLifecycleCommands).mockResolvedValue({
    items: [],
    watermark: "lifecycle-1",
    nextCursor: null,
  });
  vi.mocked(client.loadUsage).mockResolvedValue({
    items: [],
    watermark: "usage-1",
    nextCursor: null,
  });
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("Attempt inspector", () => {
  test("uses a bounded default list and can include archived attempts", async () => {
    const container = await renderInspector();
    expect(client.listAttempts).toHaveBeenCalledWith({
      limit: 6,
      includeArchived: false,
    });

    const checkbox = container.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    await act(async () => {
      checkbox.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(client.listAttempts).toHaveBeenLastCalledWith({
      limit: 6,
      includeArchived: true,
    });
  });

  test("moves forward and backward through fixed session pages", async () => {
    vi.mocked(client.listAttempts).mockImplementation(async (request) =>
      request.cursor === 2
        ? {
            items: [archived],
            watermark: "attempts-fixed",
            nextCursor: null,
          }
        : {
            items: [failed, completed],
            watermark: "attempts-fixed",
            nextCursor: 2,
          },
    );
    const container = await renderInspector();
    const pages = container.querySelector('[aria-label="Session pages"]')!;
    const next = [...pages.querySelectorAll("button")].find(
      (button) => button.textContent === "Next",
    )!;
    await act(async () => {
      next.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).toContain("Page 2");
    expect(container.textContent).toContain("Archived");
    expect(client.listAttempts).toHaveBeenLastCalledWith({
      limit: 6,
      includeArchived: false,
      cursor: 2,
      watermark: "attempts-fixed",
    });

    const previous = [...pages.querySelectorAll("button")].find(
      (button) => button.textContent === "Previous",
    )!;
    await act(async () => previous.click());
    expect(container.textContent).toContain("Page 1");
    expect(container.textContent).toContain("Inspect retained attempts");
  });

  test("keeps the current session page when loading the next page fails", async () => {
    vi.mocked(client.listAttempts).mockImplementation(async (request) => {
      if (request.cursor === 2) throw new Error("page unavailable");
      return {
        items: [failed, completed],
        watermark: "attempts-fixed",
        nextCursor: 2,
      };
    });
    const container = await renderInspector();
    const next = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Next",
    )!;
    await act(async () => {
      next.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).toContain("Page 1");
    expect(container.textContent).toContain("page unavailable");
  });

  test("ignores an older session page after the archive filter changes", async () => {
    const delayedNext = deferred<AttemptPage>();
    vi.mocked(client.listAttempts).mockImplementation(async (request) => {
      if (request.cursor === 2) return delayedNext.promise;
      return request.includeArchived
        ? {
            items: [archived],
            watermark: "attempts-all",
            nextCursor: null,
          }
        : {
            items: [failed],
            watermark: "attempts-current",
            nextCursor: 2,
          };
    });
    const container = await renderInspector();
    const next = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Next",
    )!;
    await act(async () => next.click());
    const checkbox = container.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    await act(async () => {
      checkbox.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).toContain("Archived");
    delayedNext.resolve({
      items: [completed],
      watermark: "attempts-current",
      nextCursor: null,
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).toContain("Page 1");
    expect(container.textContent).toContain("Archived");
    expect(container.textContent).not.toContain("Completed");
  });

  test("applies only one result when Next is invoked repeatedly", async () => {
    const firstNext = deferred<AttemptPage>();
    let nextCalls = 0;
    vi.mocked(client.listAttempts).mockImplementation(async (request) => {
      if (request.cursor === 2) {
        nextCalls += 1;
        return firstNext.promise;
      }
      return {
        items: [failed],
        watermark: "attempts-fixed",
        nextCursor: 2,
      };
    });
    const container = await renderInspector();
    const next = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Next")!;
    await act(async () => {
      next.click();
    });
    expect(next.disabled).toBe(true);
    next.click();
    expect(nextCalls).toBe(1);
    firstNext.resolve({
      items: [completed],
      watermark: "attempts-fixed",
      nextCursor: null,
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).toContain("Page 2");
    expect(container.textContent).not.toContain("Page 3");
    expect(container.textContent).toContain("Completed");
  });

  test("switches every evidence section when a sibling is selected", async () => {
    vi.mocked(client.loadTranscript).mockImplementation(async (attemptId) => ({
      items: [
        {
          sequence: 1,
          attemptId,
          timestamp: now,
          role: "agent",
          text:
            attemptId === failed.id
              ? "Retained work output"
              : "Completed sibling output",
          truncated: attemptId === failed.id,
        },
      ],
      watermark: `transcript-${attemptId}`,
      nextCursor: null,
    }));
    vi.mocked(client.loadUsage).mockImplementation(async (attemptId) => ({
      items:
        attemptId === completed.id
          ? [
              {
                attemptId,
                timestamp: now,
                total: {
                  inputTokens: 20,
                  cachedInputTokens: 0,
                  outputTokens: 10,
                  reasoningOutputTokens: 0,
                  totalTokens: 30,
                },
                last: {
                  inputTokens: 20,
                  cachedInputTokens: 0,
                  outputTokens: 10,
                  reasoningOutputTokens: 0,
                  totalTokens: 30,
                },
                modelContextWindow: null,
              },
            ]
          : [],
      watermark: `usage-${attemptId}`,
      nextCursor: null,
    }));
    vi.mocked(client.loadEvents).mockImplementation(async (attemptId) => ({
      items: [
        {
          sequence: 1,
          assignmentId: attemptId,
          timestamp: now,
          type:
            attemptId === failed.id
              ? "assignment.failed"
              : "assignment.completed",
          detail: attemptId === failed.id ? { code: "provider_failed" } : {},
        },
      ],
      watermark: `events-${attemptId}`,
      nextCursor: null,
    }));
    const container = await renderSelectableInspector(failed.id);
    expect(container.textContent).toContain("Failed");
    expect(container.textContent).toContain("Effective modelgpt-5.6-sol");
    expect(container.textContent).toContain("Observed settingsNot observed");
    expect(container.textContent).toContain("TokensUnknown");
    expect(container.textContent).toContain("Point-in-time record");
    expect(container.textContent).toContain("Retained work output");
    expect(container.textContent).toContain("This entry was truncated");
    expect(container.textContent).toContain("provider_failed");
    expect(container.textContent).toContain(`/fixture/worktrees/${failed.id}`);
    expect(container.textContent).toContain("Open issue on GitHub");
    expect(container.querySelectorAll(".sibling-list button")).toHaveLength(3);
    expect(container.textContent).not.toContain("Send message");
    expect(container.textContent).not.toContain("Approve");

    const completedSibling = [
      ...container.querySelectorAll<HTMLButtonElement>(".sibling-list button"),
    ].find((button) => button.textContent?.includes("Completed"))!;
    await act(async () => {
      completedSibling.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(client.loadAttempt).toHaveBeenLastCalledWith(completed.id);
    expect(container.textContent).toContain("Completed sibling output");
    expect(container.textContent).toContain("Tokens30");
    expect(container.textContent).toContain(
      `/fixture/worktrees/${completed.id}`,
    );
    expect(container.textContent).toContain("Open pull request #70");
    expect(container.textContent).not.toContain("provider_failed");
    expect(container.textContent).not.toContain("Retained work output");
  });

  test("follows the sibling watermark past one hundred attempts", async () => {
    const many = Array.from({ length: 101 }, (_, index) =>
      attempt(`attempt-${String(index).padStart(3, "0")}`, "completed"),
    );
    vi.mocked(client.loadAttempt).mockResolvedValue(many[0]!);
    vi.mocked(client.listAttempts).mockImplementation(async (request) => {
      if (!request.issueNodeId) {
        return { items: [many[0]!], watermark: "attempts-1", nextCursor: null };
      }
      return request.cursor === 100
        ? {
            items: many.slice(100),
            watermark: "siblings-fixed",
            nextCursor: null,
          }
        : {
            items: many.slice(0, 100),
            watermark: "siblings-fixed",
            nextCursor: 100,
          };
    });
    const container = await renderInspector(many[0]!.id);
    expect(container.querySelectorAll(".sibling-list button")).toHaveLength(
      100,
    );
    const more = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Load more attempts",
    )!;
    await act(async () => {
      more.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(client.listAttempts).toHaveBeenLastCalledWith({
      limit: 100,
      includeArchived: true,
      issueNodeId: many[0]!.issue.nodeId,
      cursor: 100,
      watermark: "siblings-fixed",
    });
    expect(container.querySelectorAll(".sibling-list button")).toHaveLength(
      101,
    );
  });

  test("removes stale controls while a sibling detail request is pending", async () => {
    const pendingCompleted = deferred<Attempt | null>();
    vi.mocked(client.loadAttempt).mockImplementation((id) =>
      id === completed.id ? pendingCompleted.promise : Promise.resolve(failed),
    );
    const container = await renderSelectableInspector(failed.id);
    expect(container.textContent).toContain("Restart attempt");
    const completedSibling = [
      ...container.querySelectorAll<HTMLButtonElement>(".sibling-list button"),
    ].find((button) => button.textContent?.includes("Completed"))!;
    await act(async () => completedSibling.click());
    expect(container.textContent).toContain("Loading attempt");
    expect(container.textContent).not.toContain("Restart attempt");
    expect(container.textContent).not.toContain("The provider exited");

    await act(async () => {
      pendingCompleted.resolve(completed);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).toContain("Open pull request #70");
    expect(container.textContent).toContain("Archive");
  });

  test("ignores attempt evidence continuations after selecting a sibling", async () => {
    const pendingTranscript = deferred<TranscriptPage>();
    const pendingEvents = deferred<EventPage>();
    const pendingSiblings = deferred<AttemptPage>();
    vi.mocked(client.loadTranscript).mockImplementation(
      async (attemptId, _limit, cursor) => {
        if (attemptId === failed.id && cursor === 1) {
          return pendingTranscript.promise;
        }
        return {
          items: [
            {
              sequence: 1,
              attemptId,
              timestamp: now,
              role: "agent",
              text:
                attemptId === failed.id
                  ? "Attempt A transcript"
                  : "Attempt B transcript",
              truncated: false,
            },
          ],
          watermark: `transcript-${attemptId}`,
          nextCursor: attemptId === failed.id ? 1 : null,
        };
      },
    );
    vi.mocked(client.loadEvents).mockImplementation(
      async (attemptId, _limit, cursor) => {
        if (attemptId === failed.id && cursor === 1) {
          return pendingEvents.promise;
        }
        return {
          items: [
            {
              sequence: 1,
              assignmentId: attemptId,
              timestamp: now,
              type:
                attemptId === failed.id
                  ? "assignment.failed"
                  : "assignment.completed",
              detail: {},
            },
          ],
          watermark: `events-${attemptId}`,
          nextCursor: attemptId === failed.id ? 1 : null,
        };
      },
    );
    vi.mocked(client.listAttempts).mockImplementation(async (request) => {
      if (!request.issueNodeId) {
        return { items: [failed], watermark: "attempts-1", nextCursor: null };
      }
      if (request.cursor === 2) return pendingSiblings.promise;
      return {
        items: [failed, completed],
        watermark: "siblings-fixed",
        nextCursor: 2,
      };
    });
    const container = await renderSelectableInspector(failed.id);
    const moreTranscript = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Load more transcript",
    )!;
    const moreEvents = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Load more events",
    )!;
    const moreSiblings = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Load more attempts",
    )!;
    await act(async () => {
      moreTranscript.click();
      moreEvents.click();
      moreSiblings.click();
    });
    const completedSibling = [
      ...container.querySelectorAll<HTMLButtonElement>(".sibling-list button"),
    ].find((button) => button.textContent?.includes("Completed"))!;
    await act(async () => {
      completedSibling.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).toContain("Attempt B transcript");
    expect(container.textContent).toContain("assignment.completed");

    pendingTranscript.resolve({
      items: [
        {
          sequence: 2,
          attemptId: failed.id,
          timestamp: now,
          role: "agent",
          text: "Late attempt A transcript",
          truncated: false,
        },
      ],
      watermark: "transcript-attempt-a",
      nextCursor: null,
    });
    pendingEvents.resolve({
      items: [
        {
          sequence: 2,
          assignmentId: failed.id,
          timestamp: now,
          type: "late.attempt-a-event",
          detail: {},
        },
      ],
      watermark: "events-attempt-a",
      nextCursor: null,
    });
    pendingSiblings.resolve({
      items: [archived],
      watermark: "siblings-fixed",
      nextCursor: null,
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).toContain("Attempt B transcript");
    expect(container.textContent).toContain("assignment.completed");
    expect(container.textContent).not.toContain("Late attempt A transcript");
    expect(container.textContent).not.toContain("late.attempt-a-event");
    expect(container.querySelectorAll(".sibling-list button")).toHaveLength(2);
  });

  test("does not restore an old selection after its command completes", async () => {
    const pendingCommand = deferred<LifecycleCommand>();
    vi.mocked(client.controlAttempt).mockReturnValue(pendingCommand.promise);
    const container = await renderSelectableInspector(failed.id);
    const restart = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Restart attempt",
    )!;
    await act(async () => restart.click());
    const confirm = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Confirm",
    )!;
    await act(async () => confirm.click());

    const completedSibling = [
      ...container.querySelectorAll<HTMLButtonElement>(".sibling-list button"),
    ].find((button) => button.textContent?.includes("Completed"))!;
    await act(async () => {
      completedSibling.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).toContain("Open pull request #70");

    await act(async () => {
      pendingCommand.resolve({
        commandId: "command-old-selection",
        kind: "restart",
        targetAttemptId: failed.id,
        expectedTargetVersion: failed.lastEventSequence,
        phase: "final",
        effect: "Restarted as a sibling attempt",
        admission: {
          _tag: "accepted",
          sourceState: "failed",
          sourceVersion: failed.lastEventSequence,
        },
        consequence: { _tag: "restarted", siblingAttemptId: "attempt-new" },
        createdAt: now,
        updatedAt: now,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).toContain("Open pull request #70");
    expect(container.textContent).not.toContain("The provider exited");
    expect(container.textContent).not.toContain("Restart attemptFinal");
    expect(client.loadAttempt).toHaveBeenLastCalledWith(completed.id);
  });

  test("disables controls during refresh and updates them from current state", async () => {
    const refreshed = deferred<Attempt | null>();
    vi.mocked(client.loadAttempt)
      .mockResolvedValueOnce(running)
      .mockReturnValueOnce(refreshed.promise);
    vi.mocked(client.listAttempts).mockResolvedValue({
      items: [running],
      watermark: "attempts-running",
      nextCursor: null,
    });
    const container = await renderInspector(running.id);
    const stop = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Stop attempt")!;
    expect(stop.disabled).toBe(false);
    await act(async () => stop.click());
    expect(container.textContent).toContain("Confirm stop attempt");

    vi.mocked(client.loadAttempt).mockResolvedValue(failed);
    vi.mocked(client.listAttempts).mockResolvedValue({
      items: [failed],
      watermark: "attempts-failed",
      nextCursor: null,
    });
    await act(async () => {
      root.render(
        <AttemptInspector
          selectedAttemptId={running.id}
          controlsDisabled={false}
          refreshVersion={1}
          onSelect={() => {}}
          onChanged={() => {}}
        />,
      );
    });
    expect(stop.disabled).toBe(true);
    const pendingConfirm = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Confirm")!;
    expect(pendingConfirm.disabled).toBe(true);

    await act(async () => {
      refreshed.resolve({ ...completed, id: running.id });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).toContain("Archive");
    expect(container.textContent).not.toContain("Stop attempt");
    expect(container.textContent).not.toContain("Confirm stop attempt");
    expect(document.activeElement?.textContent).toBe("Close");
  });

  test("enables the new selection after invalidating an older state refresh", async () => {
    const pendingRunningRefresh = deferred<Attempt | null>();
    let runningCalls = 0;
    vi.mocked(client.loadAttempt).mockImplementation((id) => {
      if (id === running.id) {
        runningCalls += 1;
        return runningCalls === 1
          ? Promise.resolve(running)
          : pendingRunningRefresh.promise;
      }
      return Promise.resolve(completed);
    });
    vi.mocked(client.listAttempts).mockImplementation(async (request) => ({
      items: request.issueNodeId ? [running, completed] : [running, completed],
      watermark: "attempts-switch-refresh",
      nextCursor: null,
    }));
    const container = await renderInspector(running.id);
    await act(async () => {
      root.render(
        <AttemptInspector
          selectedAttemptId={running.id}
          controlsDisabled={false}
          refreshVersion={1}
          onSelect={() => {}}
          onChanged={() => {}}
        />,
      );
    });

    await act(async () => {
      root.render(
        <AttemptInspector
          selectedAttemptId={completed.id}
          controlsDisabled={false}
          refreshVersion={1}
          onSelect={() => {}}
          onChanged={() => {}}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const archive = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Archive")!;
    expect(archive.disabled).toBe(false);

    await act(async () => {
      pendingRunningRefresh.resolve(running);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).toContain("Open pull request #70");
    expect(archive.disabled).toBe(false);
  });

  test("disables controls when the application reports delayed data", async () => {
    vi.mocked(client.loadAttempt).mockResolvedValue(running);
    vi.mocked(client.listAttempts).mockResolvedValue({
      items: [running],
      watermark: "attempts-running",
      nextCursor: null,
    });
    const container = await renderInspector(running.id);
    const stopBeforeDelay = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Stop attempt")!;
    await act(async () => stopBeforeDelay.click());
    await act(async () => {
      root.render(
        <AttemptInspector
          selectedAttemptId={running.id}
          controlsDisabled={true}
          refreshVersion={0}
          onSelect={() => {}}
          onChanged={() => {}}
        />,
      );
    });
    const stop = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Stop attempt")!;
    expect(stop.disabled).toBe(true);
    const confirm = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Confirm")!;
    expect(confirm.disabled).toBe(true);
  });

  test("keeps controls disabled when detail refresh fails", async () => {
    vi.mocked(client.loadAttempt)
      .mockResolvedValueOnce(running)
      .mockRejectedValueOnce(new Error("attempt refresh unavailable"));
    vi.mocked(client.listAttempts).mockResolvedValue({
      items: [running],
      watermark: "attempts-running",
      nextCursor: null,
    });
    const container = await renderInspector(running.id);
    const stopBeforeFailure = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Stop attempt")!;
    await act(async () => stopBeforeFailure.click());
    await act(async () => {
      root.render(
        <AttemptInspector
          selectedAttemptId={running.id}
          controlsDisabled={false}
          refreshVersion={1}
          onSelect={() => {}}
          onChanged={() => {}}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).toContain("attempt refresh unavailable");
    const stop = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Stop attempt")!;
    expect(stop.disabled).toBe(true);
    const confirm = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Confirm")!;
    expect(confirm.disabled).toBe(true);
    const moreTranscript = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Load more transcript",
    )!;
    await act(async () => {
      moreTranscript.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(stop.disabled).toBe(true);
    expect(container.textContent).toContain("attempt refresh unavailable");
  });

  test("confirms restart and reports durable command phases", async () => {
    const generatedCommandId = "00000000-0000-4000-8000-000000000065";
    vi.spyOn(crypto, "randomUUID").mockReturnValue(generatedCommandId);
    let resolveCommand!: (command: LifecycleCommand) => void;
    let resolved = false;
    let pollCount = 0;
    const finalCommand: LifecycleCommand = {
      commandId: generatedCommandId,
      kind: "restart",
      targetAttemptId: failed.id,
      expectedTargetVersion: failed.lastEventSequence,
      phase: "final",
      effect: "Restarted as a sibling attempt",
      admission: {
        _tag: "accepted",
        sourceState: "failed",
        sourceVersion: failed.lastEventSequence,
      },
      consequence: { _tag: "restarted", siblingAttemptId: "attempt-new" },
      createdAt: now,
      updatedAt: now,
    };
    vi.mocked(client.loadLifecycleCommands).mockImplementation(
      async (_attemptId, requestedCommandId) => {
        if (!requestedCommandId) {
          return {
            items: resolved ? [finalCommand] : [],
            watermark: "lifecycle-1",
            nextCursor: null,
          };
        }
        pollCount += 1;
        return {
          items: [
            {
              ...finalCommand,
              phase: pollCount === 1 ? "accepted" : "executing",
              consequence: null,
              effect:
                pollCount === 1 ? "Command admitted" : "Restarting the attempt",
            },
          ],
          watermark: "lifecycle-command",
          nextCursor: null,
        };
      },
    );
    vi.mocked(client.controlAttempt).mockReturnValue(
      new Promise((resolve) => {
        resolveCommand = resolve;
      }),
    );
    const container = await renderInspector(failed.id);
    const restart = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Restart attempt",
    )!;
    await act(async () => restart.click());
    expect(container.textContent).toContain("Confirm restart attempt");

    const confirm = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Confirm",
    )!;
    await act(async () => {
      confirm.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).toContain("Accepted");

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    expect(container.textContent).toContain("Executing");

    await act(async () => {
      resolved = true;
      resolveCommand(finalCommand);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).toContain("Final");
    expect(client.loadLifecycleCommands).toHaveBeenCalledWith(
      failed.id,
      generatedCommandId,
    );
  });

  test("restores the latest durable command after opening the inspector", async () => {
    vi.mocked(client.loadLifecycleCommands).mockResolvedValue({
      items: [
        {
          commandId: "command-returned",
          kind: "return",
          targetAttemptId: failed.id,
          expectedTargetVersion: failed.lastEventSequence,
          phase: "final",
          effect: "Returned the issue",
          admission: {
            _tag: "accepted",
            sourceState: "failed",
            sourceVersion: failed.lastEventSequence,
          },
          consequence: { _tag: "returned", claimedRemoved: true },
          createdAt: now,
          updatedAt: now,
        },
      ],
      watermark: "lifecycle-reload",
      nextCursor: null,
    });
    const container = await renderInspector(failed.id);
    expect(container.textContent).toContain("Return issueFinal");
    expect(container.textContent).toContain("Returned the issue");
  });

  test("archives without confirmation and restores archived attempts", async () => {
    vi.mocked(client.controlAttempt).mockImplementation(async (_id, kind) => ({
      commandId: `command-${kind}`,
      kind,
      targetAttemptId: completed.id,
      expectedTargetVersion: completed.lastEventSequence,
      phase: "final",
      effect: kind === "archive" ? "Archived" : "Restored",
      admission: {
        _tag: "accepted",
        sourceState: "completed",
        sourceVersion: completed.lastEventSequence,
      },
      consequence:
        kind === "archive" ? { _tag: "archived" } : { _tag: "restored" },
      createdAt: now,
      updatedAt: now,
    }));
    const completedView = await renderInspector(completed.id);
    const archive = [...completedView.querySelectorAll("button")].find(
      (button) => button.textContent === "Archive",
    )!;
    await act(async () => {
      archive.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(completedView.textContent).not.toContain("Confirm archive");
    expect(client.controlAttempt).toHaveBeenCalled();
  });

  test("requires confirmation for stop", async () => {
    vi.mocked(client.loadAttempt).mockResolvedValue(running);
    vi.mocked(client.listAttempts).mockResolvedValue({
      items: [running],
      watermark: "attempts-running",
      nextCursor: null,
    });
    const runningView = await renderInspector(running.id);
    const stop = [...runningView.querySelectorAll("button")].find(
      (button) => button.textContent === "Stop attempt",
    )!;
    await act(async () => stop.click());
    expect(runningView.textContent).toContain("Confirm stop attempt");
  });

  test("requires confirmation for return", async () => {
    vi.mocked(client.loadAttempt).mockResolvedValue(failed);
    vi.mocked(client.listAttempts).mockResolvedValue({
      items: [failed],
      watermark: "attempts-failed",
      nextCursor: null,
    });
    const failedView = await renderInspector(failed.id);
    const returnIssue = [...failedView.querySelectorAll("button")].find(
      (button) => button.textContent === "Return issue",
    )!;
    await act(async () => returnIssue.click());
    expect(failedView.textContent).toContain("Confirm return issue");
  });

  test("offers restore without confirmation for an archived attempt", async () => {
    vi.mocked(client.controlAttempt).mockResolvedValue({
      commandId: "command-restore",
      kind: "restore",
      targetAttemptId: archived.id,
      expectedTargetVersion: archived.lastEventSequence,
      phase: "final",
      effect: "Restored",
      admission: {
        _tag: "accepted",
        sourceState: "stopped",
        sourceVersion: archived.lastEventSequence,
      },
      consequence: { _tag: "restored" },
      createdAt: now,
      updatedAt: now,
    });
    const container = await renderInspector(archived.id);
    expect(container.textContent).toContain("Restore");
    expect(container.textContent).not.toContain("Stop attempt");
    expect(container.textContent).not.toContain("Restart attempt");
    const restore = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Restore",
    )!;
    await act(async () => {
      restore.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).not.toContain("Confirm restore");
    expect(client.controlAttempt).toHaveBeenCalledWith(
      expect.any(String),
      "restore",
      archived.id,
      archived.lastEventSequence,
    );
  });

  test("only offers stop for an attempt with uncertain process ownership", async () => {
    const uncertain = attempt("attempt-uncertain", "stop_uncertain");
    vi.mocked(client.loadAttempt).mockResolvedValue(uncertain);
    vi.mocked(client.listAttempts).mockImplementation(async (request) => ({
      items: request.issueNodeId ? [uncertain] : [uncertain],
      watermark: "attempts-uncertain",
      nextCursor: null,
    }));
    const container = await renderInspector(uncertain.id);
    expect(container.textContent).toContain(
      "Factory could not confirm that the provider process stopped",
    );
    expect(container.textContent).toContain("Stop attempt");
    expect(container.textContent).not.toContain("Archive");
    expect(container.textContent).not.toContain("Restart attempt");
  });

  test("reports clipboard success and failure", async () => {
    const writeText = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const container = await renderInspector(failed.id);
    const copy = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Copy",
    )!;
    await act(async () => {
      copy.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("Branch copied");
    await act(async () => {
      copy.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("could not be copied");
  });

  test("appends later transcript pages at the original watermark", async () => {
    vi.mocked(client.loadTranscript)
      .mockResolvedValueOnce({
        items: [
          {
            sequence: 1,
            attemptId: failed.id,
            timestamp: now,
            role: "agent",
            text: "First transcript page",
            truncated: false,
          },
        ],
        watermark: "transcript-fixed",
        nextCursor: 1,
      })
      .mockResolvedValueOnce({
        items: [
          {
            sequence: 2,
            attemptId: failed.id,
            timestamp: now,
            role: "agent",
            text: "Second transcript page",
            truncated: false,
          },
        ],
        watermark: "transcript-fixed",
        nextCursor: null,
      });
    const container = await renderInspector(failed.id);
    const more = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Load more transcript",
    )!;
    await act(async () => {
      more.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(client.loadTranscript).toHaveBeenLastCalledWith(
      failed.id,
      8,
      1,
      "transcript-fixed",
    );
    expect(container.textContent).toContain("First transcript page");
    expect(container.textContent).toContain("Second transcript page");
  });

  test("keeps the point-in-time transcript across current-state refresh", async () => {
    vi.mocked(client.loadTranscript)
      .mockResolvedValueOnce({
        items: [
          {
            sequence: 1,
            attemptId: failed.id,
            timestamp: now,
            role: "agent",
            text: "Fixed first transcript page",
            truncated: false,
          },
        ],
        watermark: "transcript-fixed",
        nextCursor: 1,
      })
      .mockResolvedValueOnce({
        items: [
          {
            sequence: 2,
            attemptId: failed.id,
            timestamp: now,
            role: "agent",
            text: "Fixed second transcript page",
            truncated: false,
          },
        ],
        watermark: "transcript-fixed",
        nextCursor: null,
      });
    const container = await renderInspector(failed.id);
    const more = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Load more transcript",
    )!;
    await act(async () => {
      more.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(client.loadTranscript).toHaveBeenCalledTimes(2);

    vi.mocked(client.loadAttempt).mockResolvedValue({
      ...completed,
      id: failed.id,
    });
    await act(async () => {
      root.render(
        <AttemptInspector
          selectedAttemptId={failed.id}
          controlsDisabled={false}
          refreshVersion={1}
          onSelect={() => {}}
          onChanged={() => {}}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(client.loadTranscript).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Fixed first transcript page");
    expect(container.textContent).toContain("Fixed second transcript page");
    expect(container.textContent).toContain("Archive");
  });

  test("clears a sibling-page error after a successful retry", async () => {
    let continuationCalls = 0;
    vi.mocked(client.listAttempts).mockImplementation(async (request) => {
      if (!request.issueNodeId) {
        return { items: [failed], watermark: "attempts-1", nextCursor: null };
      }
      if (request.cursor === 2) {
        continuationCalls += 1;
        if (continuationCalls === 1) {
          throw new Error("sibling page unavailable");
        }
        return {
          items: [archived],
          watermark: "siblings-fixed",
          nextCursor: null,
        };
      }
      return {
        items: [failed, completed],
        watermark: "siblings-fixed",
        nextCursor: 2,
      };
    });
    const container = await renderInspector(failed.id);
    const more = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Load more attempts",
    )!;
    await act(async () => {
      more.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).toContain("sibling page unavailable");
    await act(async () => {
      more.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).not.toContain("sibling page unavailable");
    expect(container.querySelectorAll(".sibling-list button")).toHaveLength(3);
  });

  test("appends later event pages at the original watermark", async () => {
    vi.mocked(client.loadEvents)
      .mockResolvedValueOnce({
        items: [
          {
            sequence: 1,
            assignmentId: failed.id,
            timestamp: now,
            type: "assignment.running",
            detail: {},
          },
        ],
        watermark: "events-fixed",
        nextCursor: 1,
      })
      .mockResolvedValueOnce({
        items: [
          {
            sequence: 2,
            assignmentId: failed.id,
            timestamp: now,
            type: "assignment.failed",
            detail: { code: "provider_failed" },
          },
        ],
        watermark: "events-fixed",
        nextCursor: null,
      });
    const container = await renderInspector(failed.id);
    const more = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Load more events",
    )!;
    await act(async () => {
      more.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(client.loadEvents).toHaveBeenLastCalledWith(
      failed.id,
      8,
      1,
      "events-fixed",
    );
    expect(container.textContent).toContain("assignment.running");
    expect(container.textContent).toContain("assignment.failed");
  });

  test("reports evidence pagination failures without discarding the page", async () => {
    vi.mocked(client.loadTranscript)
      .mockResolvedValueOnce({
        items: [
          {
            sequence: 1,
            attemptId: failed.id,
            timestamp: now,
            role: "agent",
            text: "First transcript page",
            truncated: false,
          },
        ],
        watermark: "transcript-fixed",
        nextCursor: 1,
      })
      .mockRejectedValueOnce(new Error("transcript page unavailable"));
    vi.mocked(client.loadEvents)
      .mockResolvedValueOnce({
        items: [
          {
            sequence: 1,
            assignmentId: failed.id,
            timestamp: now,
            type: "assignment.running",
            detail: {},
          },
        ],
        watermark: "events-fixed",
        nextCursor: 1,
      })
      .mockResolvedValueOnce({
        items: [
          {
            sequence: 2,
            assignmentId: failed.id,
            timestamp: now,
            type: "assignment.failed",
            detail: {},
          },
        ],
        watermark: "events-fixed",
        nextCursor: null,
      });
    const container = await renderInspector(failed.id);
    const more = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Load more transcript",
    )!;
    await act(async () => {
      more.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).toContain("transcript page unavailable");
    expect(container.textContent).toContain("First transcript page");
    expect(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent === "Load more transcript",
      ),
    ).toBe(true);
    const moreEvents = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Load more events",
    )!;
    await act(async () => {
      moreEvents.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).toContain("transcript page unavailable");
    expect(container.textContent).toContain("assignment.failed");
  });
});
