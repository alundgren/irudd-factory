import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Assignment,
  AttemptUsage,
  CommandReceipt,
  FactorySnapshot,
  OperationsOverview,
  QueueEntry,
  QueuePage,
} from "@irudd-factory/contracts";
import {
  listQueue,
  loadOperationsOverview,
  loadSnapshot,
  setCodexEnabled,
  setDispatchPaused,
  startIssue,
} from "./client.ts";
import {
  capacityIsUncertain,
  commandPhaseLabel,
  commandErrorKind,
  loadErrorMessage,
  lifecycleCommandPhase,
  occupiedCapacity,
  queueStatus,
  stateLabel,
  tokenTotal,
  type CommandPhase,
} from "./view-model.ts";
import AttemptInspector from "./AttemptInspector.tsx";

const QUEUE_PAGE_SIZE = 6;
const REFRESH_INTERVAL_MS = 5_000;
const DELAY_NOTICE_MS = 1_500;

const emptySnapshot: FactorySnapshot = {
  receipt: null,
  assignment: null,
  events: [],
};

interface CommandNotice {
  readonly id?: string;
  readonly phase: CommandPhase;
  readonly action: string;
  readonly message: string;
}

interface QueueRequest {
  readonly cursor?: string;
  readonly watermark?: string;
}

interface QueueHistoryEntry {
  readonly page: QueuePage;
  readonly request: QueueRequest;
}

function sameQueueRequest(left: QueueRequest, right: QueueRequest): boolean {
  return left.cursor === right.cursor && left.watermark === right.watermark;
}

function nextCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

function elapsed(value: string): string {
  const milliseconds = Date.now() - new Date(value).valueOf();
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "Unknown";
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return "Less than a minute";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact" }).format(
    value,
  );
}

function receiptMessage(receipt: CommandReceipt): string {
  switch (receipt.result._tag) {
    case "started":
      return `${receipt.result.assignment.issue.repository}#${receipt.result.assignment.issue.number} was reserved.`;
    case "provider_busy":
      return "No assignment was created because every Codex slot is occupied.";
    case "no_candidate":
      return "No eligible issue was available when the command ran.";
    case "selection_ambiguous":
      return "Factory rejected the command because issue selection was ambiguous.";
  }
}

function ActiveAttempt({
  assignment,
  usage,
  onOpen,
}: {
  assignment: Assignment;
  usage: ReadonlyArray<AttemptUsage>;
  onOpen: (attemptId: string) => void;
}) {
  const tokens = tokenTotal(assignment.id, usage);
  return (
    <article className="attempt-row">
      <div className="attempt-main">
        <button
          className="issue-title issue-title-button"
          data-attempt-id={assignment.id}
          onClick={() => onOpen(assignment.id)}
        >
          {assignment.issue.title}
        </button>
        <span className="meta">
          {assignment.issue.repository} #{assignment.issue.number}
        </span>
      </div>
      <div className={`status status-${assignment.state}`}>
        <span className="dot" aria-hidden="true" />
        {stateLabel(assignment.state)}
      </div>
      <div className="model">
        {assignment.observedModel ?? assignment.requestedModel}
        <span>
          {assignment.observedEffort ?? assignment.requestedEffort} effort
        </span>
      </div>
      <div className="attempt-numbers">
        <strong>
          {tokens === null
            ? "Tokens unknown"
            : `${compactNumber(tokens)} tokens`}
        </strong>
        <span>{elapsed(assignment.createdAt)} elapsed</span>
      </div>
    </article>
  );
}

function QueueRow({
  entry,
  pending,
  controlsBusy,
  capacityAvailable,
  onStart,
}: {
  entry: QueueEntry;
  pending: boolean;
  controlsBusy: boolean;
  capacityAvailable: boolean;
  onStart: (entry: QueueEntry) => void;
}) {
  return (
    <article className="queue-row">
      <span className="queue-number">#{entry.issue.number}</span>
      <div className="queue-main">
        <a href={entry.issue.url}>{entry.issue.title}</a>
        <span>{entry.issue.repository}</span>
      </div>
      <div className="queue-age">
        <span>Eligible {elapsed(entry.eligibleSince)}</span>
        <small className={entry.startable ? "ready" : "blocked"}>
          {queueStatus(entry)}
        </small>
      </div>
      <button
        className="secondary-action"
        disabled={!entry.startable || !capacityAvailable || controlsBusy}
        onClick={() => onStart(entry)}
      >
        {pending ? "Starting..." : "Start now"}
      </button>
    </article>
  );
}

