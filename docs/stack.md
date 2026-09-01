# Stack and conventions

These are the implemented decisions for the manual single-repository milestone.

## Runtime

Bun 1.3.14 and TypeScript 5.9.2 are pinned. TypeScript runs in strict mode with
`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Effect and the
Effect platform and RPC packages are pinned to tested releases.

## State

SQLite uses Bun's SQLite support with WAL, foreign keys, a five-second busy
timeout, and hand-written forward migrations.

Everything durable goes in the database: assignments, provider state, thread
and turn identifiers, workspace paths, events, command receipts, diagnostics,
and pull request evidence. There is no JSONL side channel.

The application validates a command, appends events, and updates an assignment
projection. The command receipt, assignment projection, and reservation event
commit in one `BEGIN IMMEDIATE` transaction. A partial unique index permits
only one Codex assignment in `reserved`, `starting`, or `running`.

The first three tables are:

- `assignment_events`: ordered sequence, assignment ID, type, timestamp, and JSON payload
- `assignments`: issue, provider, policy, workspace, diagnostics, and pull request projection
- `command_receipts`: client command ID mapped to the original accepted or rejected result

Receipt replay happens before GitHub discovery, so restarting the service does
not change the result returned for an existing command ID. Factory records
`provider.start.requested` before spawning Codex and records the thread ID
before marking an assignment `running`. Automatic recovery of nonterminal
assignments is not part of this milestone.

## Provider

The application depends on a `Provider` port. Codex is the only adapter. The
adapter normalizes the App Server thread ID, turn ID, item summaries, token
usage, final message, model, reasoning effort, CLI version, approvals, reroutes,
errors, and process exit.

Codex runs as `codex app-server --strict-config` with the operator's ordinary
`~/.codex`. Any approval request fails the assignment immediately. Shutdown
first attempts `turn/interrupt`, then stops the owned process group within one
total deadline.

## Console

React, Vite, and Tailwind provide one operator page. The console and CLI use the
same Effect RPC group. The console submits `RunNextEligibleIssue`, polls
`GetFactorySnapshot`, and shows the durable receipt, current assignment,
retained paths, pull request, errors, and event history.

The current transport is unauthenticated HTTP bound only to an IP loopback
address. Authentication, server streams, and remote console access are deferred.

## Effect

Effect wraps I/O, resources, transactions, concurrency, schemas, and RPC.
`Layer` supplies SQLite, GitHub, workspace, and provider services. `Schema`
validates GitHub responses, stored payloads, configuration, and protocol
messages.

Selection rules, transitions, prompt building, and scenario descriptions stay
ordinary TypeScript where an Effect service is unnecessary.

## Operations

The service is currently started manually and binds to loopback. systemd,
Tailscale exposure, authentication, polling, queues, cancellation, stall
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
runtime: bun
test: bun run test
```

## Prior art

[T3 Code](https://github.com/pingdotgg/t3code) informed the process ownership,
typed protocol, event recording, and test discipline above. It is prior art,
not a source copied wholesale.
