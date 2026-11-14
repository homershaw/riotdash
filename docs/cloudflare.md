# Publishing through Cloudflare

A **Cloudflare Tunnel** lets you reach riotdash from anywhere without opening router ports or needing a public IP. The connector (`cloudflared`) runs on the riotdash machine and makes an **outbound** connection to Cloudflare.

Once it's set up, you get:

| | Address |
|---|---|
| Dashboard | `https://dash.yourdomain.com` |
| Explorer | `https://dash.yourdomain.com/explorer` |
| MQTT for devices anywhere | `wss://dash.yourdomain.com/mqtt` (port 443) |

## How access works

- **Anything coming through Cloudflare must log in.** Browsers get a username/password prompt; MQTT clients use the same username and password.
- **Your home network doesn't change.** Local browsers and devices (`http://<machine>:8080`, `mqtt://<machine>:1883`) keep working without passwords, unless you turn on `auth.enabled` for everyone.
- Logins are the users in `config.json` (`auth.users`). Manage them with:
  ```bash
  node server/index.js add-user <name> <password>        # add, or change a password
  node server/index.js list-users
  node server/index.js remove-user <name>
  ```
  riotdash picks up changes within a few seconds, with no restart.
- Once you've logged in with a browser, the dashboard and Explorer connect to MQTT automatically.

## Automatic setup (recommended)

### 1. Create an API token

On [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) choose **Create Token → Create Custom Token** and add these permissions:

| Type | Item | Permission |
|---|---|---|
| Account | Cloudflare Tunnel | Edit |
| Zone | DNS | Edit |
| Zone | Zone | Read |

Under **Zone Resources**, pick your domain (e.g. *anyesp.com*). Create the token and copy it. You'll paste it into the setup script.

### 2. Run the setup on the riotdash machine

```bash
cd ~/riotdash                     # wherever riotdash lives
./deploy/cloudflare/setup.sh
```

It asks for:
1. **A login for internet access** (if you don't have one yet): username and password.
2. **The API token.** Input is hidden, and the token is never saved or shown.
3. **The public address.** The default is `dash.<your domain>`; press Enter to accept it.

Then it automatically:
- creates (or reuses) a tunnel called **riotdash**
- points the address at `http://localhost:<your port>`
- creates the DNS record
- installs `cloudflared` and starts it as a service
- checks that `https://<address>` answers

It's safe to run again, for example after changing the port or to switch to a different address (`--hostname`).

| Option | Use |
|---|---|
| `--hostname dash.example.com` | Skip the address question |
| `--name mytunnel` | Use a different tunnel name |
| `--config /path/config.json` | Use a different riotdash config |
| `--skip-install` | Don't install or start `cloudflared` (no sudo needed) |

You can also pass the token without typing it: `CLOUDFLARE_API_TOKEN=... ./deploy/cloudflare/setup.sh`.

### 3. Done

Open `https://dash.<your domain>` on your phone with Wi-Fi off and log in. For MQTT devices outside your network, use:

- **Host:** `dash.<your domain>`, **port:** `443`, **TLS/SSL:** on, **WebSocket path:** `/mqtt`
- **Username/password:** a riotdash login (one per device is a good idea: `add-user sensor-garage <password> sensors/garage/#` limits it to its own topics)

## Manual setup (alternative)

If you'd rather click through the Cloudflare dashboard:

1. **Zero Trust → Networks → Tunnels → Create a tunnel**, then choose **Cloudflared**.
2. Run the install command it shows on the riotdash machine: `sudo cloudflared service install <TOKEN>`.
3. Add a **Public hostname**: `dash.yourdomain.com`, service type **HTTP**, URL **`localhost:8080`** (use your port).
4. Add a login: `node server/index.js add-user <name> <password>`.

## Extra protection with Cloudflare Access (optional)

To add Cloudflare's own login (email one-time PIN, Google, etc.) in front of the dashboard: **Zero Trust → Access → Applications → Add a self-hosted app** for `dash.yourdomain.com`. MQTT devices can't complete that login, so add a **Bypass** policy for the path `/mqtt`. They still need their riotdash username/password.

## Troubleshooting

| Problem | Fix |
|---|---|
| *Remote access is not set up yet* | Add a login: `node server/index.js add-user <name> <password>` |
| Browser keeps asking for the password | Wrong username/password. Check with `node server/index.js list-users` and reset with `add-user` (same name, new password). |
| `The API token needs: …` | Edit the token in Cloudflare and add the permission it names |
| Site doesn't answer | Wait a few minutes for DNS, then check `sudo systemctl status cloudflared` and that riotdash is running |
| `Run this with sudo` | Use `./deploy/cloudflare/setup.sh`; it runs sudo for you |

> **Port forwarding:** don't also forward ports 8080/1883 on your router. Traffic that skips Cloudflare looks local to riotdash and wouldn't be asked to log in.
