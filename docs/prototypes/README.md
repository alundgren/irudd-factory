# Prototypes

Two prototypes, in order. The first is finished. The second has not started.

Both work under the same three rules as the product: only issues whose author
has write permission are eligible, `gh` and Codex run with the operator's
ambient credentials, and writable roots are the containment. The trades are in
[SECURITY-LIMITATIONS.md](../../SECURITY-LIMITATIONS.md).

## 1. Codex App Server provider probe (done)

`prototypes/codex-app-server-probe`.

Intent: prove the Codex launch contract against the real provider before its
behaviour is assumed in production code. Automated tests only prove the client
we wrote, so the probe runs live scenarios and records evidence: `doctor`,
`read`, `edit`, `pr`, `fail`, and `interrupt`.

All six pass on macOS 26.6.2 with Bun 1.3.14 and Codex CLI 0.151.0, unattended,
with zero approvals requested.

### What we learned

**The launch contract holds.** `codex app-server` over JSON-RPC stdio needs no
TTY. `thread/start` establishes the session and returns the thread id; the
selected model is at `thread/start.result.model`, not inside the nested thread
object, and `thread/settings/updated` confirms model and effort on write turns
but is not emitted for read-only turns. Turn outcome, token usage, item
lifecycle, reroute events, and process exit are all observable. `turn/interrupt`
ends a turn as `interrupted`, and killing the process group is clean, which is
what stall handling needs. Codex commits, pushes, and opens the pull request
itself.

**Unattended needs two settings.** `approvalPolicy: "never"`, and `.git` named
as a writable root. Workspace write refuses Git metadata writes unless the
directory is named, so without it Codex asks permission to commit and a run
with nobody watching would hang. Networking stays off except where a push
needs it.

**Injected tokens land on disk.** Codex CLI 0.151.0 writes a snapshot of the
child environment to `$CODEX_HOME/shell_snapshots/<id>.sh` at mode `0644`. A
`GH_TOKEN` passed to the agent is written there in plaintext. This is why the
product uses ambient credentials instead of a minted token.

**Reads cannot be restricted.** The released App Server has no restricted
readable roots, so an agent can read anything the VM user can. Writes are the
only containment available.

**The runtime is not empty.** Codex starts a built-in `codex_apps` MCP server
even with no servers configured, and an isolated `CODEX_HOME` is required or
the operator's own MCP servers, hooks, and `AGENTS.md` are inherited.

## 2. Dispatcher slice (not started)

Intent: prove the loop end to end on one repository, with real processes and
one real issue. Poll, check eligibility, reserve an issue exactly once, create
the workspace, run one Codex session under the settings prototype 1 proved, and
record the result durably enough to explain a failure hours later.

It uses the proven launch contract rather than rediscovering it, and the
decisions in [stack.md](../stack.md) rather than choosing again.

The path it proves:

```text
one configured GitHub issue
  -> candidate query finds exactly it, author write permission checked
  -> assignment.reserved committed
  -> app-owned clone and worktree created, writable roots named
  -> provider.start.requested committed
  -> codex app-server runs one unattended turn in that worktree
  -> provider.session.started and provider.turn.finished committed
  -> the console shows each state change and survives a reload
```

Run it on the Mac first. The same Bun, `gh`, and Codex credentials as the
future Linux service, without adding network, filesystem-sharing, and
credential-forwarding problems before the flow itself works. Repeat on Linux
before choosing the deployment image.

| In scope | Out of scope |
| --- | --- |
| One repository, one label, one selected issue | Repository pool ordering, dependency checks, poll scheduling |
| Reservation, workspace, one Codex session, projection, console | Retained workspaces, cleanup policy, attribution comments |
| Event log, assignment projection, command receipt | Replay tooling, archival, log browsing |
| One console page with assignment state and the run result | Controls beyond starting a run and reconnecting |
| Bun, SQLite, Effect, Effect RPC, React | systemd, Tailscale, console authentication, deployment |

Use a disposable repository and an issue you created yourself, so the write
permission check passes for the reason it is meant to.

Done when one command starts the service and console, the browser shows
`reserved`, `starting`, `running`, then `completed`, and reloading it reads the
same state back from SQLite. The stored record must identify the issue, the
assignment, the Codex CLI version, the provider session, and the terminal
outcome.

It does not prove restart recovery, cancellation, provider pauses, or
deployment. Those come after.
