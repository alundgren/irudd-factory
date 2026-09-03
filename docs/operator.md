# Operator guide

Factory operates configured repositories through a local or Tailscale-served
console.

## Requirements

- Vite+ with Node.js 24.11 or newer
- `git`, `gh`, and `codex` available on `PATH`
- ambient GitHub authentication for `gh` and Codex
- a target repository with a valid `WORKFLOW.md` on its default branch
- an issue author with `WRITE`, `MAINTAIN`, or `ADMIN` permission

Install dependencies with `vp install --frozen-lockfile`. Copy
`factory.example.json` to `factory.json` and set the repository, database
path, workspace root, Codex model, and reasoning effort. Omitted `access`
defaults to local mode. Local mode accepts any IP-loopback bind address:

```json
{
  "bindHost": "127.0.0.1",
  "port": 4317,
  "access": { "mode": "local" }
}
```

Local mode serves the console and RPC together. Browser RPC requests must have
an HTTP Origin matching their Host. Ordinary navigation and asset requests may
omit Origin. The CLI sends no Origin and is accepted on the same listener. Do
not put this mode behind a proxy or port forward.

To use Tailscale Serve, set the exact expected login and keep `bindHost` at
`127.0.0.1`:

```json
{
  "bindHost": "127.0.0.1",
  "port": 4317,
  "access": {
    "mode": "tailscale",
    "operatorLogin": "operator@example.com",
    "localCliPort": 4318
  }
}
```

`localCliPort` is optional and defaults to `4318`. It must differ from `port`.
Factory starts both listeners together. The main listener requires the exact
Tailscale identity and an HTTPS same-origin browser RPC request. The local CLI
listener accepts only Origin-less RPC and never serves console files.

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

Retained free text defaults to 65,536 bytes per entry. Configure regular
expressions to replace known credentials or machine-specific secrets before
Factory writes transcript and error text:

```json
{
  "retention": {
    "sensitivePatterns": ["ghp_[A-Za-z0-9]+", "internal-host-[0-9]+"],
    "maxTextBytes": 65536
  }
}
```

Factory appends `[truncated]` when an entry exceeds the byte limit. These
filters reduce accidental retention, but they cannot make transcripts public.
Agent messages may repeat any repository or machine file the agent could read.
Treat the database, transcripts, branches, and worktrees as sensitive data.

## Start and inspect Factory

The commands in this section use local mode. In Tailscale mode, use the
separate CLI URL documented below and open the HTTPS URL printed by
`tailscale serve` in the browser.

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

In Tailscale mode, point the CLI at its separate listener:

```sh
vp node apps/cli/src/main.ts snapshot --url http://127.0.0.1:4318/rpc
```

Never proxy the local CLI listener. Factory does not install, configure, start,
or stop Tailscale. After Factory starts, expose only the main port:

```sh
tailscale serve --bg 4317
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
The integration command does not restart the service, so its database may keep
the last active state until the next normal startup records the interruption.
On every exit after startup, the runner stops the application, Codex process
group, and HTTP listener.

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

The RPC API provides paginated reads for issues, attempts, transcripts,
lifecycle and provider events, authoritative usage, and timeline entries. Keep
the first page's watermark on every later request. That watermark fixes the
records, values, and ordering even if a new attempt arrives during traversal.

After a failed or completed run, remove files only after preserving anything
needed for diagnosis. The current release has no cleanup command.

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

Receipt replay and all attempts survive restart. Factory interrupts unfinished
attempts and does not resume or retry them. If provider process ownership is
uncertain, the attempt continues to consume capacity until an operator can
resolve it. Cancellation, stall detection, and automatic cleanup are deferred.
Remote console access is available through the Tailscale mode described above.
