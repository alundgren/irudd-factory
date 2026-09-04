import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AttemptUsage,
  FactorySnapshot,
  TimelinePage,
} from "@irudd-factory/contracts";
import { listTimeline, loadSnapshot, loadUsage } from "./client.ts";
import { loadErrorMessage, stateLabel, tokenTotal } from "./view-model.ts";
import { layoutTimeline } from "./timeline-layout.ts";
import AttemptInspector from "./AttemptInspector.tsx";

const TIMELINE_PAGE_SIZE = 12;

interface TimelineRequest {
  readonly cursor?: number;
  readonly watermark?: string;
}

interface TimelineHistoryEntry {
  readonly page: TimelinePage;
  readonly request: TimelineRequest;
  readonly snapshot: FactorySnapshot | null;
  readonly usage: ReadonlyArray<AttemptUsage>;
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact" }).format(
    value,
  );
}

function utcTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
}

function attemptGlyph(assignment: TimelinePage["items"][number]): string {
  if (assignment.archivedAt !== null) return "◇";
  if (assignment.state === "completed") return "✓";
  if (assignment.state === "failed") return "!";
  if (assignment.state === "interrupted") return "×";
  if (assignment.state === "stopped") return "■";
  if (assignment.state === "stop_uncertain") return "?";
  return "●";
}

function TimelineCard({
  item,
  usage,
  onOpen,
}: {
  item: ReturnType<typeof layoutTimeline>["items"][number];
  usage: ReadonlyArray<AttemptUsage>;
  onOpen: (attemptId: string) => void;
}) {
  const { assignment } = item;
  const tokens = tokenTotal(assignment.id, usage);
  const archived = assignment.archivedAt !== null;
  const point = item.widthPercent < 8;
  const details = `${assignment.issue.repository} #${assignment.issue.number}, ${stateLabel(assignment.state)}${archived ? ", archived" : ""}`;
  const glyph = attemptGlyph(assignment);
  const top = `calc(${item.displaySlot} * 7.25rem + 3.4rem)`;
  if (point) {
    return (
      <div
        className={`timeline-point timeline-card-${assignment.state}${archived ? " timeline-card-archived" : ""}`}
        style={{ left: `${item.leftPercent}%`, top }}
      >
        <button
          className="timeline-point-marker"
          data-attempt-id={assignment.id}
          title={`Open ${details}`}
          aria-label={`Open ${details}`}
          onClick={() => onOpen(assignment.id)}
        >
          <span aria-hidden="true">{glyph}</span>
        </button>
        <span
          className={`timeline-point-copy timeline-point-copy-${item.labelSide}`}
        >
          <strong>
            {assignment.issue.repository} #{assignment.issue.number}
          </strong>
          <small>
            {stateLabel(assignment.state)}
            {archived ? " · Archived" : ""}
          </small>
        </span>
      </div>
    );
  }
  return (
    <button
      className={`timeline-card timeline-card-${assignment.state}${archived ? " timeline-card-archived" : ""}`}
      style={{
        left: `${item.leftPercent}%`,
        width: `${item.widthPercent}%`,
        top,
      }}
      data-attempt-id={assignment.id}
      aria-label={`Open ${assignment.issue.repository} issue ${assignment.issue.number}, ${stateLabel(assignment.state)}${archived ? ", archived" : ""}`}
      onClick={() => onOpen(assignment.id)}
    >
      <span className="timeline-card-title">{assignment.issue.title}</span>
      <span className="timeline-card-repository">
        {assignment.issue.repository} #{assignment.issue.number}
      </span>
      <span className="timeline-card-status">
        <span aria-hidden="true">{glyph}</span>
        {stateLabel(assignment.state)}
        {archived ? " · Archived" : ""}
      </span>
      <span className="timeline-card-model">
        {assignment.observedModel ?? assignment.requestedModel} ·{" "}
        {assignment.observedEffort ?? assignment.requestedEffort}
      </span>
      <span className="timeline-card-tokens">
        {tokens === null ? "Tokens unknown" : `${compactNumber(tokens)} tokens`}
      </span>
    </button>
  );
}

