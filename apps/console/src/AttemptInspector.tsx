import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Attempt,
  AttemptPage,
  AttemptUsage,
  EventPage,
  LifecycleCommand,
  LifecycleCommandKind,
  TranscriptPage,
} from "@irudd-factory/contracts";
import {
  controlAttempt,
  listAttempts,
  loadAttempt,
  loadEvents,
  loadLifecycleCommands,
  loadTranscript,
  loadUsage,
} from "./client.ts";
import {
  commandErrorKind,
  commandPhaseLabel,
  loadErrorMessage,
  stateLabel,
  type CommandPhase,
} from "./view-model.ts";

const ATTEMPT_PAGE_SIZE = 6;
const DETAIL_PAGE_SIZE = 8;
const SIBLING_LIMIT = 100;

interface AttemptInspectorProps {
  readonly selectedAttemptId: string | null;
  readonly controlsDisabled: boolean;
  readonly refreshVersion: number;
  readonly onSelect: (attemptId: string | null) => void;
  readonly onChanged: () => void | Promise<void>;
}

interface PagePosition {
  readonly cursor?: number;
  readonly watermark?: string;
}

interface CommandStatus {
  readonly id: string;
  readonly kind: LifecycleCommandKind;
  readonly phase: CommandPhase;
  readonly message: string;
}

function commandStatus(command: LifecycleCommand): CommandStatus {
  const rejected =
    command.admission._tag === "rejected" ||
    command.consequence?._tag === "rejected";
  const uncertain = command.consequence?._tag === "stop_uncertain";
  return {
    id: command.commandId,
    kind: command.kind,
    phase: rejected ? "rejected" : uncertain ? "uncertain" : command.phase,
    message:
      command.consequence?._tag === "rejected"
        ? command.consequence.message
        : command.admission._tag === "rejected"
          ? command.admission.message
          : uncertain
            ? "Factory could not confirm that the provider process stopped."
            : command.effect,
  };
}

function commandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

function tokenCount(attemptId: string, usage: ReadonlyArray<AttemptUsage>) {
  return (
    usage.find((entry) => entry.attemptId === attemptId)?.total.totalTokens ??
    null
  );
}

function processStatus(attempt: Attempt): string {
  if (attempt.state === "stop_uncertain") {
    return "Factory could not confirm that the provider process stopped.";
  }
  if (attempt.state === "ownership_uncertain") {
    return "Factory cannot prove whether this provider process still exists.";
  }
  if (attempt.processStartPending) {
    return "The process start was recorded, but its identity is not confirmed.";
  }
  return attempt.processGroupId
    ? `Process group ${attempt.processGroupId} was recorded.`
    : "No live process is recorded.";
}

function availableActions(
  attempt: Attempt,
): ReadonlyArray<LifecycleCommandKind> {
  const archived = Boolean(attempt.archivedAt);
  if (archived) {
    return ["completed", "failed", "interrupted", "stopped"].includes(
      attempt.state,
    )
      ? ["restore"]
      : [];
  }
  if (
    [
      "reserved",
      "starting",
      "running",
      "ownership_uncertain",
      "stop_uncertain",
    ].includes(attempt.state)
  ) {
    return ["stop"];
  }
  if (["failed", "interrupted", "stopped"].includes(attempt.state)) {
    return attempt.pullRequest ? ["archive"] : ["return", "restart", "archive"];
  }
  return attempt.state === "completed" ? ["archive"] : [];
}

function actionLabel(kind: LifecycleCommandKind): string {
  switch (kind) {
    case "stop":
      return "Stop attempt";
    case "return":
      return "Return issue";
    case "restart":
      return "Restart attempt";
    case "archive":
      return "Archive";
    case "restore":
      return "Restore";
  }
}

function needsConfirmation(kind: LifecycleCommandKind): boolean {
  return kind === "stop" || kind === "return" || kind === "restart";
}

