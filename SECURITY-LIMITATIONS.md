# Accepted security limitations

This installation permanently serves one developer working on trusted
repositories on a dedicated development machine. The limitations below are
accepted deliberately. Each must be revisited before any multi-user,
shared-host, or untrusted-repository use, and before the first real release.

## Agent reads are not restricted to the workspace

The released Codex App Server runtime does not restrict readable roots. Agent
commands can read the campaign Codex home, sibling run directories, and any
other file available to the operating-system user. Writes remain restricted to
the scenario workspace and its `.git` directory.

## The pr path acts with the operator's full GitHub identity

The `pr` scenario uses the ambient `gh` login and Git credential helper of the
operator instead of a repository-scoped token. macOS keeps both in the login
keychain, reached through the operator `HOME`, so the `pr` child receives that
home. An agent that escaped its instructions could therefore reach any
repository the operator can write, not only the disposable testing repository.

The alternative was measured and rejected. Codex CLI 0.151.0 writes a shell
snapshot of the child environment to `$CODEX_HOME/shell_snapshots/<id>.sh` at
mode `0644`, so an injected `GH_TOKEN` is written to disk in plaintext. A
dedicated fine-grained token bought a smaller blast radius at the cost of a
credential on disk that survives the run.

A future dispatcher that runs untrusted or third-party issues needs a
short-lived token minted per run, or a credential helper the agent never sees
as an environment variable, whichever the provider supports by then.

## Turns run unattended

Turns use `approvalPolicy: "never"`, so nothing pauses for a human decision.
Containment rests entirely on the sandbox policy and the allowed roots, not on
an operator reading a prompt. Every run asserts that no approval was requested,
which turns a surprise prompt into a failed run rather than a hang.
