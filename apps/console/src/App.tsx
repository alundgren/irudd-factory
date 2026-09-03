import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  Assignment,
  CommandReceipt,
  FactorySnapshot,
} from "@irudd-factory/contracts";
import { loadSnapshot, runNext } from "./client.ts";
import {
  assignmentIsBusy,
  codexCapacityFull,
  resultTitle,
  stateLabel,
} from "./view-model.ts";

const emptySnapshot: FactorySnapshot = {
  receipt: null,
  assignment: null,
  events: [],
};

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
        timeStyle: "medium",
      }).format(date);
}

function StateMark({ assignment }: { assignment: Assignment }) {
  return (
    <span className={`state-mark state-${assignment.state}`}>
      <span aria-hidden="true" className="state-dot" />
      {stateLabel(assignment.state)}
    </span>
  );
}

function CommandOutcome({ receipt }: { receipt: CommandReceipt }) {
  const result = receipt.result;
  return (
    <section className="outcome" aria-labelledby="command-outcome">
      <div>
        <p className="eyebrow">Last command</p>
        <h2 id="command-outcome">{resultTitle(result)}</h2>
      </div>
      <p className="command-reference">
        <span>Command ID</span>
        <code>{receipt.commandId}</code>
      </p>
      {result._tag === "no_candidate" ? (
        <p className="measure">
          When this command ran, the configured repositories had no eligible
          issue that Factory had not handled before.
        </p>
      ) : null}
      {result._tag === "selection_ambiguous" ? (
        <div>
          <p className="measure">
            Factory found more than one eligible issue and did not choose by
            ordering. Leave exactly one eligible, then submit a new command.
          </p>
          <ul className="issue-links">
            {result.issueLinks.map((url) => (
              <li key={url}>
                <a href={url}>{url}</a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {result._tag === "started" ? (
        <p className="measure">
          Reserved{" "}
          <a href={result.assignment.issue.url}>
            {result.assignment.issue.repository}#
            {result.assignment.issue.number}
          </a>
          . Current progress appears below.
        </p>
      ) : null}
      {result._tag === "provider_busy" ? (
        <p className="measure">
          <a href={result.assignment.issue.url}>
            {result.assignment.issue.repository}#
            {result.assignment.issue.number}
          </a>{" "}
          was {stateLabel(result.assignment.state).toLowerCase()} when this
          command ran. The rejection receipt is durable and no new assignment
          was created.
        </p>
      ) : null}
      {result._tag === "dispatch_unavailable" ? (
        <p className="measure">
          {result.reason === "dispatch_paused"
            ? "Resume dispatch before starting another issue."
            : "Enable Codex before starting another issue."}
        </p>
      ) : null}
    </section>
  );
}

function AssignmentDetails({ snapshot }: { snapshot: FactorySnapshot }) {
  const assignment = snapshot.assignment;
  if (!assignment) {
    return (
      <section className="empty-state" aria-labelledby="current-run">
        <p className="eyebrow">Current assignment</p>
        <h2 id="current-run">Nothing has run yet</h2>
        <p>
          Submit the displayed command ID. Factory will reserve work only when
          exactly one issue is eligible.
        </p>
      </section>
    );
  }
  return (
    <section className="assignment" aria-labelledby="current-run">
      <div className="assignment-heading">
        <div>
          <p className="eyebrow">Current assignment</p>
          <h2 id="current-run">
            <a href={assignment.issue.url}>{assignment.issue.title}</a>
          </h2>
          <p className="issue-identity">
            {assignment.issue.repository}#{assignment.issue.number}
          </p>
        </div>
        <StateMark assignment={assignment} />
      </div>

      {assignment.error ? (
        <div className="error-detail" role="alert">
          <p className="eyebrow">{assignment.error.code}</p>
          <pre>{assignment.error.message}</pre>
          {assignment.error.detail ? (
            <pre>{assignment.error.detail}</pre>
          ) : null}
        </div>
      ) : null}

      <dl className="facts">
        <div>
          <dt>Assignment ID</dt>
          <dd>
            <code>{assignment.id}</code>
          </dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{formatTime(assignment.updatedAt)}</dd>
        </div>
        <div>
          <dt>Requested provider</dt>
          <dd>
            {assignment.requestedModel} · {assignment.requestedEffort}
          </dd>
        </div>
        <div>
          <dt>Observed provider</dt>
          <dd>
            {assignment.observedModel ?? "Not observed yet"}
            {assignment.observedEffort ? ` · ${assignment.observedEffort}` : ""}
          </dd>
        </div>
        <div>
          <dt>Starting commit</dt>
          <dd>
            <code>{assignment.workflow.startingCommit}</code>
          </dd>
        </div>
        <div>
          <dt>Codex version</dt>
          <dd>{assignment.codexVersion ?? "Not started"}</dd>
        </div>
      </dl>

      {assignment.workspace ? (
        <div className="paths">
          <h3>Retained workspace</h3>
          <dl>
            {[
              ["Clone", assignment.workspace.clonePath],
              ["Worktree", assignment.workspace.worktreePath],
              ["Worktree Git directory", assignment.workspace.worktreeGitDir],
              ["Common Git directory", assignment.workspace.commonGitDir],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>
                  <code>{value}</code>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      {assignment.pullRequest ? (
        <div className="pull-request">
          <div>
            <p className="eyebrow">Pull request</p>
            <a href={assignment.pullRequest.url}>
              #{assignment.pullRequest.number}
            </a>
          </div>
          <span>{assignment.pullRequest.draft ? "Draft" : "Ready"}</span>
        </div>
      ) : null}

      <div className="history">
        <h3>Event history</h3>
        {snapshot.events.length === 0 ? (
          <p>No events recorded.</p>
        ) : (
          <ol>
            {snapshot.events.map((event) => (
              <li key={event.sequence}>
                <div>
                  <strong>{event.type}</strong>
                  <time dateTime={event.timestamp}>
                    {formatTime(event.timestamp)}
                  </time>
                </div>
                {Object.keys(event.detail).length > 0 ? (
                  <code>{JSON.stringify(event.detail)}</code>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

export default function App() {
  const [snapshot, setSnapshot] = useState<FactorySnapshot>(emptySnapshot);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [commandId, setCommandId] = useState(nextCommandId);

  const refresh = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    try {
      const next = await loadSnapshot();
      setSnapshot(next);
      setLoadError(null);
    } catch (error) {
      setLoadError(String(error));
    } finally {
      if (initial) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh(true);
    const timer = window.setInterval(() => void refresh(), 300);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const busy = useMemo(() => {
    const assignments =
      snapshot.assignments ??
      (assignmentIsBusy(snapshot.assignment) && snapshot.assignment
        ? [snapshot.assignment]
        : []);
    return codexCapacityFull(
      assignments,
      snapshot.configuration?.codexSlots ?? 1,
    );
  }, [snapshot]);

  async function submit() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const receipt = await runNext(commandId);
      setSnapshot((current) => ({ ...current, receipt }));
      setCommandId(nextCommandId());
      await refresh();
    } catch (error) {
      setSubmitError(String(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main>
      <header className="page-header">
        <div>
          <p className="eyebrow">Irudd Factory</p>
          <h1>Run the next eligible issue</h1>
          <p className="lede">
            One durable command reserves work, runs Codex, and records the pull
            request.
          </p>
        </div>
        <div
          className={`connection ${loadError ? "connection-lost" : ""}`}
          role="status"
        >
          <span aria-hidden="true" />
          {loadError ? "Connection lost" : "Connected"}
        </div>
      </header>

      <section className="run-control" aria-labelledby="run-command">
        <div>
          <p className="eyebrow">Next command ID</p>
          <code id="run-command">{commandId}</code>
        </div>
        <button onClick={() => void submit()} disabled={submitting || busy}>
          {submitting
            ? "Submitting…"
            : busy
              ? "Codex is busy"
              : "Run next issue"}
        </button>
      </section>

      {submitError ? (
        <div className="request-error" role="alert">
          <p>Command submission failed. Retry with the same displayed ID.</p>
          <pre>{submitError}</pre>
        </div>
      ) : null}

      {loading ? (
        <section className="loading-state" aria-live="polite">
          Loading Factory state…
        </section>
      ) : loadError && !snapshot.assignment && !snapshot.receipt ? (
        <section className="load-failed" role="alert">
          <h2>Factory state is unavailable</h2>
          <pre>{loadError}</pre>
          <button onClick={() => void refresh(true)}>Try again</button>
        </section>
      ) : (
        <>
          {loadError ? (
            <p className="stale-note">
              Showing the last loaded state. Factory will reconnect
              automatically.
            </p>
          ) : null}
          {snapshot.receipt ? (
            <CommandOutcome receipt={snapshot.receipt} />
          ) : null}
          <AssignmentDetails snapshot={snapshot} />
        </>
      )}
    </main>
  );
}
