# Running LettaBot Under a Dedicated Linux User

Run your LettaBot agent as an unprivileged system user for better security isolation. This prevents the bot (and any tools it executes) from accessing your personal files or other services on the host.

## Step 1: Create the system user

```bash
sudo useradd --system --create-home --home-dir /home/lettabot --shell /usr/sbin/nologin lettabot
```

- `--system` — no login, no password, low UID
- `--home-dir /home/lettabot` — dedicated home directory (can be anywhere, e.g. `/opt/lettabot`)
- `--shell /usr/sbin/nologin` — cannot be used for interactive login

## Step 2: Install Node.js and build from source

Install Node.js 22+ system-wide if you haven't already (e.g. via NodeSource or your distro's package manager).

Clone the repo, build, and link the CLI globally:

```bash
sudo -u lettabot git clone https://github.com/letta-ai/lettabot.git /home/lettabot/app
cd /home/lettabot/app
sudo -u lettabot npm install
sudo -u lettabot npm run build
sudo -u lettabot npm link
```

`npm link` makes the `lettabot` command available on the user's PATH without a global npm install.

## Step 3: Set up the working directory

Keep runtime data (config, credentials, status files, logs) separate from the source tree so updates don't cause merge conflicts:

```bash
sudo -u lettabot mkdir -p /home/lettabot/run
```

The bot runs from this directory. Config, pairing credentials, and other data files are written here — not in the source repo.

## Step 4: Create the config file

```bash
sudo -u lettabot nano /home/lettabot/run/lettabot.yaml
```

Minimal example (Docker/self-hosted Letta server):

```yaml
server:
  mode: docker
  baseUrl: http://localhost:8283

workingDir: /home/lettabot/run

agents:
  - name: MyBot
    channels:
      discord:
        enabled: true
        token: "YOUR_DISCORD_BOT_TOKEN"
```

> **Important**: `workingDir` controls where the agent stores its runtime data (SDK sessions, send-file staging, etc.). This is different from the systemd `WorkingDirectory`, which is simply the process's current directory. Without `workingDir`, the agent defaults to `/tmp/lettabot`, which is ephemeral and won't survive restarts. Set it to a path under the bot's home directory so data persists.

## Step 5: Create the systemd service

Create `/etc/systemd/system/lettabot.service`:

```ini
[Unit]
Description=LettaBot - Multi-channel AI Assistant
After=network.target docker.service
Wants=docker.service

[Service]
Type=simple
User=lettabot
Group=lettabot
WorkingDirectory=/home/lettabot/run

# Config location
Environment=LETTABOT_CONFIG_YAML=/home/lettabot/run/lettabot.yaml
Environment=NODE_ENV=production

ExecStart=/home/lettabot/.npm-global/bin/lettabot server

Restart=on-failure
RestartSec=10

# Hardening
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

> **Note on `ExecStart`**: The path to the `lettabot` binary depends on where `npm link` places it. Run `sudo -u lettabot which lettabot` to find the correct path and adjust `ExecStart` accordingly.

The dedicated user is the primary security boundary — Linux permissions already prevent it from modifying other users' files or writing to system directories. The two hardening directives add:
- **`NoNewPrivileges=true`** — the process cannot escalate privileges via setuid/setgid binaries
- **`PrivateTmp=true`** — the process gets its own isolated `/tmp`

This is intentionally lightweight. The agent can read system files (e.g. `/etc` configs, logs) which is useful for diagnostics and autonomous operation. It just can't write anywhere it doesn't own.

## Step 6: Enable and start

```bash
sudo systemctl daemon-reload
sudo systemctl enable lettabot
sudo systemctl start lettabot
```

Check status and logs:

```bash
sudo systemctl status lettabot
journalctl -u lettabot 	-f
```

## Step 7: Pairing and credentials

Pairing approvals are stored under the working directory. Since `WorkingDirectory` is `/home/lettabot/run`, they'll end up at `/home/lettabot/run/.lettabot/credentials/`.

To approve a pairing from your own account:

```bash
cd /home/lettabot/run && sudo -u lettabot lettabot approve <code>
```

Or use the portal web UI if the API server is enabled in your config.

## Updating

Pull, rebuild, and restart — the working directory is untouched:

```bash
cd /home/lettabot/app
sudo -u lettabot git pull
sudo -u lettabot npm install
sudo -u lettabot npm run build
sudo systemctl restart lettabot
```

## Optional: Strict filesystem lockdown

If you're running the bot on a shared machine and want to restrict what it can see, add these directives to the `[Service]` section:

```ini
ProtectSystem=strict
ProtectHome=tmpfs
ReadWritePaths=/home/lettabot
```

This makes the entire filesystem read-only except `/home/lettabot`, and hides all other users' home directories. You'll need to explicitly grant access to any additional paths the agent needs:

```ini
ReadWritePaths=/home/lettabot /srv/shared-files
ReadOnlyPaths=/var/log
```

After changing the service file: `sudo systemctl daemon-reload && sudo systemctl restart lettabot`

> **Trade-off**: This is more secure but significantly limits the agent's autonomy. It won't be able to read `/etc` configs, inspect logs, or interact with anything outside the allowed paths. For a dedicated machine or VM, the default setup (dedicated user only) is usually the better choice.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `lettabot: command not found` | Check `sudo -u lettabot which lettabot` — if empty, re-run `npm link` from the app directory, or use the full path to `node /home/lettabot/app/dist/main.js server` in `ExecStart` |
| Permission denied on config | Check ownership: `sudo chown -R lettabot:lettabot /home/lettabot` |
| Cannot connect to Letta server | If server is in Docker, ensure the `lettabot` user can reach `localhost:8283` (no firewall rules blocking it) |
| Pairing approval fails | Run the approve command from the working directory: `cd /home/lettabot/run && sudo -u lettabot lettabot approve <code>` |
