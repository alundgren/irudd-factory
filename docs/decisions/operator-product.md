# Operator product delivery decision

Status: approved.

## Product outcome

Factory will operate a durable queue across several GitHub repositories and
run Codex in a bounded pool. The console will provide a desktop-first overview,
an attempt inspector, retained transcripts, lifecycle controls, and a Codex
timeline. The same application will support local development and access over
Tailscale Serve.

Live messages, approval handling, and realtime turn following are not part of
this epic. Additional providers and provider quota meters also remain outside
it.

## Configuration

JSON remains the configuration source. The console may display effective
values but will not edit them.

```json
{
  "repositories": [
    { "repository": "owner/one" },
    {
      "repository": "owner/two",
      "codex": {
        "model": "gpt-5.6-sol",
        "reasoningEffort": "high"
      }
    }
  ],
  "databasePath": ".factory/factory.db",
  "workspaceRoot": ".factory/workspaces",
  "bindHost": "127.0.0.1",
  "port": 4317,
  "pollIntervalMs": 30000,
  "codex": {
    "model": "gpt-5.6-luna",
    "reasoningEffort": "medium",
    "slots": 1
  }
}
```

`repositories` is required and nonempty. Repository names are compared in
lowercase and must be unique. Codex model and reasoning effort are required
globally. A repository may override either value. `slots` is optional, defaults
to `1`, and accepts `1` through `32`. `pollIntervalMs` is optional, defaults to
`30000`, and accepts `1000` through `3600000`.

Existing databases do not need migration compatibility. Startup may require a
reset before it performs any external action.

## Queue and process ownership

Factory records the first time an issue becomes eligible. It orders the queue
by that time, normalized repository name, issue number, GitHub node ID, then
queue-tenure ID. An issue that becomes ineligible leaves its current tenure.

Factory rechecks an issue immediately before start or restart. It verifies the
issue is open, labels still allow execution, native blockers are closed, the
author still has write permission, and the pinned `WORKFLOW.md` revision is
current. A stale queue entry never starts.

One Factory service process owns a database. It acquires an exclusive lifetime
lease before migrations, reconciliation, RPC listeners, polling, or provider
startup. Codex capacity comes from the configured slot count. Automatic and
manual starts reserve capacity in the same database transaction so two callers
cannot start the same issue or consume one slot twice.

The service stores each provider process group and start identity. After a
crash it confirms that the old process has exited or terminates it. If process
ownership cannot be established, the attempt remains blocked and continues to
consume capacity.

Removing a repository from configuration ends its queue tenures and prevents
dispatch, return, or restart. Its history remains readable. Re-adding it allows
fresh validation and queue admission.

## Issues, attempts, and recovery

An issue may have many attempts. The console term "session" means one attempt.
Start and restart return a durable admission receipt quickly, then an attempt
state machine records claim, workspace, process, transcript, and pull request
work. Startup marks unfinished attempts interrupted and never resumes or
retries them automatically.

Reconciliation may perform a read-only pull request lookup after a provider
process exits. It retains a verified pull request URL while the attempt remains
interrupted. Ambiguous evidence stays unknown.

Stop waits for confirmed provider-process exit. If exit cannot be confirmed,
the attempt enters `stop_uncertain` and keeps its slot. Return applies only to
failed, interrupted, or stopped attempts. It requires a configured repository
and no pull request, then removes `claimed` after verification. Restart creates
a sibling attempt with current settings and a new branch and worktree. Archive
hides one terminal attempt and is reversible. It does not delete its database
records, transcript, branch, or worktree.

Command records use accepted, executing, and final phases. Reconciliation
finishes or reports external and process effects that were interrupted by a
crash. Commands are idempotent.

## Stored events and read APIs

Factory stores an allowlisted projection of provider events, not complete
protocol envelopes. It never stores environment values, request headers,
authentication data, or arbitrary protocol fields. Free text has redaction and
size limits with an explicit truncation marker. Agent-written text may still
repeat readable repository or machine content, so operators must treat retained
transcripts as sensitive.

The console uses bounded, paginated queue, session, transcript, event, and
timeline reads. A page watermark freezes membership, values, and ordering for
the complete traversal. Token counts appear only when Codex reports an
authoritative value. Missing values remain unknown. Provider quota windows are
not estimated.

## Console behavior

The primary viewport is `1400x900`. The console must also remain usable at
`390x844`, without reducing the desktop information density to fit phones.

The overview shows active attempts, the paged ready queue, Codex slot and pause
state, recent activity, known token totals, and read-only effective
configuration. Start does not require confirmation. Pause, resume, provider
enable, and provider disable do not require confirmation.

The sessions view lists attempts and opens the shared inspector. The inspector
shows the selected attempt, sibling attempts, point-in-time transcript, paths,
pull request, errors, and controls. Stop, return, and restart require
confirmation. Archive and restore do not. There are no message or approval
controls in this delivery.

The timeline has one Codex lane with concurrent slots. It shows attempt times,
state, model, reasoning effort, and known tokens. Selecting an attempt opens the
shared inspector. The narrow layout may scroll horizontally.

## Local and Tailscale access

Local development is the default when `access` is omitted or has mode `local`.
The service exposes static files and RPC on one loopback listener. It accepts a
same-origin browser request or an Origin-less CLI request and rejects foreign
origins.

Production-like access uses:

```json
{
  "access": {
    "mode": "tailscale",
    "operatorLogin": "operator@example.com",
    "localCliPort": 4318
  }
}
```

Tailscale mode requires `bindHost` to equal `127.0.0.1`. The main listener
serves static files and RPC to Tailscale Serve. Browser RPC requires one valid
Host value, an `https://` Origin for that Host, and one decoded
`Tailscale-User-Login` value that exactly matches `operatorLogin`. The service
rejects missing, duplicate, malformed, or mismatched identity and Host values,
missing or foreign browser origins, tagged-device requests, and forwarded
identity spoofing.

A second RPC-only loopback listener uses `localCliPort`, which defaults to
`4318` and must differ from the main port. It accepts Origin-less,
identity-less CLI requests, serves no static files, and must not be proxied.
Startup succeeds only if both listeners start. Tailscale mode accepts the exact
`127.0.0.1` bind address, not `::1` or another address in `127.0.0.0/8`.

Factory does not install, configure, or start Tailscale. The operator runs the
service, then exposes the main listener with:

```sh
tailscale serve --bg 4317
```

The final human verification uses a second tailnet device and the intended
login. It checks successful console access, a harmless pause and resume, denial
for a temporary mismatched login, and a local-mode fixture with no Tailscale
dependency.

Database records, transcripts, branches, and worktrees are retained
indefinitely. Archive only changes console visibility.
