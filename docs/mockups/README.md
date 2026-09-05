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

[Decision record PR #55](https://github.com/alundgren/irudd-factory/pull/55)
settled the product and backend decisions used for publication. The record is
the authority when this early mockup and the implementation scope differ.

The two primary operator tasks are separate views:

- Overview answers what needs attention, what is working, what can start next,
  and whether a provider or usage limit may prevent new work.
- Timeline compares current and recent sessions across providers and opens any
  session for inspection.

Both views use the same session inspector. The mockup explores agent turns,
tool activity, approvals, messages, lifecycle controls, paths, and issue links.
The first product epic keeps the inspector read-only apart from lifecycle,
copy, and navigation controls. Live messages and approvals move to a separate
refinement issue.

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
dispatch is active. Manual and automatic selection use the same reservation
transaction so they cannot consume one slot twice or start one issue twice.

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

The implementation needs distinct states for an active session, a completed
session, a failed session, an archived session, and an issue with several
attempts. Message input and approval actions do not ship in this epic.

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

## Questions resolved for publication

The sections below preserve the questions raised by the design study. The
answers are recorded in merged
[PR #55](https://github.com/alundgren/irudd-factory/pull/55). Executable issues
will quote the relevant decisions and tests instead of asking implementers to
settle them again.

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

## Capability assignment

| Mockup capability | Publication decision | Destination |
| --- | --- | --- |
| Active work, ready queue, Codex slots, recent activity, known token totals, and read-only configuration | Include | `Build the Operations overview and ready queue` |
| Automatic FIFO dispatch, manual Start now, pause and resume, and Codex enable and disable | Include | `Dispatch a durable FIFO queue into available Codex slots` and the Overview issue |
| Several repositories with global Codex defaults and repository overrides | Include | `Run selected issues across a configured repository pool` |
| Retained attempt history and point-in-time transcripts | Include | `Preserve attempt transcripts, usage and restart outcomes` |
| Stop, return, restart, archive, and restore | Include | `Control attempt lifecycle without losing prior work` |
| Session list, shared inspector, paths, errors, pull requests, and sibling attempts | Include | `Inspect every retained attempt from the console` |
| Codex attempt timeline with concurrent slots | Include | `Compare retained attempts on a provider timeline` |
| Local development and authenticated Tailscale Serve access | Include | `Enforce separate local and Tailscale console access modes` and `Verify the operator console through Tailscale Serve` |
| Live turn following, outbound messages, and approval responses | Defer | `Refine live Codex interaction in the operator console` |
| Claude Code, Gemini CLI, and provider quota percentages or windows | Defer | `Refine additional providers and authoritative quota reporting` |
| Issue difficulty or agent-strength routing | Defer | Existing issue #3 |
| Editing Factory configuration in the console | Remove from this delivery | JSON remains the source; a later idea may revisit editing |
| Phone-specific redesign | Remove from this delivery | Preserve basic use at `390x844`; optimize `1400x900` first |

## Static-state review

| State | Mockup finding | Implementation destination |
| --- | --- | --- |
| Empty active list and empty queue | Not represented. The current sample always has active and queued work. | Overview deterministic fixture |
| Delayed refresh | The service timestamp is present, but there is no stale or delayed treatment. | Overview deterministic fixture |
| Failed attempt | Represented in active work and the timeline. The inspector still shows active-only controls. | Inspector and lifecycle fixtures |
| Disconnected service | Not represented. | Overview deterministic fixture |
| Pending approval | Represented in the inspector, but interaction is deferred. The first epic may show the retained event without action buttons. | Live-interaction refinement |
| Restart and several attempts | Restart is named, but sibling-attempt history is absent. | Lifecycle and inspector fixtures |
| Archived attempt | Not represented. | Lifecycle and inspector fixtures |
| Long transcript history | Not represented. The inspector needs bounded pages and explicit truncation. | Transcript and inspector fixtures |
| Overlapping attempts | Represented across provider lanes, not as several Codex slots. | Codex timeline fixture |
| Long issue title | Timeline text truncates. Queue and inspector wrapping still need proof. | Overview, inspector, and timeline fixtures |
| Narrow layout | Navigation compacts, the page avoids horizontal overflow, and the timeline owns horizontal scrolling. | All three console issues at `390x844` |
| Pagination or virtualization | Not represented. | Queue, session, transcript, event, and timeline API fixtures |

The absent states are findings, not silent acceptance. Each named executable UI
issue must add its assigned deterministic fixture before it can close.

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

The combined desktop view was inspected at `1400x900` CSS pixels, then checked
again in a `1402x877` browser viewport. Overview and Timeline navigation worked,
session selection opened the shared inspector, and the browser reported no
console errors. The inline JavaScript also passed a syntax check.

The combined file was inspected in a `390x844` same-origin frame after the
collaborative browser resize control timed out. The frame reported a 390-pixel
viewport and a 375-pixel content width after its scrollbar. The document stayed
at 375 pixels with no page-level horizontal overflow. Timeline kept its
980-pixel board inside a 341-pixel scroll container. The open inspector settled
at 366.6 pixels wide, from 8.4 to 375 pixels, so its controls remained inside
the content area. Navigation, Timeline selection, session selection, and the
inspector all worked without console errors.
