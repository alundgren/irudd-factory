# Operator guide

Factory polls a configured repository pool and dispatches a durable FIFO queue
into the available Codex slots. The service is local and loopback-only.

## Requirements

- Vite+ with Node.js 24.11 or newer
- `git`, `gh`, and `codex` available on `PATH`
- ambient GitHub authentication for `gh` and Codex
- a target repository with a valid `WORKFLOW.md` on its default branch
- an issue author with `WRITE`, `MAINTAIN`, or `ADMIN` permission

Install dependencies with `vp install --frozen-lockfile`. Copy
`factory.example.json` to `factory.json` and set the repository, database
path, workspace root, Codex model, and reasoning effort. The bind address must
be an IPv4 or IPv6 loopback address.

`port`, `pollIntervalMs`, and `codex.slots` are optional. They default to
`4317`, `30000`, and `1`. `timeouts` is also optional. You may override any
subset of these defaults:

```json
{
  "port": 4317,
  "pollIntervalMs": 30000,
  "codex": {
    "model": "gpt-5.6-luna",
    "reasoningEffort": "medium",
    "slots": 2
  },
  "timeouts": {
    "childStartupMs": 10000,
    "initializationMs": 10000,
    "modelSchemaMs": 20000,
    "turnMs": 600000,
    "shutdownMs": 5000
  }
}
```

Every supplied port or timeout must be a positive integer. Ports must be at
most `65535`. `pollIntervalMs` accepts `1000` through `3600000`, and slots
accepts `1` through `32`. Normal startup requires a nonempty `repositories`
array, `databasePath`, `workspaceRoot`, `bindHost`, `codex.model`, and
`codex.reasoningEffort`.

## Start and inspect Factory

```sh
vp run build:console
service_log="$(mktemp "${TMPDIR:-/tmp}/irudd-factory.XXXXXX")"
vp node apps/service/src/main.ts --config factory.json \
  </dev/null >"$service_log" 2>&1 &
service_pid=$!

cleanup() {
  trap - 0 INT TERM
  kill "$service_pid" 2>/dev/null || true
  wait "$service_pid" 2>/dev/null || true
  rm -f "$service_log"
}
trap cleanup 0 INT TERM

snapshot_output=
attempt=0
while [ "$attempt" -lt 100 ]; do
  if snapshot_output="$(vp node apps/cli/src/main.ts snapshot 2>/dev/null)"; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 0.1
done
if [ "$attempt" -eq 100 ]; then
  echo "Factory service did not become ready" >&2
  cat "$service_log" >&2
  exit 1
fi

printf '%s\n' "$snapshot_output"
```

The service runs in the background while the CLI commands execute. Its output
goes to a temporary log so shells with background terminal output disabled do
not suspend it. If startup fails, the command prints that log. The cleanup trap
stops the service and removes the log when you press Ctrl-C or leave the shell.
Keep this terminal attached while using the console or CLI.

Open the configured local URL to use the console. The displayed command ID is
created before submission. On a transport error, retry that same ID. Factory
returns its original durable receipt after a service restart, even if GitHub is
temporarily unavailable or the candidate set has changed.

Polling starts after one configured interval and continues until shutdown. The
CLI can still request a manual scan. The caller must provide a command ID:

```sh
vp node apps/cli/src/main.ts run-next --command-id 40b8af63-b7cc-4bc7-96d6-43d9aa42fc91
wait "$service_pid"
```

Automatic work uses persisted FIFO tenure. A manual `start` or `run-next`
request uses the same slot and active-issue checks. Paused dispatch or disabled
Codex rejects new admission. A full provider returns `provider_busy`.

## Live integration command

Run the complete production composition deliberately with:

```sh
vp run test:integration
```

The command reads `factory.json` by default. For this command only, the file
needs `codex.model` and `codex.reasoningEffort`. It may contain the normal
service fields, but the integration run ignores them. Optional timeout
overrides use the same defaults and validation as normal startup.

Choose another config file or repository with:

```sh
vp run test:integration --config factory.local.json \
  --repository https://github.com/owner/repository
```

