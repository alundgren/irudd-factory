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

Install Vite+ and the pinned Bun release, then run:

```sh
vp install --frozen-lockfile
vp run check
vp run test
vp run build
```

Use `vp run test`, not the built-in `vp test`. Factory and its tests use Bun
APIs, while the Vite+ built-in runs Vitest under Node.js.

Copy [`factory.example.json`](factory.example.json) to `factory.json` and adjust
the repository and paths. Start the service and use the CLI from one terminal:

```sh
vp run build:console
bun run apps/service/src/main.ts --config factory.json &
service_pid=$!

cleanup() {
  trap - 0 INT TERM
  kill "$service_pid" 2>/dev/null || true
  wait "$service_pid" 2>/dev/null || true
}
trap cleanup 0 INT TERM

snapshot_output=
attempt=0
while [ "$attempt" -lt 100 ]; do
  if snapshot_output="$(bun run apps/cli/src/main.ts snapshot 2>/dev/null)"; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 0.1
done
if [ "$attempt" -eq 100 ]; then
  echo "Factory service did not become ready" >&2
  exit 1
fi

printf '%s\n' "$snapshot_output"
bun run apps/cli/src/main.ts run-next --command-id "$(uuidgen | tr '[:upper:]' '[:lower:]')"
wait "$service_pid"
```

The service runs in the background while the CLI commands execute. The cleanup
trap stops it when you press Ctrl-C or leave the shell.

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
