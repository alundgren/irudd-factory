# Codex App Server provider probe: macOS discovery finding

Validation of the merged probe implementation stopped at `doctor` on macOS
26.6.2. The automated probe checks passed: 52 tests, formatting, and
TypeScript checks. No Codex login, GitHub PAT, live scenario, or remote
repository change was performed.

The installed environment was Bun 1.3.14 and Codex CLI 0.151.0. The generated
schema included the required protocol markers, but it did not declare the
restricted filesystem-read fields required by the probe:

- `readOnly.access`
- `workspaceWrite.readOnlyAccess`
- `readableRoots`
- `includePlatformDefaults`

The probe therefore returned `assertion_failed` and correctly refused to run a
scenario without being able to verify that the agent cannot read the isolated
Codex home, sibling runs, or unrelated files. The schema digest for this
environment was
`9ae2de39fabf5ff912237ce521edd5d70e5ece4da2e0d02f34644a082900cf0b`.

Required refinement: obtain a released Codex App Server/runtime version whose
generated schema declares these restricted-read fields and whose macOS sandbox
enforces them, or update the probe against a versioned equivalent contract.
The containment checks must remain fail-closed. After that capability is
available, rerun `doctor` and the ordered live scenarios from issue #5.

Related upstream tracking: [openai/codex#40116](https://github.com/openai/codex/issues/40116).