export default function Timeline() {
  const [page, setPage] = useState<TimelinePage | null>(null);
  const [history, setHistory] = useState<ReadonlyArray<TimelineHistoryEntry>>(
    [],
  );
  const [snapshot, setSnapshot] = useState<FactorySnapshot | null>(null);
  const [usage, setUsage] = useState<ReadonlyArray<AttemptUsage>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedAttemptId, setSelectedAttemptId] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get("attempt"),
  );
  const request = useRef<TimelineRequest>({});

  const selectAttempt = useCallback((attemptId: string | null) => {
    setSelectedAttemptId(attemptId);
    const url = new URL(window.location.href);
    if (attemptId) url.searchParams.set("attempt", attemptId);
    else url.searchParams.delete("attempt");
    window.history.replaceState(null, "", url);
  }, []);

  const loadPage = useCallback(async (nextRequest: TimelineRequest) => {
    setLoading(true);
    setError(null);
    try {
      const [nextPage, nextSnapshot] = await Promise.all([
        listTimeline({
          limit: TIMELINE_PAGE_SIZE,
          ...(nextRequest.cursor !== undefined
            ? { cursor: nextRequest.cursor }
            : {}),
          ...(nextRequest.watermark
            ? { watermark: nextRequest.watermark }
            : {}),
        }),
        loadSnapshot(),
      ]);
      const usagePages = await Promise.all(
        nextPage.items.map((assignment) => loadUsage(assignment.id)),
      );
      setPage(nextPage);
      setSnapshot(nextSnapshot);
      setUsage(usagePages.flatMap(({ items }) => items));
      return true;
    } catch (loadError) {
      setError(loadErrorMessage(loadError));
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshAfterChange = useCallback(async () => {
    request.current = {};
    setHistory([]);
    await loadPage({});
  }, [loadPage]);

  useEffect(() => {
    void loadPage(request.current);
  }, [loadPage]);

  const now = page?.readAt ?? new Date().toISOString();
  const slots = snapshot?.configuration?.codexSlots ?? 1;
  const layout = useMemo(
    () => layoutTimeline(page?.items ?? [], now, slots),
    [page, now, slots],
  );
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => ({
    fraction,
    value:
      layout.windowStartMs +
      (layout.windowEndMs - layout.windowStartMs) * fraction,
  }));

  async function nextPage() {
    if (page?.nextCursor === null || page?.nextCursor === undefined) return;
    const nextRequest = { cursor: page.nextCursor, watermark: page.watermark };
    const previous = {
      page,
      snapshot,
      usage,
      request: {
        cursor: request.current.cursor ?? 0,
        watermark: request.current.watermark ?? page.watermark,
      },
    };
    const loaded = await loadPage(nextRequest);
    if (!loaded) return;
    setHistory((current) => [...current, previous]);
    request.current = nextRequest;
  }

  function previousPage() {
    const previous = history.at(-1);
    if (!previous) return;
    request.current = previous.request;
    setPage(previous.page);
    setSnapshot(previous.snapshot);
    setUsage(previous.usage);
    setHistory((current) => current.slice(0, -1));
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Factory overview">
          <span>F</span>Factory
        </a>
        <nav aria-label="Main navigation">
          <a href="/">
            <span aria-hidden="true">▦</span>Overview
          </a>
          <a className="nav-current" href="/?view=timeline">
            <span aria-hidden="true">↔</span>Timeline
          </a>
        </nav>
        <div
          className={`connection ${error ? "connection-error" : ""}`}
          role="status"
        >
          <span className="dot" aria-hidden="true" />
          <div>
            {error ? "Service disconnected" : "Point-in-time timeline"}
            <small>
              {error ? "Timeline could not be loaded" : "Bounded retained data"}
            </small>
          </div>
        </div>
      </aside>
      <main className="timeline-main">
        <header className="topbar timeline-topbar">
          <div>
            <p className="eyebrow">Retained attempts</p>
            <h1>Codex timeline</h1>
            <p>
              Compare when attempts ran and open one for its retained details.
            </p>
          </div>
          <p className="timeline-zone">Times shown in UTC</p>
        </header>

        {loading && !page ? (
          <p className="loading-state" aria-live="polite">
            Loading timeline...
          </p>
        ) : null}
        {error ? (
          <section className="load-failed" role="alert">
            <h2>Timeline is unavailable</h2>
            <p>{error}</p>
            <button onClick={() => void loadPage(request.current)}>
              Try again
            </button>
          </section>
        ) : null}
        {!loading && !error && page?.items.length === 0 ? (
          <section className="timeline-empty">
            <h2>No retained attempts</h2>
            <p>Codex attempts will appear here after Factory reserves work.</p>
          </section>
        ) : null}

        {page && page.items.length > 0 ? (
          <section aria-label="Codex attempt timeline">
            <div className="timeline-lane">
              <div className="timeline-provider">
                <strong>Codex</strong>
                <span>
                  {slots} configured {slots === 1 ? "slot" : "slots"}
                </span>
              </div>
              <div
                className="timeline-scroll"
                tabIndex={0}
                aria-label="Codex time board, scroll horizontally"
              >
                <div
                  className="timeline-board"
                  style={{
                    height: `calc(${layout.slotCount} * 7.25rem + 3.4rem)`,
                  }}
                >
                  <div className="timeline-axis" aria-hidden="true">
                    {ticks.map(({ fraction, value }) => (
                      <span
                        key={fraction}
                        style={{ left: `${fraction * 100}%` }}
                      >
                        {utcTime(value)}
                      </span>
                    ))}
                  </div>
                  <div className="timeline-grid" aria-hidden="true">
                    {ticks.map(({ fraction }) => (
                      <span
                        key={fraction}
                        style={{ left: `${fraction * 100}%` }}
                      />
                    ))}
                  </div>
                  {layout.items.map((item) => (
                    <TimelineCard
                      key={item.assignment.id}
                      item={item}
                      usage={usage}
                      onOpen={selectAttempt}
                    />
                  ))}
                </div>
              </div>
            </div>
            <div className="pagination" aria-label="Timeline pages">
              <button
                className="text-action"
                disabled={history.length === 0 || loading}
                onClick={previousPage}
              >
                Previous
              </button>
              <span>Page {history.length + 1}</span>
              <button
                className="text-action"
                disabled={page.nextCursor === null || loading}
                onClick={() => void nextPage()}
              >
                Next
              </button>
            </div>
          </section>
        ) : null}
        <AttemptInspector
          selectedAttemptId={selectedAttemptId}
          controlsDisabled={Boolean(error)}
          refreshVersion={0}
          onSelect={selectAttempt}
          onChanged={refreshAfterChange}
        />
      </main>
    </div>
  );
}
