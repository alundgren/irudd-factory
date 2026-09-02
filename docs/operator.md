# Operator guide

Factory currently handles one repository and one active Codex assignment. It is
a manual local service, not a scheduler.

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

`port` is optional and defaults to `4317`. `timeouts` is also optional. You may
override any subset of these defaults:

```json
{
  "port": 4317,
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
most `65535`. Normal startup still requires `repository`, `databasePath`,
`workspaceRoot`, `bindHost`, `codex.model`, and `codex.reasoningEffort`.

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
Keep this terminal attached while using the console or running `run-next`.

Open the configured local URL to use the console. The displayed command ID is
created before submission. On a transport error, retry that same ID. Factory
returns its original durable receipt after a service restart, even if GitHub is
temporarily unavailable or the candidate set has changed.

The CLI requires the caller to provide the command ID:

```sh
vp node apps/cli/src/main.ts run-next --command-id 40b8af63-b7cc-4bc7-96d6-43d9aa42fc91
wait "$service_pid"
```

Factory accepts the command only when exactly one issue is eligible. A second
client receives `provider_busy` while the active assignment is reserved,
starting, or running.

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

## Deterministic fixtures

Build and start any seeded scenario with:

```sh
vp run fixture runnable
```

Available scenarios are `empty`, `ambiguous`, `busy-reserved`,
`busy-starting`, `busy-running`, `runnable`, `failed-long`,
`completed-ready`, and `completed-draft`. Each start removes only that
scenario's SQLite database and recreates it through the production migrations.
GitHub, workspace, and Codex ports are fake; the SQLite store, Effect RPC
transport, CLI client, service, and console are real.

While a busy fixture runs, use the second-client command printed by the fixture
to confirm that another command receives a durable `provider_busy` result.

## Current recovery limits

Receipt replay and terminal assignments survive restart. Factory does not yet
resume or reconcile an assignment left in reserved, starting, or running after
the process exits. Inspect the retained database and workspace before manual
intervention. Polling, cancellation, queues, stall detection, authentication,
remote access, and automatic cleanup are deferred.
