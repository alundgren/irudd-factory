# Operator console refinement mockup

This folder records the selected direction for the long-term Factory operator
console. The mockup combines an operations overview with a provider session
timeline. It is a self-contained HTML design study with static sample data and
small working interactions. It does not change the production console.

[Open the local mockup](./console-01-operations-desk.html)

[View the published mockup](https://repo-control.irudd.net/public/nkdknctnptiiulygexuxeumlsohkuqmf/view)
or [download the published HTML](https://repo-control.irudd.net/public/nkdknctnptiiulygexuxeumlsohkuqmf/download).
The Repo Control copy expires on 2 October 2026 at 18:00 UTC. The HTML in this
folder is the durable copy. The published artifact predates small corrections
made during plan review, so use the repository HTML when the two differ.

## Purpose

The mockup gives UI and backend refinement one shared artifact. The goal is to
review the operator workflow, settle the required product and data decisions,
and turn the result into one implementation epic with independently useful
backend and UI issues.

The two primary operator tasks are separate views:

- Overview answers what needs attention, what is working, what can start next,
  and whether a provider or usage limit may prevent new work.
- Timeline compares current and recent sessions across providers and opens any
  session for inspection.

Both views use the same session inspector. An operator can read agent turns,
see tool activity, handle an approval, send a message, stop a session, copy its
worktree path, or open its GitHub issue.

## Selected direction

### Overview

The conventional administration layout is the default landing view. Active
sessions and the ready queue get most of the page. Usage, provider state, and
recent activity stay in a narrower column. The global dispatch control remains
visible at the top.

Each active session shows its issue, state, elapsed time, provider, model,
effort, and token count. Selecting a session opens the shared inspector instead
of navigating away from the queue. The design does not claim a completion
percentage because the current provider contract supplies no such fact.

The ready queue keeps a manual "Start now" action visible while automatic
dispatch is active. This needs a product decision before implementation: the
service must either guarantee that manual and automatic selection use the same
reservation transaction, or the UI must prevent both actions from racing.

### Timeline

Timeline is a destination in the left navigation. It uses one lane per
provider and places sessions according to start time and elapsed duration.
Status, model, effort, and tokens remain readable without opening a session.

The timeline deliberately omits usage reports, dispatch controls, manual start
actions, provider switches, and the operations feed. Those already have homes
in Overview. Timeline only answers when sessions ran, which provider handled
them, and where attention is needed.

The provider column remains fixed while the timeline scrolls horizontally on a
narrow screen. Another refinement pass should decide whether preserving time
relationships is worth that interaction on phones.

### Session inspector

The inspector is shared by Overview and Timeline. The mockup includes the
original prompt, agent messages, tool activity, a pending approval, a message
composer, and session controls.

The final design needs distinct states for an active session, a completed
session, a failed session, an archived session, and an issue with several
attempts. Message input and approval actions should only appear while the
provider can still accept them.

Stopping work needs explicit consequences. "Stop session", "Stop and return to
queue", "Archive", and "Restart" cannot be aliases because they affect the
workspace, issue eligibility, `claimed` label, and history differently.

## Product goals represented by the mockup

- See issues eligible to be picked up.
- See active work and the model and effort handling it.
- Follow an issue during a run or after completion.
- Inspect agent turns, send a message, and respond to an approval.
- Stop an active session and optionally return its issue to the queue.
- Restart a failed session without losing the earlier attempt.
- Compare token and limit usage per session, week, month, provider, model, and
  agent harness, including provider-specific 5-hour windows.
- Start or stop a provider and pause or resume automatic dispatch.

## Current implementation

The current implementation supports one repository and one active Codex
assignment. The console calls `RunNextEligibleIssue` and polls
`GetFactorySnapshot`. It shows the durable command receipt, one assignment,
retained workspace paths, pull request evidence, errors, and assignment event
history.

The existing durable assignment records issue identity, provider, requested
and observed model settings, Codex version, one thread ID, one turn ID,
workspace, pull request, error, timestamps, and an ordered event sequence. The
provider result contains item summaries and token totals, but the assignment
projection and snapshot do not expose a durable interactive transcript.

Approval requests currently fail an assignment. Service shutdown interrupts
the active Codex turn, but the RPC API does not expose operator cancellation,
restart, archive, provider control, messaging, or approval commands. Automatic
polling, queues, multiple providers, usage-window tracking, and recovery of
nonterminal assignments are also deferred.

## Technical decisions needed

### Durable identities and history

Define the relationship among GitHub issue, assignment, provider session,
thread, turn, and restart attempt. One issue may have several attempts, and
each attempt must retain its own provider settings, events, usage, error, and
workspace evidence.

Define separate durable identities and cardinality for provider adapter,
configured provider instance, account or quota owner, capacity slot, and
running provider process or session. The migration must replace or justify the
current unique index on the assignment provider string and map existing
`provider = "codex"` rows without losing history.

Decide whether agent items are stored as assignment events or in dedicated
turn and item tables. The choice must support ordered replay, partial provider
data, pending approvals, messages sent after a reload, and efficient timeline
queries.

### Queue and dispatch

Define candidate ordering across repositories, reservation timing, provider
selection, per-provider concurrency, and the interaction between manual start
and automatic dispatch. Queue entries need enough explanation to show why an
issue is eligible or why it stopped being eligible.

Pausing dispatch should prevent new reservations without interrupting active
work. Stopping a provider needs a separate policy for its active session.

### Session commands and recovery

Specify state transitions and idempotency for stop, return to queue, archive,
restart, message, and approval commands. Create a consequence table for every
command and source state. It must record whether the command is allowed, the
target identity and expected version, retry behavior, GitHub issue state and
labels, existing pull request and branch behavior, workspace retention,
provider-process effect, transcript and history result, and reversal path.
Preserve the rule against automatic retry. Manual restart is a separate
operator action.

Recovery after a service restart must reconcile any assignment left reserved,
starting, or running before the UI offers actions that assume the provider is
still connected.

### Usage

Identify the authoritative usage and limit data available from each provider.
Store usage with session, provider, model, agent harness, and timestamp so the
UI can derive session totals and 5-hour, weekly, and monthly views without
mixing incompatible provider limits.

The design needs explicit states for unknown limits, delayed updates, missing
usage events, and a provider that reports tokens but no percentage allowance.

### Transport and access

Decide whether polling remains sufficient for active turns and approvals or
whether the console needs a server event stream. Commands must survive a
transport retry without sending a message twice or approving the wrong turn.

The service currently binds unauthenticated HTTP to loopback. Before adding
mutating console commands, decide which local callers and browser origins may
use them. Define same-origin enforcement, request-forgery protection, command
authorization, and how the console reports an unavailable capability. Remote
or tailnet access is a separate decision with its own authentication needs.

### Fixtures and proof

Use three evidence stages. First, consume completed issue #16 evidence about
the current real console. Second, inspect named static mockup states derived
from that evidence. Include empty, delayed, failed, disconnected, pending
approval, restart, archive, long-history, overlapping-session, long-title,
narrow, and pagination or virtualization variants. Third, write deterministic
fixture specifications for the executable implementation issues.

The future implementation suite should extend application-owned deterministic
scenarios instead of using live GitHub repositories or provider processes in
automated tests. Its read APIs need bounded queries, stable ordering, and an
explicit retention policy instead of one unbounded replacement snapshot.
Executable child issues will own implementation and live desktop and narrow
fixture proof.

Dangerous actions need visible confirmation and a verifiable result. Copying a
worktree path needs success and failure states because browser clipboard access
can be unavailable.

## Release boundary

Before publishing the epic, classify every mockup capability as included in
that epic, deferred to a named later refinement, or removed. The current manual
single-repository milestone should not silently expand into multi-repository,
multi-provider, interactive, remote operation in one delivery.

The repository product, architecture, stack, operator, and security records
must reflect settled decisions. This refinement owns the console, provider
control, and scheduling details it resolves. Product draft #1 remains the
record for broader Factory questions, and it should receive a link to the
resulting epic when refinement finishes.

Those repository decisions belong in a separate decision-record PR linked from
the refinement issue and this mockup PR. That PR must merge before the epic is
published. The mockup PR remains limited to the selected HTML and this README.

## Refinement output

Refinement is complete when the mockup and this record agree on the operator
workflow, the technical decisions above are settled, and GitHub contains a
reviewed epic with direct executable child issues and native dependencies.

Each child issue should deliver one independently useful behavior with a named
test or live fixture check. Likely groups include durable session history,
queue and dispatch, interactive provider turns, recovery commands, usage
aggregation, provider controls, the overview UI, the timeline UI, and the
session inspector. These are investigation areas, not a committed issue split.

## Validation record

The combined desktop view was inspected at 1400 by 900 CSS pixels. Overview and
Timeline navigation worked, session selection opened the shared inspector, and
the browser reported no console errors. The inline JavaScript also passed a
syntax check.

The earlier component views were inspected at 390 by 844 CSS pixels. The
collaborative browser timed out while applying its phone preset to the combined
file, so a narrow check of the combined navigation and timeline remains part of
the next refinement session.
