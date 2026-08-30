# Irudd Factory

Irudd Factory runs one eligible GitHub issue through one unattended Codex turn
and records the result in SQLite. It is built for one developer operating a
dedicated machine and repositories they own. The project was inspired by
[Symphony](https://github.com/openai/symphony/blob/main/SPEC.md).

The current milestone provides a manual loopback-only service, CLI, and browser
console. It discovers eligible issues, pins repository policy to the default
branch commit, claims one issue, creates a retained linked worktree, runs Codex
through App Server, and verifies the resulting pull request.

## Development

Install the pinned Bun release, then run:

```sh
bun install --frozen-lockfile
bun run test
bun run build
```

Copy [`factory.example.json`](factory.example.json) to `factory.json`, adjust
the repository and paths, and start the service:

```sh
bun run apps/service/src/main.ts --config factory.json
bun run apps/cli/src/main.ts snapshot
bun run apps/cli/src/main.ts run-next --command-id "$(uuidgen | tr '[:upper:]' '[:lower:]')"
```

The service exposes the console at `http://127.0.0.1:4317/` and Effect RPC at
`http://127.0.0.1:4317/rpc`. See the [operator guide](docs/operator.md) for the
configuration contract, fixture scenarios, retained files, and current
recovery limits.

## Project records

- [Product intent](docs/product-intent.md): product boundaries and operating rules
- [Architecture](docs/architecture/c4.md): implemented components and dependencies
- [Stack and conventions](docs/stack.md): runtime, state, provider, and eligibility decisions
- [Prototypes](docs/prototypes/README.md): provider probe and completed dispatcher slice
- [Accepted security limitations](SECURITY-LIMITATIONS.md): ambient credentials and filesystem access
