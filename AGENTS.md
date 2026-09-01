# Agent test rules

Never run `vp test` or `bun test` directly. A direct `vp test` uses Node.js,
which cannot load `bun:sqlite` or call `Bun.spawn`. Direct `bun test` scans
`prototypes/` as well. Use the package scripts through `vp run`; they launch
Vite+/Vitest through Bun with the root test configuration.

Use the focused component suite while changing a component. Pass Vitest's `-t`
option to run one test, for example:

```sh
vp run test:application -t "builds the narrow preclaimed prompt"
```

Run `vp run check` and `vp run test` after the implementation is complete.

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