The repository value may be an HTTPS GitHub URL or `owner/name`. The default is
`https://github.com/alundgren/irudd-factory-agent-testing`.

This is a live, destructive-by-design integration check. Before creating the
issue, it builds the console and verifies `git`, `gh`, and `codex`; the ambient
GitHub login and its repository permission; the default branch `WORKFLOW.md`;
the `ready-for-agent` and `claimed` labels; workflow label policy; and read
access through the exact HTTPS Git remote Factory will clone. Invalid Codex or
timeout settings also fail before the issue write.

Each run creates one unique `ready-for-agent` issue, then submits
`RunNextEligibleIssue` over the existing RPC client. The integration service
uses production SQLite, GitHub, workspace, and Codex dependencies. A private
GitHub wrapper exposes only the issue created by this run to discovery, even if
the repository contains other eligible issues. Claims and pull-request checks
still use the production GitHub adapter.

The command binds `127.0.0.1` on an operating-system-assigned port and prints
the run ID, issue URL, console URL, and retained directory. It checks the
terminal assignment, required event order, issue identity, and verified pull
request. After a pass or failure, the console stays available until SIGINT or
SIGTERM. The command returns its stored pass or failure status after the
signal.

A signal while the assignment is active cancels the run and returns nonzero.
The assignment may remain `reserved`, `starting`, or `running` because Factory
does not recover nonterminal work yet. On every exit after startup, the runner
stops the application, Codex process group, and HTTP listener.

Files remain under `.factory/integration/<run-id>`. The command does not delete
the issue, label, branch, pull request, database, clone, worktree, or provider
runtime. Keep or remove them manually after inspection.

## Eligibility and claim behavior

An issue must be open, have `ready-for-agent`, have none of `claimed`,
`ready-for-human`, `epic`, or `needs-refinement`, have all native blockers
closed, and be authored by someone with write permission. Factory reads the
default branch commit and `WORKFLOW.md` before opening its immediate SQLite
transaction.

After reservation, Factory adds `claimed` once. If that mutation fails, it
reads the issue once to determine whether the label was applied. It does not
retry the mutation. A worktree is created only after the claim is confirmed.

## Retained files

Factory keeps the bare clone, linked worktree, linked-worktree Git directory,
shared Git directory, branch, and SQLite records. It does not delete a retained
workspace automatically. The console shows the absolute paths for inspection.

After a failed or completed run, remove files only after preserving anything
needed for diagnosis. The current release has no cleanup command.

Queue pages carry a watermark. Pass the first page's watermark and next cursor
to read later pages from the same point-in-time result, even if polling changes
the live queue.

## Deterministic fixtures

List the registered fixtures and their tags before choosing one:

```sh
vp run fixture
```

For scripts and agents, use the direct entry point. It writes one JSON document
to stdout without Vite+ task-runner diagnostics:

```sh
vp node scripts/fixture.ts --json
```

Inspect the state, behavior, and suggested checks declared by one fixture:

```sh
vp run fixture runnable --describe
vp node scripts/fixture.ts runnable --describe --json
```

Start the selected fixture with:

```sh
vp run fixture runnable
```

Each fixture owns its metadata, deterministic state, fake behavior, and
machine-checked expectations. A start removes only the selected fixture's
SQLite database and recreates it through the real migrations. GitHub,
workspace, and Codex ports are fake. The SQLite store, application command,
Effect RPC transport, CLI client, service, console, and shutdown path are real.

Fixture launches are refused when `NODE_ENV=production`. Listing and describing
fixtures remain available because those commands do not build the console,
create runtime files, construct dependencies, or open a listener.

While a busy fixture runs, use the second-client command printed by the fixture
to confirm that another command receives a durable `provider_busy` result.

## Current recovery limits

Receipts, queue tenure, dispatch pause, and Codex enabled state survive restart.
Startup interrupts unfinished attempts and reconciles recorded provider process
ownership. It does not resume or retry attempts. Stop, return, restart,
archive, authentication, remote access, and automatic cleanup remain deferred.
