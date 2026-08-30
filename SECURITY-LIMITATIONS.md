# Accepted security limitations

One installation serves one developer, on one dedicated VM, on repositories
that developer owns. Every trade below is accepted on that basis and must be
revisited before any multi-user, shared-host, or untrusted-repository use.

## Reads are not restricted

The released Codex App Server cannot restrict readable roots, so an agent can
read anything the VM user can: other workspaces, the Codex home, run artifacts.

Mitigation: writes are restricted instead. An agent writes only to its own
workspace and that workspace's `.git` directory. Do not put unrelated data on
this VM.

## Agents act with the operator's GitHub identity

`gh` and Codex run with the operator's ambient credentials rather than a
repository-scoped token, so an agent that escaped its instructions could reach
any repository the operator can write.

The alternative was measured and rejected: Codex CLI 0.151.0 writes the child
environment to `$CODEX_HOME/shell_snapshots/<id>.sh` at mode `0644`, so an
injected `GH_TOKEN` is written to disk in plaintext. A scoped token bought a
smaller blast radius at the cost of a credential on disk that outlives the run.

Mitigation: only issues whose author has write permission are eligible, so the
prompt reaching an agent already comes from someone who could write to that
repository directly.

## Runs are unattended

Turns use `approvalPolicy: "never"`. Nothing pauses for a human, so containment
rests on the sandbox, the writable roots, and the eligibility rule, not on an
operator reading a prompt.

Mitigation: every run asserts that no approval was requested, which turns an
unexpected prompt into a failed run rather than a silent hang.
