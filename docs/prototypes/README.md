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

Intent: prove the loop end to end on one repository. Poll, check eligibility
including the author's write permission, reserve an issue exactly once, create
the workspace, run one Codex session under the settings above, and record the
result durably enough to explain a failure hours later.

It uses the probe's proven launch contract rather than rediscovering it.
