# Accepted security limitations

One installation serves one developer, on one dedicated VM, on repositories
that developer owns. Every trade below is accepted on that basis and must be
revisited before any multi-user, shared-host, or untrusted-repository use.

## Reads are not restricted

The released Codex App Server cannot restrict readable roots, so an agent can
read anything the VM user can: other workspaces, the Codex home, run artifacts.

Mitigation: writes are restricted instead. An agent writes only to its retained
worktree, its linked-worktree Git directory, and the shared Git directory needed
to commit and push. Do not put unrelated data on this machine.

## Agents act with the operator's GitHub identity

`gh` and Codex run with the operator's ambient credentials rather than a
repository-scoped token, so an agent that escaped its instructions could reach
any repository the operator can write.

The alternative was measured and rejected: Codex CLI 0.151.0 writes the child
environment to `$CODEX_HOME/shell_snapshots/<id>.sh` at mode `0644`, so an
injected `GH_TOKEN` is written to disk in plaintext. A scoped token would limit
which repositories are reachable but would leave a credential on disk after the
run.

Mitigation: only issues whose author has write permission are eligible, so the
prompt reaching an agent already comes from someone who could write to that
repository directly.

## Runs are unattended

Turns use `approvalPolicy: "never"`. Nothing pauses for a human, so containment
rests on the sandbox, the writable roots, and the eligibility rule, not on an
operator reading a prompt.

The Codex command sandbox permits network access because the agent must push
its branch and open a pull request. App Server's own provider connection is
separate from the command sandbox.

Mitigation: every run asserts that no approval was requested, which turns an
unexpected prompt into a failed run rather than a silent hang.

## Factory inherits ordinary Codex configuration

Factory launches Codex with the operator's ordinary `~/.codex`. Configured MCP
servers, apps, hooks, plugins, skills, and instruction files can affect a run.
Factory records observed provider events but does not inspect credentials or
copy authentication files into an isolated home.

Mitigation: operate Factory as the same trusted user who owns that configuration
and review integrations before enabling unattended work.

## Console access depends on its configured mode

Local mode accepts unauthenticated requests on one IP-loopback listener. It
allows Origin-less CLI requests and same-origin browser requests. Do not proxy
or forward this listener.

Tailscale mode binds its main listener only to `127.0.0.1` and requires the
configured `Tailscale-User-Login` on requests forwarded by Tailscale Serve. Its
second listener accepts Origin-less CLI RPC on another loopback port. That
listener has no identity check and must not be proxied. A process running as
the same VM user can still call either loopback listener directly.

Mitigation: expose only the Tailscale-mode main port through Tailscale Serve.
Do not expose the local CLI port, and keep untrusted processes off the VM.
