# Irudd Factory

Irudd Factory polls configured GitHub repositories and runs eligible issues
through unattended Codex turns. It keeps a durable FIFO queue and records each
result in SQLite. It is built for one developer operating a dedicated machine
and repositories they own. The project was inspired by
[Symphony](https://github.com/openai/symphony/blob/main/SPEC.md).

The current implementation provides an automatic loopback-only service, CLI,
and browser console. It preserves eligibility tenure across restarts, fills a
configured Codex slot pool, revalidates before admission, claims each issue,
creates a retained linked worktree, runs Codex through App Server, and verifies
the resulting pull request. Manual starts use the same database transaction as
automatic dispatch.

## Development

Install Vite+ and the project dependencies:

```sh
curl -fsSL https://vite.plus | bash
vp install --frozen-lockfile
```

Vite+ installs the required Node.js runtime and the pinned pnpm release. Open a
new shell if the installer adds `vp` to your path but the current shell cannot
find it.

Lint, type-check, and run the active test suite:

```sh
vp lint
vp run typecheck
vp run test
```

List the deterministic local fixtures:

```sh
vp run fixture
```

Scripts and agents can read the compact catalog as one JSON document with:

```sh
vp node scripts/fixture.ts --json
```

Inspect one fixture, then launch it:

```sh
vp run fixture runnable --describe
vp run fixture runnable
```

The command prints the console URL and keeps the service running until you stop
it with Ctrl-C. See the [operator guide](docs/operator.md#deterministic-fixtures)
for catalog and JSON discovery commands.

Copy [`factory.example.json`](factory.example.json) to `factory.json` and adjust
the repository and paths to run the normal service against GitHub.

Run one deliberate live integration assignment with:

```sh
vp run test:integration
```

This command is opt-in. It creates a real issue and lets Factory run Codex in
the dedicated testing repository. It prints the assigned console URL and keeps
the service running for inspection until Ctrl-C. See the
[live integration instructions](docs/operator.md#live-integration-command) for
credentials, repository overrides, retained files, cancellation behavior, and
the configuration fields this command reads.

The normal service defaults to `http://127.0.0.1:4317/` when `port` is omitted.
See the [operator guide](docs/operator.md) for normal startup, fixtures,
and current recovery limits.

## Project records

- [Product intent](docs/product-intent.md): product boundaries and operating rules
- [Architecture](docs/architecture/c4.md): implemented components and dependencies
- [Stack and conventions](docs/stack.md): runtime, state, provider, and eligibility decisions
- [Accepted security limitations](SECURITY-LIMITATIONS.md): ambient credentials and filesystem access
