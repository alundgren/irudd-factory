# Prototypes

Two prototypes were completed in order. The retained production packages now
implement the second one.

Both work under the same three rules as the product: only issues whose author
has write permission are eligible, `gh` and Codex run with the operator's
ambient credentials, and Codex writes only to the retained worktree and its
required Git directories. The trades are in
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

**The ordinary runtime inherits configuration.** The probe used an isolated
`CODEX_HOME` to measure the protocol. Factory deliberately uses the operator's
ordinary `~/.codex`, so configured MCP servers, hooks, plugins, skills, and
instructions may be active. Factory does not inspect or copy credentials.

## 2. Dispatcher slice (done)

Intent: prove the loop end to end on one repository, with real processes and
one real issue. Check eligibility, reserve an issue exactly once, create
the workspace, run one Codex session under the settings prototype 1 proved, and
record the result durably enough to explain a failure hours later.

The production packages use the proven launch contract with stricter approval,
diagnostic retention, and shutdown behavior.

The implemented path is:

```text
one configured GitHub issue
  -> candidate query finds exactly it, author write permission checked
  -> assignment.reserved committed
  -> app-owned clone and worktree created, writable roots named
  -> provider.start.requested committed
  -> codex app-server runs one unattended turn in that worktree
  -> provider thread and turn evidence committed
  -> pull request repository, branch, and closing issue verified
  -> the console shows each state change and survives a reload
```

Deterministic fixtures exercise the path without live GitHub or Codex. The
provider probe remains the live evidence for App Server behavior.

| In scope                                                  | Out of scope                                         |
| --------------------------------------------------------- | ---------------------------------------------------- |
| One repository, one selected issue, native blocker check  | Repository pools, polling, queues                    |
| Reservation, retained workspace, one Codex turn, console  | Cleanup, attribution comments, cancellation          |
| Event log, assignment projection, durable command receipt | Nonterminal restart recovery, archival, log browsing |
| One console page with assignment state and the run result | Controls beyond starting a run and reconnecting      |
| Bun, SQLite, Effect, Effect RPC, React                    | systemd, remote access, authentication, deployment   |

Use a disposable repository and an issue you created yourself, so the write
permission check passes for the reason it is meant to.

Done means one command starts the service and console, the browser shows
`reserved`, `starting`, `running`, then `completed`, and reloading it reads the
same state back from SQLite. The stored record must identify the issue, the
assignment, the Codex CLI version, the provider session, and the terminal
outcome.

It does not recover nonterminal work after a process restart. Cancellation,
provider pauses, remote access, and deployment also remain deferred.
