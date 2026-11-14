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

On the riotdash machine:

```bash
cd ~/riotdash                     # wherever riotdash lives
./deploy/cloudflare/setup.sh --hostname dash.yourdomain.com
```

It will:
1. Ask you to choose a **login for internet access** (username and password), if you don't have one yet.
2. Install `cloudflared` if needed.
3. Show a **Cloudflare link**. Open it on any computer or phone, sign in, click your domain, then **Authorize**. The script continues by itself. You only do this once, and no API token is needed.
4. Create (or reuse) a tunnel called **riotdash** and the DNS record for your address.
5. Point the address at `http://localhost:<your port>`, start `cloudflared` as a service, and check that the site answers.

It's safe to run again, for example after changing the port.

| Option | Use |
|---|---|
| `--hostname dash.example.com` | The public address (otherwise it asks) |
| `--name mytunnel` | Use a different tunnel name |
| `--config /path/config.json` | Use a different riotdash config |

### Using an API token instead

If you'd rather not use the browser login (for scripted installs), create a custom API token at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) with:

| Type | Item | Permission |
|---|---|---|
| Account | Cloudflare One Connector: cloudflared | Edit |
| Zone | DNS | Edit |
| Zone | Zone | Read |

Older accounts call the first one **Cloudflare Tunnel**; **Cloudflare One Connectors → Edit** also works. Limit **Zone Resources** to your domain, then run:

```bash
./deploy/cloudflare/setup.sh --token            # asks for the token (hidden, never saved)
```

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
