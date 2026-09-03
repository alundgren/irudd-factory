# Stack and conventions

These are the implemented decisions for the current product.

## Runtime

Node.js 24 and TypeScript 5.9.2 are pinned. TypeScript runs in strict mode with
`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Effect and the
Effect platform and RPC packages are pinned to tested releases.

## State

SQLite uses Node's built-in SQLite support with WAL, foreign keys, a five-second busy
timeout, and hand-written forward migrations.

Everything durable goes in the database: assignments, provider state, thread
and turn identifiers, workspace paths, events, command receipts, diagnostics,
and pull request evidence. There is no JSONL side channel.

The application validates a command, appends events, and updates an assignment
projection. The command receipt, assignment projection, and reservation event
commit in one `BEGIN IMMEDIATE` transaction. A partial unique index permits
only one Codex assignment in `reserved`, `starting`, or `running`.

The core durable tables are:

- `issues`: one GitHub issue identity shared by all of its attempts
- `assignment_events`: ordered sequence, assignment ID, type, timestamp, and JSON payload
- `assignments`: one attempt with provider settings, workspace, diagnostics, and pull request projection
- `command_receipts`: client command ID mapped to the original accepted or rejected result
- `attempt_transcript`, `retained_provider_events`, and `attempt_usage`: filtered provider evidence
- `read_snapshots`: immutable page values referenced by traversal watermarks

Receipt replay happens before GitHub discovery, so restarting the service does
not change the result returned for an existing command ID. Factory records
`provider.start.requested` before spawning Codex and records the thread ID
before marking an assignment `running`. Startup interrupts nonterminal
attempts after it resolves provider process ownership. Once process exit is
confirmed, Factory performs at most one read-only pull request lookup and
keeps verified evidence without resuming the attempt.

## Provider

The application depends on a `Provider` port. Codex is the only adapter. It
uses JSON-RPC over App Server standard input and output without a TTY. Before
starting a thread, the adapter checks that App Server offers the configured
model and reasoning effort. It generates and validates the installed protocol
schemas, then records their digest with the provider thread.

The adapter normalizes the App Server thread ID, turn ID, item summaries,
token usage, final message, model, reasoning effort, CLI version, approvals,
reroutes, errors, and process exit. A missing model, an effort mismatch, or a
model reroute fails the assignment instead of selecting another configuration.

Codex runs as `codex app-server --strict-config` with the operator's ordinary
`~/.codex`. Any approval request fails the assignment immediately. The turn
names the worktree and its Git directories as writable roots and permits
network access so Codex can push its branch and open the pull request. Shutdown
first attempts `turn/interrupt`, then stops the owned process group within one
total deadline.

## Console

React, Vite, and Tailwind provide one operator page. The console and CLI use the
same Effect RPC group. The console submits `RunNextEligibleIssue`, polls
`GetFactorySnapshot`, and shows the durable receipt, current assignment,
retained paths, pull request, errors, and event history.

Local access uses unauthenticated HTTP on one IP-loopback listener. Tailscale
access requires the configured `Tailscale-User-Login` on the main console and
RPC listener, plus a matching HTTPS Origin for browser RPC. Its second
IP-loopback listener accepts only Origin-less CLI RPC. Server streams are
deferred.

## Effect

Effect wraps I/O, resources, transactions, concurrency, schemas, and RPC.
`Layer` supplies SQLite, GitHub, workspace, and provider services. `Schema`
validates GitHub responses, stored payloads, configuration, and protocol
messages.

Selection rules, transitions, and prompt building stay ordinary TypeScript
where an Effect service is unnecessary. Fixture definitions live under
`apps/service/fixtures`; discovery and contract tests consume their typed
metadata, state, fake behavior, and expectations.

## Operations

The service is currently started manually and binds to loopback. The operator
may expose the authenticated main listener with Tailscale Serve. Factory does
not install, configure, start, or stop Tailscale. systemd, cancellation, stall
detection, and workspace cleanup remain deferred.

## Eligibility labels

An issue is eligible when it is open, labelled `ready-for-agent`, not labelled
`claimed`, `ready-for-human`, `epic`, or `needs-refinement`, every native
blocking dependency is closed, and its author has write permission to that
repository. The dispatcher adds `claimed` before any work starts and never
removes or overrides an existing one.

## WORKFLOW.md

Each target repository owns a `WORKFLOW.md`: YAML front matter for policy and
the prompt template as the body. Factory resolves the default branch commit,
loads the file at that exact commit, validates it, and persists the commit, blob
ID, and SHA-256 digest. A missing or invalid file rejects the command.

The current front matter is:

```yaml
required_labels: [ready-for-agent]
forbidden_labels: [claimed, ready-for-human, epic, needs-refinement]
runtime: node
test: vp run test
```

## Prior art

[T3 Code](https://github.com/pingdotgg/t3code) informed the process ownership,
typed protocol, event recording, and test discipline above. It is prior art,
not a source copied wholesale.
