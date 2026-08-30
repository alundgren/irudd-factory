# Agent test rules

Use the focused component suite while changing a component. Pass a test name
after `--` to run one test, for example:

```sh
bun run test:application -- "replays a durable receipt"
```

Run `bun run test` after the implementation is complete. Successful test runs
print one summary line. Failed runs print the captured Bun diagnostics.

Console changes require a live fixture check. Start one named fixture with
`bun run fixture -- <scenario>`, open the printed URL with the available
browser-control tool, and inspect the relevant states at desktop and narrow
viewports. Automated UI assertions do not replace this check.

Do not use a real GitHub repository, Git worktree, or Codex process in automated
tests. Use the application-owned deterministic scenarios and adapter fakes.