export default function AttemptInspector({
  selectedAttemptId,
  controlsDisabled,
  refreshVersion,
  onSelect,
  onChanged,
}: AttemptInspectorProps) {
  const [includeArchived, setIncludeArchived] = useState(false);
  const [attemptPage, setAttemptPage] = useState<AttemptPage | null>(null);
  const [pageHistory, setPageHistory] = useState<ReadonlyArray<AttemptPage>>(
    [],
  );
  const [listError, setListError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [siblings, setSiblings] = useState<ReadonlyArray<Attempt>>([]);
  const [siblingPage, setSiblingPage] = useState<AttemptPage | null>(null);
  const [transcript, setTranscript] = useState<TranscriptPage | null>(null);
  const [events, setEvents] = useState<EventPage | null>(null);
  const [usage, setUsage] = useState<ReadonlyArray<AttemptUsage>>([]);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [siblingError, setSiblingError] = useState<string | null>(null);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [eventError, setEventError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [stateRefreshing, setStateRefreshing] = useState(false);
  const [confirmation, setConfirmation] = useState<LifecycleCommandKind | null>(
    null,
  );
  const [command, setCommand] = useState<CommandStatus | null>(null);
  const [commandSubmitting, setCommandSubmitting] = useState(false);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const detailGeneration = useRef(0);
  const stateRefreshGeneration = useRef(0);
  const listGeneration = useRef(0);
  const selectedAttemptIdRef = useRef(selectedAttemptId);
  const attemptRef = useRef(attempt);
  selectedAttemptIdRef.current = selectedAttemptId;
  attemptRef.current = attempt;

  const loadList = useCallback(
    async (position: PagePosition = {}, resetHistory = false) => {
      const generation = listGeneration.current + 1;
      listGeneration.current = generation;
      setListLoading(true);
      setListError(null);
      try {
        const page = await listAttempts({
          limit: ATTEMPT_PAGE_SIZE,
          includeArchived,
          ...(position.cursor !== undefined ? { cursor: position.cursor } : {}),
          ...(position.watermark ? { watermark: position.watermark } : {}),
        });
        if (listGeneration.current !== generation) return false;
        setAttemptPage(page);
        if (resetHistory) setPageHistory([]);
        return true;
      } catch (error) {
        if (listGeneration.current === generation) {
          setListError(loadErrorMessage(error));
        }
        return false;
      } finally {
        if (listGeneration.current === generation) setListLoading(false);
      }
    },
    [includeArchived],
  );

  const loadDetail = useCallback(async (attemptId: string) => {
    const generation = detailGeneration.current + 1;
    detailGeneration.current = generation;
    stateRefreshGeneration.current += 1;
    setStateRefreshing(false);
    setDetailLoading(true);
    setDetailError(null);
    setSiblingError(null);
    setTranscriptError(null);
    setEventError(null);
    setConfirmation(null);
    setCopyNotice(null);
    try {
      const selected = await loadAttempt(attemptId);
      if (detailGeneration.current !== generation) return;
      if (!selected) {
        setAttempt(null);
        setDetailError("This retained attempt was not found.");
        return;
      }
      const [related, transcriptPage, eventPage, usagePage, lifecyclePage] =
        await Promise.all([
          listAttempts({
            limit: SIBLING_LIMIT,
            includeArchived: true,
            issueNodeId: selected.issue.nodeId,
          }),
          loadTranscript(attemptId, DETAIL_PAGE_SIZE),
          loadEvents(attemptId, DETAIL_PAGE_SIZE),
          loadUsage(attemptId),
          loadLifecycleCommands(attemptId),
        ]);
      if (detailGeneration.current !== generation) return;
      setAttempt(selected);
      setSiblings(related.items);
      setSiblingPage(related);
      setTranscript(transcriptPage);
      setEvents(eventPage);
      setUsage(usagePage.items);
      setCommand(
        lifecyclePage.items[0] ? commandStatus(lifecyclePage.items[0]) : null,
      );
      setDetailError(null);
    } catch (error) {
      if (detailGeneration.current !== generation) return;
      setDetailError(loadErrorMessage(error));
    } finally {
      if (detailGeneration.current === generation) setDetailLoading(false);
    }
  }, []);

  const refreshCurrent = useCallback(async (attemptId: string) => {
    const generation = stateRefreshGeneration.current + 1;
    stateRefreshGeneration.current = generation;
    setStateRefreshing(true);
    try {
      const [selected, lifecyclePage] = await Promise.all([
        loadAttempt(attemptId),
        loadLifecycleCommands(attemptId),
      ]);
      if (
        stateRefreshGeneration.current !== generation ||
        selectedAttemptIdRef.current !== attemptId
      ) {
        return;
      }
      if (!selected) {
        setAttempt(null);
        setDetailError("This retained attempt was not found.");
        return;
      }
      setAttempt(selected);
      setCommand(
        lifecyclePage.items[0] ? commandStatus(lifecyclePage.items[0]) : null,
      );
      setDetailError(null);
    } catch (error) {
      if (
        stateRefreshGeneration.current === generation &&
        selectedAttemptIdRef.current === attemptId
      ) {
        setDetailError(loadErrorMessage(error));
      }
    } finally {
      if (stateRefreshGeneration.current === generation) {
        setStateRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadList({}, true);
  }, [loadList]);

  useEffect(() => {
    if (!selectedAttemptId) return;
    void loadDetail(selectedAttemptId);
  }, [loadDetail, selectedAttemptId]);

  useEffect(() => {
    if (!selectedAttemptId || attemptRef.current?.id !== selectedAttemptId) {
      return;
    }
    void refreshCurrent(selectedAttemptId);
  }, [refreshCurrent, refreshVersion, selectedAttemptId]);

  const inspectorOpen = selectedAttemptId !== null;
  useEffect(() => {
    if (!inspectorOpen) return;
    returnFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => closeButton.current?.focus(), 0);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onSelect(null);
        window.setTimeout(() => returnFocus.current?.focus(), 0);
        return;
      }
      if (event.key !== "Tab") return;
      const dialog =
        closeButton.current?.closest<HTMLElement>(".attempt-inspector");
      const focusable = dialog?.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", closeOnEscape);
      document.body.style.overflow = previousOverflow;
    };
  }, [inspectorOpen, onSelect]);

  async function nextPage() {
    if (!attemptPage?.nextCursor) return;
    const current = attemptPage;
    const loaded = await loadList({
      cursor: attemptPage.nextCursor,
      watermark: attemptPage.watermark,
    });
    if (loaded) setPageHistory((history) => [...history, current]);
  }

  function previousPage() {
    const previous = pageHistory.at(-1);
    if (!previous) return;
    setAttemptPage(previous);
    setPageHistory((history) => history.slice(0, -1));
  }

  async function loadMoreTranscript() {
    if (!attempt || !transcript?.nextCursor) return;
    const generation = detailGeneration.current;
    const attemptId = attempt.id;
    try {
      const next = await loadTranscript(
        attemptId,
        DETAIL_PAGE_SIZE,
        transcript.nextCursor,
        transcript.watermark,
      );
      if (
        detailGeneration.current !== generation ||
        selectedAttemptIdRef.current !== attemptId
      ) {
        return;
      }
      setTranscript({ ...next, items: [...transcript.items, ...next.items] });
      setTranscriptError(null);
    } catch (error) {
      if (
        detailGeneration.current === generation &&
        selectedAttemptIdRef.current === attemptId
      ) {
        setTranscriptError(loadErrorMessage(error));
      }
    }
  }

  async function loadMoreEvents() {
    if (!attempt || !events?.nextCursor) return;
    const generation = detailGeneration.current;
    const attemptId = attempt.id;
    try {
      const next = await loadEvents(
        attemptId,
        DETAIL_PAGE_SIZE,
        events.nextCursor,
        events.watermark,
      );
      if (
        detailGeneration.current !== generation ||
        selectedAttemptIdRef.current !== attemptId
      ) {
        return;
      }
      setEvents({ ...next, items: [...events.items, ...next.items] });
      setEventError(null);
    } catch (error) {
      if (
        detailGeneration.current === generation &&
        selectedAttemptIdRef.current === attemptId
      ) {
        setEventError(loadErrorMessage(error));
      }
    }
  }

  async function loadMoreSiblings() {
    if (!attempt || !siblingPage?.nextCursor) return;
    const generation = detailGeneration.current;
    const attemptId = attempt.id;
    try {
      const next = await listAttempts({
        limit: SIBLING_LIMIT,
        includeArchived: true,
        issueNodeId: attempt.issue.nodeId,
        cursor: siblingPage.nextCursor,
        watermark: siblingPage.watermark,
      });
      if (
        detailGeneration.current !== generation ||
        selectedAttemptIdRef.current !== attemptId
      ) {
        return;
      }
      setSiblings((current) => [...current, ...next.items]);
      setSiblingPage(next);
      setSiblingError(null);
    } catch (error) {
      if (
        detailGeneration.current === generation &&
        selectedAttemptIdRef.current === attemptId
      ) {
        setSiblingError(loadErrorMessage(error));
      }
    }
  }

  async function runControl(kind: LifecycleCommandKind) {
    if (
      !attempt ||
      attempt.id !== selectedAttemptIdRef.current ||
      controlsDisabled ||
      detailError ||
      detailLoading ||
      stateRefreshing ||
      commandSubmitting ||
      command?.phase === "accepted" ||
      command?.phase === "executing" ||
      !availableActions(attempt).includes(kind)
    ) {
      return;
    }
    const id = commandId();
    setConfirmation(null);
    setCommand(null);
    setCommandSubmitting(true);
    let pollRunning = false;
    const pollCommand = async () => {
      if (pollRunning) return;
      pollRunning = true;
      try {
        const durable = await loadLifecycleCommands(attempt.id, id);
        if (durable.items[0] && selectedAttemptIdRef.current === attempt.id) {
          setCommand(commandStatus(durable.items[0]));
        }
      } catch {
        // The command request owns transport failure reporting below.
      } finally {
        pollRunning = false;
      }
    };
    const pollingTimer = window.setInterval(() => void pollCommand(), 100);
    void pollCommand();
    try {
      const result = await controlAttempt(
        id,
        kind,
        attempt.id,
        attempt.lastEventSequence,
      );
      if (selectedAttemptIdRef.current === attempt.id) {
        setCommand(commandStatus(result));
      }
      await Promise.all([
        selectedAttemptIdRef.current === attempt.id
          ? refreshCurrent(attempt.id)
          : Promise.resolve(),
        loadList({}, true),
        onChanged(),
      ]);
    } catch (error) {
      const durable = await loadLifecycleCommands(attempt.id, id).catch(
        () => null,
      );
      if (durable?.items[0]) {
        if (selectedAttemptIdRef.current === attempt.id) {
          setCommand(commandStatus(durable.items[0]));
        }
      } else if (selectedAttemptIdRef.current === attempt.id) {
        setCommand({
          id,
          kind,
          phase:
            commandErrorKind(error) === "rejected" ? "rejected" : "uncertain",
          message:
            commandErrorKind(error) === "rejected"
              ? String(error)
              : "The service result could not be read. Refresh before retrying this command.",
        });
      }
    } finally {
      window.clearInterval(pollingTimer);
      setCommandSubmitting(false);
    }
  }

  async function copyPath(path: string, label: string) {
    try {
      await navigator.clipboard.writeText(path);
      setCopyNotice(`${label} copied.`);
    } catch {
      setCopyNotice(
        `${label} could not be copied. Select the path and copy it manually.`,
      );
    }
  }

  function close() {
    const id = selectedAttemptId;
    onSelect(null);
    window.setTimeout(() => {
      if (returnFocus.current?.isConnected) {
        returnFocus.current.focus();
      } else if (id) {
        document
          .querySelector<HTMLButtonElement>(
            `[data-attempt-id="${CSS.escape(id)}"]`,
          )
          ?.focus();
      }
    }, 0);
  }

  const displayedAttempt = attempt?.id === selectedAttemptId ? attempt : null;
  const selectedTokens = displayedAttempt
    ? tokenCount(displayedAttempt.id, usage)
    : null;
  const actions = displayedAttempt ? availableActions(displayedAttempt) : [];
  const controlsUnavailable =
    controlsDisabled ||
    Boolean(detailError) ||
    detailLoading ||
    stateRefreshing ||
    commandSubmitting ||
    command?.phase === "accepted" ||
    command?.phase === "executing";

  useEffect(() => {
    if (!confirmation || actions.includes(confirmation)) return;
    setConfirmation(null);
    closeButton.current?.focus();
  }, [actions, confirmation]);

  return (
    <>
      <section aria-labelledby="sessions-heading">
        <div className="section-heading session-heading">
          <div>
            <h2 id="sessions-heading">Sessions</h2>
            <small>Retained attempts, newest first</small>
          </div>
          <label className="archive-filter">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(event) => setIncludeArchived(event.target.checked)}
            />
            Include archived
          </label>
        </div>
        {listError ? <p className="inline-error">{listError}</p> : null}
        <div className="session-list">
          {attemptPage?.items.length === 0 ? (
            <p className="empty-state">No retained attempts.</p>
          ) : (
            attemptPage?.items.map((item) => (
              <button
                className="session-row"
                key={item.id}
                data-attempt-id={item.id}
                onClick={() => onSelect(item.id)}
              >
                <span>
                  <strong>{item.issue.title}</strong>
                  <small>
                    {item.issue.repository} #{item.issue.number}
                  </small>
                </span>
                <span className={`status status-${item.state}`}>
                  <span className="dot" aria-hidden="true" />
                  {stateLabel(item.state)}
                </span>
                <time dateTime={item.updatedAt}>
                  {formatTime(item.updatedAt)}
                </time>
                {item.archivedAt ? (
                  <span className="archived-label">Archived</span>
                ) : null}
              </button>
            ))
          )}
        </div>
        <div className="pagination" aria-label="Session pages">
          <button
            className="text-action"
            disabled={listLoading || pageHistory.length === 0}
            onClick={previousPage}
          >
            Previous
          </button>
          <span>Page {pageHistory.length + 1}</span>
          <button
            className="text-action"
            disabled={listLoading || !attemptPage?.nextCursor}
            onClick={() => void nextPage()}
          >
            Next
          </button>
        </div>
      </section>

      {selectedAttemptId ? (
        <div
          className="inspector-backdrop"
          onMouseDown={(event) =>
            event.target === event.currentTarget && close()
          }
        >
          <aside
            className="attempt-inspector"
            aria-modal="true"
            role="dialog"
            aria-labelledby="inspector-title"
          >
            <header className="inspector-header">
              <div>
                <p className="eyebrow">Attempt inspector</p>
                <h2 id="inspector-title">
                  {displayedAttempt?.issue.title ?? "Loading attempt"}
                </h2>
                {displayedAttempt ? (
                  <p>
                    {displayedAttempt.issue.repository} #
                    {displayedAttempt.issue.number}
                  </p>
                ) : null}
              </div>
              <button
                ref={closeButton}
                className="inspector-close"
                onClick={close}
                aria-label="Close attempt inspector"
              >
                Close
              </button>
            </header>

            {detailLoading && !displayedAttempt ? (
              <p className="loading-state">Loading attempt...</p>
            ) : null}
            {detailError ? (
              <p className="inline-error" role="alert">
                {detailError}
              </p>
            ) : null}
            {displayedAttempt ? (
              <div className="inspector-body">
                <section
                  className="inspector-summary"
                  aria-labelledby="attempt-state-heading"
                >
                  <div className="inspector-state">
                    <h3 id="attempt-state-heading">
                      {stateLabel(displayedAttempt.state)}
                    </h3>
                    <span>
                      {displayedAttempt.archivedAt ? "Archived" : "Retained"}
                    </span>
                  </div>
                  <p>{processStatus(displayedAttempt)}</p>
                  <dl className="inspector-facts">
                    <div>
                      <dt>Started</dt>
                      <dd>{formatTime(displayedAttempt.createdAt)}</dd>
                    </div>
                    <div>
                      <dt>Updated</dt>
                      <dd>{formatTime(displayedAttempt.updatedAt)}</dd>
                    </div>
                    {displayedAttempt.archivedAt ? (
                      <div>
                        <dt>Archived</dt>
                        <dd>{formatTime(displayedAttempt.archivedAt)}</dd>
                      </div>
                    ) : null}
                    <div>
                      <dt>Effective model</dt>
                      <dd>
                        {displayedAttempt.observedModel ??
                          displayedAttempt.requestedModel}
                      </dd>
                    </div>
                    <div>
                      <dt>Effective effort</dt>
                      <dd>
                        {displayedAttempt.observedEffort ??
                          displayedAttempt.requestedEffort}
                      </dd>
                    </div>
                    <div>
                      <dt>Observed settings</dt>
                      <dd>
                        {displayedAttempt.observedModel
                          ? `${displayedAttempt.observedModel} · ${displayedAttempt.observedEffort ?? "effort unknown"}`
                          : "Not observed"}
                      </dd>
                    </div>
                    <div>
                      <dt>Tokens</dt>
                      <dd>
                        {selectedTokens === null
                          ? "Unknown"
                          : selectedTokens.toLocaleString()}
                      </dd>
                    </div>
                    <div>
                      <dt>Provider</dt>
                      <dd>
                        {displayedAttempt.provider}
                        {displayedAttempt.codexVersion
                          ? ` · ${displayedAttempt.codexVersion}`
                          : ""}
                      </dd>
                    </div>
                  </dl>
                </section>

                <section aria-labelledby="siblings-heading">
                  <div className="inspector-section-heading">
                    <h3 id="siblings-heading">Attempts for this issue</h3>
                    <span>{siblings.length}</span>
                  </div>
                  <div className="sibling-list">
                    {siblings.map((sibling) => (
                      <button
                        key={sibling.id}
                        className={
                          sibling.id === displayedAttempt.id
                            ? "sibling-current"
                            : ""
                        }
                        aria-current={
                          sibling.id === displayedAttempt.id
                            ? "true"
                            : undefined
                        }
                        onClick={() => onSelect(sibling.id)}
                      >
                        <span>
                          {stateLabel(sibling.state)}
                          {sibling.archivedAt ? " · archived" : ""}
                        </span>
                        <time dateTime={sibling.createdAt}>
                          {formatTime(sibling.createdAt)}
                        </time>
                      </button>
                    ))}
                  </div>
                  {siblingPage?.nextCursor ? (
                    <button
                      className="text-action"
                      onClick={() => void loadMoreSiblings()}
                    >
                      Load more attempts
                    </button>
                  ) : null}
                  {siblingError ? (
                    <p className="inline-error" role="alert">
                      {siblingError}
                    </p>
                  ) : null}
                </section>

                <section aria-labelledby="transcript-heading">
                  <div className="inspector-section-heading">
                    <div>
                      <h3 id="transcript-heading">Transcript</h3>
                      <small>
                        Point-in-time record. This view does not follow live
                        output.
                      </small>
                    </div>
                  </div>
                  <div className="transcript" tabIndex={0}>
                    {transcript?.items.length ? (
                      transcript.items.map((entry) => (
                        <article key={entry.sequence}>
                          <time dateTime={entry.timestamp}>
                            {formatTime(entry.timestamp)}
                          </time>
                          <pre>{entry.text}</pre>
                          {entry.truncated ? (
                            <p className="warning-text">
                              This entry was truncated during retention.
                            </p>
                          ) : null}
                        </article>
                      ))
                    ) : (
                      <p className="empty-state">No transcript was retained.</p>
                    )}
                  </div>
                  {transcript?.nextCursor ? (
                    <button
                      className="text-action"
                      onClick={() => void loadMoreTranscript()}
                    >
                      Load more transcript
                    </button>
                  ) : null}
                  {transcriptError ? (
                    <p className="inline-error" role="alert">
                      {transcriptError}
                    </p>
                  ) : null}
                </section>

                <section aria-labelledby="events-heading">
                  <div className="inspector-section-heading">
                    <h3 id="events-heading">Events</h3>
                  </div>
                  <ol className="event-list">
                    {events?.items.map((event) => (
                      <li key={`${event.sequence}-${event.type}`}>
                        <div>
                          <strong>{event.type}</strong>
                          <time dateTime={event.timestamp}>
                            {formatTime(event.timestamp)}
                          </time>
                        </div>
                        {Object.keys(event.detail).length ? (
                          <pre>{JSON.stringify(event.detail, null, 2)}</pre>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                  {events?.nextCursor ? (
                    <button
                      className="text-action"
                      onClick={() => void loadMoreEvents()}
                    >
                      Load more events
                    </button>
                  ) : null}
                  {eventError ? (
                    <p className="inline-error" role="alert">
                      {eventError}
                    </p>
                  ) : null}
                </section>

                {displayedAttempt.error ? (
                  <section
                    aria-labelledby="error-heading"
                    className="attempt-error"
                  >
                    <div className="inspector-section-heading">
                      <h3 id="error-heading">Error</h3>
                    </div>
                    <strong>{displayedAttempt.error.code}</strong>
                    <pre>{displayedAttempt.error.message}</pre>
                    {displayedAttempt.error.detail ? (
                      <pre>{displayedAttempt.error.detail}</pre>
                    ) : null}
                  </section>
                ) : null}

                <section aria-labelledby="workspace-heading">
                  <div className="inspector-section-heading">
                    <h3 id="workspace-heading">Workspace and GitHub</h3>
                  </div>
                  {displayedAttempt.workspace ? (
                    <dl className="path-list">
                      {(
                        [
                          ["Branch", displayedAttempt.workspace.branch],
                          ["Worktree", displayedAttempt.workspace.worktreePath],
                          [
                            "Worktree Git directory",
                            displayedAttempt.workspace.worktreeGitDir,
                          ],
                          ["Clone", displayedAttempt.workspace.clonePath],
                          [
                            "Common Git directory",
                            displayedAttempt.workspace.commonGitDir,
                          ],
                        ] as const
                      ).map(([label, path]) => (
                        <div key={label}>
                          <dt>{label}</dt>
                          <dd>
                            <code>{path}</code>
                            <button
                              className="text-action"
                              onClick={() => void copyPath(path, label)}
                            >
                              Copy
                            </button>
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <p className="empty-state">
                      No workspace paths were recorded.
                    </p>
                  )}
                  {copyNotice ? (
                    <p className="copy-notice" role="status">
                      {copyNotice}
                    </p>
                  ) : null}
                  <div className="github-links">
                    <a href={displayedAttempt.issue.url}>
                      Open issue on GitHub
                    </a>
                    {displayedAttempt.pullRequest ? (
                      <a href={displayedAttempt.pullRequest.url}>
                        Open pull request #{displayedAttempt.pullRequest.number}
                        {displayedAttempt.pullRequest.draft ? " draft" : ""}
                      </a>
                    ) : (
                      <span>No pull request recorded</span>
                    )}
                  </div>
                </section>

                <section
                  aria-labelledby="controls-heading"
                  className="attempt-controls"
                >
                  <div className="inspector-section-heading">
                    <h3 id="controls-heading">Attempt controls</h3>
                  </div>
                  <div className="control-actions">
                    {actions.map((kind) => (
                      <button
                        key={kind}
                        className={
                          kind === "stop" || kind === "return"
                            ? "danger-action"
                            : "secondary-action"
                        }
                        disabled={controlsUnavailable}
                        onClick={() =>
                          needsConfirmation(kind)
                            ? setConfirmation(kind)
                            : void runControl(kind)
                        }
                      >
                        {actionLabel(kind)}
                      </button>
                    ))}
                  </div>
                  {commandSubmitting && !command ? (
                    <p className="command-submitting" role="status">
                      Submitting command...
                    </p>
                  ) : null}
                  {confirmation && actions.includes(confirmation) ? (
                    <div
                      className="command-confirmation"
                      role="alertdialog"
                      aria-label={`Confirm ${actionLabel(confirmation).toLowerCase()}`}
                    >
                      <p>
                        Confirm {actionLabel(confirmation).toLowerCase()} for
                        this retained attempt.
                      </p>
                      <div>
                        <button
                          className="text-action"
                          onClick={() => setConfirmation(null)}
                        >
                          Cancel
                        </button>
                        <button
                          className="danger-action"
                          disabled={controlsUnavailable}
                          onClick={() => void runControl(confirmation)}
                        >
                          Confirm
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {command ? (
                    <div
                      className={`inspector-command command-${command.phase}`}
                      role="status"
                    >
                      <div>
                        <strong>{actionLabel(command.kind)}</strong>
                        <span>{commandPhaseLabel(command.phase)}</span>
                      </div>
                      <p>{command.message}</p>
                      <code>{command.id}</code>
                    </div>
                  ) : null}
                </section>
              </div>
            ) : null}
          </aside>
        </div>
      ) : null}
    </>
  );
}
