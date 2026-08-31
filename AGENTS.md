# Agent test rules

Never run `bun test` directly. It scans `prototypes/` as well, and prints a line
per passing test. Use the component scripts instead.

Use the focused component suite while changing a component. Pass a test name
after `--` to run one test, for example:

```sh
bun run test:application -- "builds the narrow preclaimed prompt"
```

Run `bun run test` after the implementation is complete. Successful test runs
print one summary line. Failed runs print the captured Bun diagnostics.

Tests never depend on a build artifact. Serve static fixtures the test itself
writes, so `bun run test` stays independent of `bun run build:console`.

Console changes require a live fixture check. Start one named fixture with
`bun run fixture -- <scenario>`, open the printed URL with the available
browser-control tool, and inspect the relevant states at desktop and narrow
viewports. Automated UI assertions do not replace this check.

Do not use a real GitHub repository, Git worktree, or Codex process in automated
tests. Use the application-owned deterministic scenarios and adapter fakes.

# Code rules

Bind SQLite parameters by name. A positional `?` list silently shifts every
value after a column that moves.

Throw `FactoryError` with a code, never a bare `Error`. A bare Error escapes the
typed error channel as an untagged defect.

Decode only what the type system cannot already guarantee: JSON columns, enums,
and network payloads. Re-decoding an already-typed value is noise.

Emit durable event names from `ASSIGNMENT_EVENTS` in contracts, not from string
literals at the call site. Tests keep the literals so a rename cannot pass
silently.
