# Codex App Server provider probe: macOS discovery and decision

Validation of the merged probe implementation stopped at `doctor` on macOS
26.6.2. The automated probe checks passed: 52 tests, formatting, and
TypeScript checks. No Codex login, GitHub PAT, live scenario, or remote
repository change was performed.

The installed environment was Bun 1.3.14 and Codex CLI 0.151.0. The generated
schema included the required protocol markers, but it did not declare the
restricted filesystem-read fields originally required by the probe:

- `readOnly.access`
- `workspaceWrite.readOnlyAccess`
- `readableRoots`
- `includePlatformDefaults`

The probe therefore returned `assertion_failed` under its original contract.
The schema digest for this environment was
`9ae2de39fabf5ff912237ce521edd5d70e5ece4da2e0d02f34644a082900cf0b`.

The product decision has since changed. Each installation will permanently
serve one developer on a dedicated development VM, using repositories and
issues in that developer's trust domain. Filesystem read isolation between
workspaces is not a launch requirement for that product. The probe now accepts
the released App Server policy supported by Codex CLI 0.151.0: read-only turns
for observation, workspace-write turns with named writable roots, no temporary
directory writes, and command network access disabled unless the PR scenario
requests a named destination.

Agent commands may read the isolated Codex home, run artifacts, sibling
workspaces, and other files available to the VM user. That is an accepted
limitation, not a property the probe claims to prevent. The ordered live
scenarios may proceed. Before the first real release, the repository must add a
`SECURITY-LIMITATIONS.md` file that states the intended use and accepted risks.

Restricted reads would still improve the product, but they are no longer a
release dependency. Related upstream tracking:
[openai/codex#40116](https://github.com/openai/codex/issues/40116).
