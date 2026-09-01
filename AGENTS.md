# Agent test rules

Never run `vp test` or `bun test` directly. `vp test` invokes Vitest, which
cannot run this project's `bun:test` suites. Direct `bun test` scans
`prototypes/` as well and prints a line per passing test. Use the package
scripts through `vp run` instead.

Use the focused component suite while changing a component. Pass a test name
after the script name to run one test, for example:

```sh
vp run test:application "builds the narrow preclaimed prompt"
```

Run `vp run check` and `vp run test` after the implementation is complete.
Successful test runs print one summary line. Failed runs print the captured Bun
diagnostics.

Tests never depend on a build artifact. Serve static fixtures the test itself
writes, so `vp run test` stays independent of `vp run build:console`.

Console changes require a live fixture check. Start one named fixture with
`vp run fixture <scenario>`, open the printed URL with the available
browser-control tool, and inspect the relevant states at desktop and narrow
viewports. Automated UI assertions do not replace this check.

Do not use a real GitHub repository, Git worktree, or Codex process in automated
tests. Use the application-owned deterministic scenarios and adapter fakes.

# Code rules

Bind SQLite parameters by name.

Throw `FactoryError` with a code, never a bare `Error`.

Decode only what the type system cannot already guarantee: JSON columns, enums,
and network payloads.

Extract magic strings into common constants.
