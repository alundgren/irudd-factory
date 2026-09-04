# Agent test rules

Run active tests through the package scripts with `vp run`. The scripts invoke
Vite+/Vitest with the root test configuration.

Use the focused component suite while changing a component. Pass Vitest's `-t`
option to run one test, for example:

```sh
vp run test:application -t "builds the narrow preclaimed prompt"
```

Run `vp run check` and `vp run test` after the implementation is complete.
`vp run check` includes `vp check`, whose file length, function length, and
cyclomatic complexity warnings are design prompts. Address them when that
improves the code, or leave them with a brief explanation when it does not.
CI must use `vp run check:ci`, which still fails on lint and type errors but
does not publish advisory warnings.

Tests never depend on a build artifact. Serve static fixtures the test itself
writes, so `vp run test` stays independent of `vp run build:console`.

Console changes require a live fixture check. Start one named fixture with
`vp run fixture <name>`, open the printed URL with the available
browser-control tool, and inspect the relevant states at desktop and narrow
viewports. Automated UI assertions do not replace this check.

Do not use a real GitHub repository, Git worktree, or Codex process in automated
tests. Use the catalog under `apps/service/fixtures` and its adapter fakes. Run
`vp run fixture` to browse names and `vp run fixture <name> --describe` for a
human-readable description. Agents and scripts must use
`vp node scripts/fixture.ts --json` for the catalog and
`vp node scripts/fixture.ts <name> --describe --json` for structured details.
These direct commands keep stdout parseable by excluding task-runner output.

# Code rules

Bind SQLite parameters by name.

Throw `FactoryError` with a code, never a bare `Error`.

Decode only what the type system cannot already guarantee: JSON columns, enums,
and network payloads.

Extract magic strings into common constants.
