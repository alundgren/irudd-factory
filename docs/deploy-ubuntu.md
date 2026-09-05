# Deploy Factory on Ubuntu

This guide installs Factory as a service for one Linux user. It uses a
dedicated production clone, separate from development checkouts and T3 Code
worktrees. The commands assume you are logged in as the user that already owns
the GitHub, Codex, and Tailscale credentials Factory should use.

Factory will use these locations:

```text
~/.local/share/irudd-factory/app          production clone
~/.local/share/irudd-factory/workspaces   managed worktrees
~/.local/state/irudd-factory/factory.db   SQLite state
~/.config/irudd-factory/factory.json      configuration
~/.config/systemd/user/irudd-factory.service
```

## 1. Check the required tools

Run:

```sh
command -v git
command -v gh
command -v codex
command -v tailscale
test -x "$HOME/.local/share/vite-plus/bin/vp"

git --version
gh --version | head -n 1
codex --version
tailscale version | head -n 1
"$HOME/.local/share/vite-plus/bin/vp" --version
```

Every command must succeed. Factory requires Vite+ with Node.js 24.11 or
newer. Install Vite+ if its check failed:

```sh
curl -fsSL https://vite.plus | bash
```

Open a new shell after the installer finishes. Then check the ambient accounts:

```sh
gh auth status
codex login status
tailscale status
```

Log in before continuing if any command reports that its account is missing.
Do not run Factory under a different user. A systemd user service inherits this
user's home directory and reads the same GitHub and Codex credentials.

## 2. Create the production clone

Create the parent directory and clone the `main` branch after the deployment PR
has merged:

```sh
install -d -m 700 "$HOME/.local/share/irudd-factory"

git clone --branch main --single-branch \
  https://github.com/alundgren/irudd-factory.git \
  "$HOME/.local/share/irudd-factory/app"

cd "$HOME/.local/share/irudd-factory/app"
git status --short --branch
```

The final command should report `main` with no changed files.

## 3. Install, verify, and build

Run the repository checks before installing the service:

```sh
cd "$HOME/.local/share/irudd-factory/app"
VP="$HOME/.local/share/vite-plus/bin/vp"

"$VP" install --frozen-lockfile
"$VP" run check
"$VP" run test
"$VP" run build:console
```

Stop if any command fails. The service should never start from a revision that
failed validation.

## 4. Create the configuration

Set `operator_login` to the exact email address Tailscale reports for the
person who will open the console. Keep the single quotes:

```sh
operator_login='you@example.com'

install -d -m 700 \
  "$HOME/.config/irudd-factory" \
  "$HOME/.local/state/irudd-factory" \
  "$HOME/.local/share/irudd-factory/workspaces"

cat >"$HOME/.config/irudd-factory/factory.json" <<EOF
{
  "repositories": [
    {
      "repository": "alundgren/irudd-factory"
    }
  ],
  "databasePath": "$HOME/.local/state/irudd-factory/factory.db",
  "workspaceRoot": "$HOME/.local/share/irudd-factory/workspaces",
  "port": 4317,
  "access": {
    "operatorLogin": "$operator_login"
  },
  "codex": {
    "model": "gpt-5.6-sol",
    "reasoningEffort": "medium",
    "slots": 1
  }
}
EOF

chmod 600 "$HOME/.config/irudd-factory/factory.json"
```

Factory infers Tailscale access from `operatorLogin`. It binds the main server
to `127.0.0.1:4317` and creates a CLI-only listener at
`127.0.0.1:4318`. The omitted polling, timeout, and retention settings use the
documented defaults.

Inspect the file before continuing:

```sh
cat "$HOME/.config/irudd-factory/factory.json"
```

## 5. Install the systemd user service

Create the unit:

```sh
install -d -m 700 "$HOME/.config/systemd/user"

cat >"$HOME/.config/systemd/user/irudd-factory.service" <<'EOF'
[Unit]
Description=Irudd Factory
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=%h/.local/share/irudd-factory/app
Environment=NODE_ENV=production
Environment=PATH=%h/.local/share/vite-plus/bin:%h/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=%h/.local/share/vite-plus/bin/vp node apps/service/src/main.ts --config %h/.config/irudd-factory/factory.json
KillMode=mixed
TimeoutStopSec=15
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now irudd-factory.service
```

The service must continue running when the user is logged out. Check lingering:

```sh
loginctl show-user "$USER" -p Linger
```

If it reports `Linger=no`, enable it once:

```sh
sudo loginctl enable-linger "$USER"
```

## 6. Check the service

Inspect systemd and the latest logs:

```sh
systemctl --user status irudd-factory.service --no-pager
journalctl --user -u irudd-factory.service -n 100 --no-pager
```

Then call the private CLI listener:

```sh
cd "$HOME/.local/share/irudd-factory/app"

"$HOME/.local/share/vite-plus/bin/vp" node apps/cli/src/main.ts \
  snapshot \
  --url http://127.0.0.1:4318/rpc
```

The command should print a JSON snapshot. A direct browser request to the main
port must be denied because it did not pass through Tailscale:

```sh
curl -i http://127.0.0.1:4317/
```

Expect HTTP `403` and `x-factory-access-decision: identity_rejected`.

## 7. Publish the console through Tailscale

Expose only the main listener:

```sh
tailscale serve --bg 4317
tailscale serve status
```

The command prints the HTTPS URL. Open that URL from a second device in the
same tailnet. Confirm the Overview loads and its effective configuration shows
`gpt-5.6-sol` with `medium` effort.

Do not expose port `4318`. It is an unauthenticated local CLI listener.

## 8. Install the manual redeploy command

The production-specific script is ignored by Git. Create it from the checked-in
example:

```sh
cd "$HOME/.local/share/irudd-factory/app"
cp redploy-main.example.sh redploy-main.sh
chmod 700 redploy-main.sh
```

For each later deployment, update the production clone and run the script:

```sh
cd "$HOME/.local/share/irudd-factory/app"
git switch main
git pull --ff-only
./redploy-main.sh
```

The script validates and builds before it restarts Factory. If validation
fails, the existing service process continues running. Compare the ignored
copy with `redploy-main.example.sh` when a later pull changes the example.

## Troubleshooting

Follow the live journal while restarting:

```sh
journalctl --user -u irudd-factory.service -f
```

In another terminal:

```sh
systemctl --user restart irudd-factory.service
```

Check listening ports and Tailscale Serve:

```sh
ss -ltn | grep -E ':(4317|4318)\b'
tailscale serve status
```

To remove only the Tailscale proxy while leaving Factory running:

```sh
tailscale serve off
```
