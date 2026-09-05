#!/bin/sh
set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$script_directory"

service_name=${FACTORY_SERVICE_NAME:-irudd-factory.service}
rpc_url=${FACTORY_RPC_URL:-http://127.0.0.1:4318/rpc}
vp_bin=${VP_BIN:-$HOME/.local/share/vite-plus/bin/vp}

if [ ! -x "$vp_bin" ]; then
  echo "Vite+ is not executable at $vp_bin" >&2
  exit 1
fi

branch=$(git branch --show-current)
if [ "$branch" != "main" ]; then
  echo "Refusing to deploy branch $branch; check out main first" >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Refusing to deploy a checkout with tracked changes" >&2
  exit 1
fi

if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "HEAD does not match origin/main; pull latest main first" >&2
  exit 1
fi

systemctl --user cat "$service_name" >/dev/null

"$vp_bin" install --frozen-lockfile
"$vp_bin" run check
"$vp_bin" run test
"$vp_bin" run build:console

systemctl --user restart "$service_name"

attempt=0
while [ "$attempt" -lt 50 ]; do
  if "$vp_bin" node apps/cli/src/main.ts snapshot --url "$rpc_url" \
    >/dev/null 2>&1; then
    printf 'Deployed %s at %s\n' "$(git rev-parse --short HEAD)" "$rpc_url"
    exit 0
  fi
  if ! systemctl --user is-active --quiet "$service_name"; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 0.2
done

systemctl --user status "$service_name" --no-pager >&2 || true
journalctl --user -u "$service_name" -n 100 --no-pager >&2 || true
echo "Factory did not become ready at $rpc_url" >&2
exit 1
