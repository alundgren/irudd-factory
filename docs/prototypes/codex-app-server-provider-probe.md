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

## Resumed live validation

Validation resumed from Factory commit
`9b719cfdee5d1271835577b16083cd352556d250`. The authenticated `doctor` run
passed every assertion. The first `read` run then completed the requested turn
with the expected behavior:

- `model/list` advertised `gpt-5.6-luna` with low effort.
- `turn/start` requested Luna with low effort.
- `thread/settings/updated` confirmed Luna, low effort, and the read-only
  sandbox with network disabled.
- The command read the fixture README and returned the exact expected heading.
- The turn completed, emitted token-usage updates, requested no approval, made
  no Git change, and emitted no reroute.

The probe still returned `assertion_failed`. Codex CLI 0.151.0 puts the
selected model at `thread/start.result.model`, while the probe reads only
`thread/start.result.thread.model`. The real thread object has no nested model,
so the manifest records the observed model as absent. The fake App Server uses
the nested field and did not expose this mismatch in automated tests.

Required refinement: read the model from `thread/start.result.model`, confirm
it from `thread/settings/updated.params.threadSettings.model`, and record and
verify the observed effort from the same settings event. Update the fake App
Server and tests to match Codex CLI 0.151.0. Keep reroute detection unchanged.
Then start a new campaign and repeat the ordered live scenarios from the first
read run.