export default function App() {
  const [snapshot, setSnapshot] = useState<FactorySnapshot>(emptySnapshot);
  const [usage, setUsage] = useState<ReadonlyArray<AttemptUsage>>([]);
  const [activity, setActivity] = useState<ReadonlyArray<Assignment>>([]);
  const [lifecycleCommands, setLifecycleCommands] = useState<
    OperationsOverview["lifecycleCommands"]
  >([]);
  const [queue, setQueue] = useState<QueuePage | null>(null);
  const [queueHistory, setQueueHistory] = useState<
    ReadonlyArray<QueueHistoryEntry>
  >([]);
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [delayedRefresh, setDelayedRefresh] = useState<number | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const [pending, setPending] = useState<string | null>(null);
  const [notices, setNotices] = useState<ReadonlyArray<CommandNotice>>([]);
  const [selectedAttemptId, setSelectedAttemptId] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get("attempt"),
  );
  const mounted = useRef(true);
  const queueRequest = useRef<QueueRequest>({});
  const refreshGeneration = useRef(0);
  const refreshDelayed = delayedRefresh !== null;

  const selectAttempt = useCallback((attemptId: string | null) => {
    setSelectedAttemptId(attemptId);
    const url = new URL(window.location.href);
    if (attemptId) url.searchParams.set("attempt", attemptId);
    else url.searchParams.delete("attempt");
    window.history.replaceState(null, "", url);
  }, []);

  const refresh = useCallback(async (initial = false) => {
    const generation = refreshGeneration.current + 1;
    refreshGeneration.current = generation;
    setDelayedRefresh(null);
    if (initial) setLoading(true);
    const delayed = window.setTimeout(() => {
      if (mounted.current && refreshGeneration.current === generation) {
        setDelayedRefresh(generation);
      }
    }, DELAY_NOTICE_MS);
    try {
      const request = { ...queueRequest.current };
      const [nextSnapshot, overview, nextQueue] = await Promise.all([
        loadSnapshot(),
        loadOperationsOverview(),
        listQueue(QUEUE_PAGE_SIZE, request.cursor, request.watermark),
      ]);
      if (!mounted.current || refreshGeneration.current !== generation) return;
      setSnapshot(nextSnapshot);
      setHasLoaded(true);
      setUsage(overview.usage);
      setActivity(overview.recentActivity);
      if (sameQueueRequest(request, queueRequest.current)) {
        setQueue(nextQueue);
      }
      setLifecycleCommands(overview.lifecycleCommands);
      setDataVersion((version) => version + 1);
      if (initial) setQueueHistory([]);
      setLoadError(null);
    } catch (error) {
      if (mounted.current && refreshGeneration.current === generation) {
        setLoadError(loadErrorMessage(error));
      }
    } finally {
      window.clearTimeout(delayed);
      if (mounted.current) {
        setDelayedRefresh((current) =>
          current === generation ? null : current,
        );
        if (initial) setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh(true);
    const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const assignmentsKnown = snapshot.assignments !== undefined;
  const assignments = snapshot.assignments ?? [];
  const slots = snapshot.configuration?.codexSlots ?? null;
  const occupied = assignmentsKnown ? occupiedCapacity(assignments) : null;
  const uncertain = assignmentsKnown ? capacityIsUncertain(assignments) : null;
  const capacityAvailable =
    occupied !== null &&
    slots !== null &&
    occupied < slots &&
    uncertain === false &&
    snapshot.dispatch?.codexEnabled === true &&
    snapshot.dispatch.paused === false &&
    !loadError;

  const activeTokens = useMemo(
    () =>
      assignmentsKnown
        ? assignments.reduce<number | null>((total, assignment) => {
            const current = tokenTotal(assignment.id, usage);
            return total === null || current === null ? null : total + current;
          }, 0)
        : null,
    [assignments, assignmentsKnown, usage],
  );

  function addNotice(notice: CommandNotice) {
    setNotices((current) => [notice, ...current].slice(0, 5));
  }

  async function runCommand(
    key: string,
    action: string,
    execute: (
      commandId?: string,
    ) => Promise<CommandReceipt | FactorySnapshot["dispatch"]>,
    usesCommandId = false,
  ) {
    const id = usesCommandId ? nextCommandId() : undefined;
    setPending(key);
    let result: CommandReceipt | FactorySnapshot["dispatch"];
    try {
      result = await execute(id);
    } catch (error) {
      const kind = commandErrorKind(error);
      addNotice({
        ...(id ? { id } : {}),
        phase: kind,
        action,
        message:
          kind === "rejected"
            ? String(error)
            : key.startsWith("start:")
              ? `The service result could not be read. Check activity before starting again. Unresolved command ${id}.`
              : "The service result could not be read. Refresh state before retrying.",
      });
      setPending(null);
      return;
    }

    const message =
      result && "result" in result
        ? receiptMessage(result)
        : `${action} completed.`;
    addNotice({
      ...(result && "result" in result
        ? { id: result.commandId }
        : id
          ? { id }
          : {}),
      phase:
        result && "result" in result && result.result._tag !== "started"
          ? "rejected"
          : "final",
      action,
      message,
    });
    if (result && !("result" in result)) {
      setSnapshot((current) => ({ ...current, dispatch: result }));
    }
    if (key.startsWith("start:")) {
      queueRequest.current = {};
      setQueueHistory([]);
    }
    setPending(null);
    await refresh();
  }

  function start(entry: QueueEntry) {
    const key = `start:${entry.tenureId}`;
    void runCommand(
      key,
      `Start ${entry.issue.repository}#${entry.issue.number}`,
      (commandId) =>
        startIssue(commandId!, entry.issue.repository, entry.issue.number),
      true,
    );
  }

  async function nextQueuePage() {
    if (!queue?.nextCursor) return;
    setPending("queue-next");
    try {
      const request = {
        cursor: queue.nextCursor,
        watermark: queue.watermark,
      };
      const next = await listQueue(
        QUEUE_PAGE_SIZE,
        request.cursor,
        request.watermark,
      );
      setQueueHistory((history) => [
        ...history,
        { page: queue, request: queueRequest.current },
      ]);
      queueRequest.current = request;
      setQueue(next);
    } catch (error) {
      setLoadError(loadErrorMessage(error));
    } finally {
      setPending(null);
    }
  }

  function previousQueuePage() {
    const previous = queueHistory.at(-1);
    if (!previous) return;
    queueRequest.current = previous.request;
    setQueue(previous.page);
    setQueueHistory((history) => history.slice(0, -1));
  }

  const connectionLabel = loadError
    ? "Service disconnected"
    : refreshDelayed
      ? "Refresh delayed"
      : hasLoaded
        ? "Service connected"
        : "Connecting";

  const recoveredReceipt: ReadonlyArray<CommandNotice> = snapshot.receipt
    ? [
        {
          id: snapshot.receipt.commandId,
          phase:
            snapshot.receipt.result._tag === "started" ? "final" : "rejected",
          action:
            snapshot.receipt.result._tag === "started"
              ? `Start ${snapshot.receipt.result.assignment.issue.repository}#${snapshot.receipt.result.assignment.issue.number}`
              : "Start queued work",
          message: receiptMessage(snapshot.receipt),
        },
      ]
    : [];
  const commandNotices: ReadonlyArray<CommandNotice> = [
    ...recoveredReceipt,
    ...notices,
    ...lifecycleCommands.map((command) => ({
      id: command.commandId,
      phase: lifecycleCommandPhase(command),
      action: `${command.kind} ${command.targetAttemptId}`,
      message:
        command.phase === "final"
          ? command.consequence?._tag === "rejected"
            ? command.consequence.message
            : "The durable command reached its final state."
          : command.effect,
    })),
  ]
    .filter(
      (notice, index, entries) =>
        !notice.id ||
        entries.findIndex((entry) => entry.id === notice.id) === index,
    )
    .slice(0, 5);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Factory overview">
          <span>F</span>
          Factory
        </a>
        <nav aria-label="Main navigation">
          <a className="nav-current" href="/">
            <span aria-hidden="true">▦</span>
            Overview
          </a>
        </nav>
        <div
          className={`connection ${loadError ? "connection-error" : refreshDelayed ? "connection-delayed" : ""}`}
          role="status"
        >
          <span className="dot" aria-hidden="true" />
          <div>
            {connectionLabel}
            <small>
              {loadError
                ? "Showing the last loaded state"
                : "Updates every 5 seconds"}
            </small>
          </div>
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div>
            <p className="eyebrow">Operations</p>
            <h1>Factory overview</h1>
            <p>
              {assignmentsKnown
                ? `${assignments.length} active ${assignments.length === 1 ? "attempt" : "attempts"}`
                : "Active attempts unknown"}
              . {queue?.items.length ?? 0} shown in the ready queue.
            </p>
          </div>
          <div className="dispatch-control">
            <div
              className={
                !snapshot.dispatch || snapshot.dispatch.paused
                  ? "paused"
                  : "running"
              }
            >
              <span className="dot" aria-hidden="true" />
              {!snapshot.dispatch
                ? "Status unknown"
                : snapshot.dispatch.paused
                  ? "Dispatch paused"
                  : "Dispatching"}
            </div>
            <button
              className="secondary-action"
              disabled={
                pending !== null || !snapshot.dispatch || Boolean(loadError)
              }
              onClick={() =>
                void runCommand(
                  "dispatch",
                  snapshot.dispatch?.paused
                    ? "Resume dispatch"
                    : "Pause dispatch",
                  () => setDispatchPaused(!snapshot.dispatch?.paused),
                )
              }
            >
              {!snapshot.dispatch
                ? "Unavailable"
                : snapshot.dispatch.paused
                  ? "Resume"
                  : "Pause"}
            </button>
          </div>
        </header>

        {loadError && !hasLoaded ? (
          <section className="load-failed" role="alert">
            <p className="eyebrow">Service disconnected</p>
            <h2>Factory state is unavailable</h2>
            <pre>{loadError}</pre>
            <button onClick={() => void refresh(true)}>Try again</button>
          </section>
        ) : loading ? (
          <section className="loading-state" aria-live="polite">
            Loading operations...
          </section>
        ) : (
          <div className="overview-grid">
            <div className="primary-column">
              {loadError ? (
                <div className="stale-note" role="alert">
                  <strong>Service disconnected.</strong> Controls are
                  unavailable and the last loaded state remains below.
                </div>
              ) : refreshDelayed ? (
                <div className="delay-note" role="status">
                  Refresh is taking longer than usual. Displayed values may be
                  out of date.
                </div>
              ) : null}

              <section aria-labelledby="active-heading">
                <div className="section-heading">
                  <h2 id="active-heading">
                    Working now{" "}
                    <span>{assignmentsKnown ? assignments.length : "?"}</span>
                  </h2>
                  <small>
                    {activeTokens === null
                      ? "Known token total unavailable"
                      : `${compactNumber(activeTokens)} known tokens`}
                  </small>
                </div>
                <div className="attempt-list">
                  {!assignmentsKnown ? (
                    <p className="empty-state">
                      Active attempts are unavailable in this service response.
                    </p>
                  ) : assignments.length === 0 ? (
                    <p className="empty-state">
                      No active attempts. Start ready work below or leave
                      automatic dispatch running.
                    </p>
                  ) : (
                    assignments.map((assignment) => (
                      <ActiveAttempt
                        key={assignment.id}
                        assignment={assignment}
                        usage={usage}
                        onOpen={selectAttempt}
                      />
                    ))
                  )}
                </div>
              </section>

              <AttemptInspector
                selectedAttemptId={selectedAttemptId}
                controlsDisabled={Boolean(loadError) || refreshDelayed}
                refreshVersion={dataVersion}
                onSelect={selectAttempt}
                onChanged={() => refresh()}
              />

              <section aria-labelledby="queue-heading">
                <div className="section-heading">
                  <h2 id="queue-heading">
                    Ready queue <span>{queue?.items.length ?? 0}</span>
                  </h2>
                  <small>Stable FIFO eligibility order</small>
                </div>
                <div className="queue-list">
                  {!queue || queue.items.length === 0 ? (
                    <p className="empty-state">No retained queue entries.</p>
                  ) : (
                    queue.items.map((entry) => (
                      <QueueRow
                        key={entry.tenureId}
                        entry={entry}
                        pending={pending === `start:${entry.tenureId}`}
                        controlsBusy={pending !== null}
                        capacityAvailable={capacityAvailable && !loadError}
                        onStart={start}
                      />
                    ))
                  )}
                </div>
                <div className="pagination" aria-label="Ready queue pages">
                  <button
                    className="text-action"
                    disabled={queueHistory.length === 0 || pending !== null}
                    onClick={previousQueuePage}
                  >
                    Previous
                  </button>
                  <span>Page {queueHistory.length + 1}</span>
                  <button
                    className="text-action"
                    disabled={!queue?.nextCursor || pending !== null}
                    onClick={() => void nextQueuePage()}
                  >
                    Next
                  </button>
                </div>
              </section>
            </div>

            <aside className="detail-column">
              <section className="capacity" aria-labelledby="capacity-heading">
                <div className="section-heading">
                  <h2 id="capacity-heading">Codex capacity</h2>
                </div>
                <p className="capacity-count">
                  {occupied !== null && slots !== null ? (
                    <>
                      <strong>{occupied}</strong> of {slots} slots occupied
                    </>
                  ) : occupied !== null ? (
                    <>
                      <strong>{occupied}</strong> occupied · configured slots
                      unknown
                    </>
                  ) : slots !== null ? (
                    <>Occupancy unknown · {slots} slots configured</>
                  ) : (
                    <>Capacity unknown</>
                  )}
                </p>
                {uncertain === true ? (
                  <p className="warning-text">
                    Capacity is uncertain until Factory confirms provider
                    ownership.
                  </p>
                ) : null}
                <dl className="compact-facts">
                  <div>
                    <dt>Provider</dt>
                    <dd>
                      {!snapshot.dispatch
                        ? "Unknown"
                        : snapshot.dispatch.codexEnabled
                          ? "Enabled"
                          : "Disabled"}
                    </dd>
                  </div>
                  <div>
                    <dt>Dispatch</dt>
                    <dd>
                      {!snapshot.dispatch
                        ? "Unknown"
                        : snapshot.dispatch.paused
                          ? "Paused"
                          : "Running"}
                    </dd>
                  </div>
                </dl>
                <button
                  className={
                    snapshot.dispatch?.codexEnabled
                      ? "danger-action"
                      : "secondary-action"
                  }
                  disabled={
                    pending !== null || !snapshot.dispatch || Boolean(loadError)
                  }
                  onClick={() =>
                    void runCommand(
                      "codex",
                      snapshot.dispatch?.codexEnabled
                        ? "Disable Codex"
                        : "Enable Codex",
                      () => setCodexEnabled(!snapshot.dispatch?.codexEnabled),
                    )
                  }
                >
                  {snapshot.dispatch?.codexEnabled
                    ? "Disable Codex"
                    : "Enable Codex"}
                </button>
              </section>

              <section aria-labelledby="activity-heading">
                <div className="section-heading">
                  <h2 id="activity-heading">Recent activity</h2>
                </div>
                <ol className="activity-list">
                  {activity.length === 0 ? (
                    <li className="empty-activity">No retained activity.</li>
                  ) : (
                    activity.map((attempt) => (
                      <li key={attempt.id}>
                        <span
                          className={`activity-dot status-${attempt.state}`}
                          aria-hidden="true"
                        />
                        <div>
                          <button
                            className="activity-attempt"
                            data-attempt-id={attempt.id}
                            onClick={() => selectAttempt(attempt.id)}
                          >
                            {attempt.issue.repository}#{attempt.issue.number}
                          </button>{" "}
                          {stateLabel(attempt.state).toLowerCase()}
                          <time dateTime={attempt.updatedAt}>
                            {formatTime(attempt.updatedAt)}
                          </time>
                          {attempt.error ? (
                            <details className="activity-error">
                              <summary>View failure details</summary>
                              <pre>{attempt.error.message}</pre>
                            </details>
                          ) : null}
                        </div>
                      </li>
                    ))
                  )}
                </ol>
              </section>

              <section aria-labelledby="configuration-heading">
                <div className="section-heading">
                  <h2 id="configuration-heading">Effective configuration</h2>
                </div>
                <dl className="configuration-list">
                  {snapshot.configuration?.repositories.map((entry) => (
                    <div key={entry.repository}>
                      <dt>{entry.repository}</dt>
                      <dd>
                        {entry.codex.model} · {entry.codex.reasoningEffort}
                      </dd>
                    </div>
                  ))}
                  <div>
                    <dt>Codex slots</dt>
                    <dd>{slots ?? "Unknown"}</dd>
                  </div>
                  <div>
                    <dt>Polling</dt>
                    <dd>
                      {snapshot.configuration
                        ? `${snapshot.configuration.pollIntervalMs / 1_000}s`
                        : "Unknown"}
                    </dd>
                  </div>
                  <div>
                    <dt>Access</dt>
                    <dd>{snapshot.configuration?.access ?? "Unknown"}</dd>
                  </div>
                </dl>
              </section>

              {commandNotices.length > 0 ? (
                <section aria-labelledby="commands-heading">
                  <div className="section-heading">
                    <h2 id="commands-heading">Control results</h2>
                  </div>
                  <ol className="command-list" aria-live="polite">
                    {commandNotices.map((notice, index) => (
                      <li
                        key={notice.id ?? `${notice.action}-${index}`}
                        className={`command-${notice.phase}`}
                      >
                        <div>
                          <strong>{notice.action}</strong>
                          <span>{commandPhaseLabel(notice.phase)}</span>
                        </div>
                        <p>{notice.message}</p>
                        {notice.id ? <code>{notice.id}</code> : null}
                      </li>
                    ))}
                  </ol>
                </section>
              ) : null}
            </aside>
          </div>
        )}
      </main>
    </div>
  );
}
