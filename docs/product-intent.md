# Product intent

Irudd Factory turns ready GitHub issues into pull requests without a human
starting each run.

A dispatcher daemon polls the configured repositories, picks one eligible
issue, reserves it so it is never started twice, creates an isolated workspace
for it, and runs a coding agent there. The agent implements the issue and opens
the pull request itself. The service records what happened so a failure hours
later can still be explained. An operator console shows running work and can
pause a provider, stop a run, or resume after a fix.

One installation serves one developer, on one dedicated VM, on repositories
that developer owns.

## The three rules it works under

**Only issues whose author has write permission.** Issue text reaches an agent
that can run commands, so the author check is a security control, not a
scheduling convenience. It runs before any workspace is created and before any
agent starts.

**`gh` and Codex run with ambient credentials.** The agent uses the operator's
existing Codex login and `gh` login on the VM. The service mints no token,
injects no token, and stores no token.

**Writable roots are the defence.** An agent may write only to its own
workspace and that workspace's `.git` directory. Reads are not restricted, so
containment means containment of writes, plus the eligibility rule above.

## What is deliberately not here

No retries: a failed run is something a human looks at. No tracker other than
GitHub. No multi-host coordination. The security trades these rules imply are
recorded in [SECURITY-LIMITATIONS.md](../SECURITY-LIMITATIONS.md).
