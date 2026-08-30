# Stack and conventions

Decisions already made, so a design session starts from them rather than
re-deriving them. Short by intent; the reasoning lives in the notes behind each
choice, not here.

## Runtime

Bun, pinned to a tested release in the VM image and in CI, so a runtime upgrade
cannot silently change how provider processes behave. TypeScript in strict
mode with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.

## State

SQLite through Bun's SQLite support, with WAL, foreign keys, a five-second busy
timeout, and hand-written migrations.

**Everything durable goes in the database.** Assignments, provider state,
session identifiers, workspace paths, events, command receipts, and run
diagnostics. No JSONL side-channel: one store makes size control and cleanup a
single problem instead of two.

A small event-sourced assignment engine sits on top. A command validates
current state, appends events, and updates a projection. One transaction
appends the events, applies the projection, and writes an idempotency receipt;
subscribers are notified only after it commits. A retry with the same command
ID returns the original result instead of starting a second session.

Three tables to start:

- `assignment_events` — ordered event ID, assignment ID, type, timestamp, JSON payload.
- `assignments` — the projection the console reads: issue identity, workspace path, session ID, state, last event sequence.
- `command_receipts` — client command ID to accepted sequence or named rejection.

First event types: `assignment.reserved`, `workspace.created`,
`provider.start.requested`, `provider.session.started`, `provider.paused`,
`assignment.cancelled`, `provider.turn.finished`, `pull-request.attributed`.

The failure case that matters is the gap between intent and side effect. Commit
`provider.start.requested` before spawning Codex, and `provider.session.started`
only once the adapter has a session ID. After a crash the reconciler resolves
requested starts that never produced one. Never record `running` before the
provider is actually running.

## Provider

One `ProviderAdapter` interface with `start`, `events`, `stop`, `healthCheck`,
and `dispose`. Codex is the only implementation; the interface is the seam that
leaves room for another harness without letting its stream format reach
scheduling code. Normalize every harness into one event record: session ID,
turn state, liveness timestamp, model, CLI version, error category, PR result.

The Codex launch contract is proven. Use the settings in
[prototypes](prototypes/README.md) rather than rediscovering them.

## Console

React with Vite+ and Tailwind. Effect RPC over an authenticated WebSocket, with
commands and server streams in one shared contract. Subscriptions are targeted:
a run page receives that run's events, not every event from every provider. It
is an operator dashboard, not an IDE.

## Effect, used deliberately

Effect wraps I/O, resources, transactions, concurrency, schemas, and RPC.
`Layer` supplies the SQLite, GitHub, workspace, and provider services. `Scope`
owns the child process and its readers, so cancellation closes them even when
the scheduler is interrupted. `Schema` validates GitHub responses, stored
payloads, and protocol messages.

Selection rules, state-transition deciders, and projection functions stay
ordinary pure TypeScript. Pin one tested Effect release and treat its compiler
support as part of the stack.

## Operations

systemd on a dedicated VM, listening only on the tailnet.

## Eligibility labels

An issue is eligible when it is open, labelled `ready-for-agent`, not labelled
`claimed`, not labelled `ready-for-human`, `epic`, or `needs-refinement`, every
native blocking dependency is closed, and its author has write permission to
that repository. The dispatcher adds `claimed` before any work starts and never
removes or overrides an existing one.

## WORKFLOW.md

Each target repository owns a `WORKFLOW.md`: YAML front matter for policy, the
prompt template as the body. Policy is versioned with the code it acts on.
Validate the front matter at load time and treat a repository without the file
as ineligible rather than defaulting.

Front matter keys to start with:

```yaml
poll_interval: 5m        # how often this repository is checked
required_labels: [ready-for-agent]
concurrency: 1           # active sessions allowed in this repository
runtime: bun             # what the agent should use to verify its work
test: bun test
```

## Prior art

[T3 Code](https://github.com/pingdotgg/t3code) informed the process ownership,
provider isolation, typed protocol, event sourcing, and test discipline above.
We are open about the influence; it is prior art, not a template transplanted
wholesale.
