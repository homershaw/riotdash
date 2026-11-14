# Publishing through Cloudflare

A **Cloudflare Tunnel** lets you reach riotdash from anywhere without opening router ports or needing a public IP. The connector (`cloudflared`, the "agent") runs on the riotdash machine and makes an **outbound** connection to Cloudflare.

Everything goes through the web port (default 8080), so one public hostname covers it all:
- `https://dash.example.com`: dashboard and Explorer
- `wss://dash.example.com/mqtt`: MQTT for devices anywhere (port 443)

## Before you start: lock it down

1. Turn on broker authentication: `"auth": { "enabled": true, ... }` (see [Configuration](configuration.md#broker-users-and-passwords)).
2. Set the **admin password** while you're still on your local network (see [Updating](updating.md#admin-password)).

## Option A: tunnel managed in the Cloudflare dashboard (easiest)

1. In the Cloudflare dashboard: **Zero Trust → Networks → Tunnels → Create a tunnel**, then choose **Cloudflared**.
2. Run the install command it shows on the riotdash machine:
   ```bash
   sudo cloudflared service install <TOKEN>
   ```
3. Add a **Public hostname**, e.g. `dash.example.com`, with service type **HTTP** and URL **`localhost:8080`**. Use your port if you changed it.

## Option B: tunnel managed locally

```bash
cloudflared tunnel login
cloudflared tunnel create riotdash
cloudflared tunnel route dns riotdash dash.example.com
sudo cp deploy/cloudflare/config.yml /etc/cloudflared/config.yml   # then fill in the tunnel ID and hostname
sudo cloudflared service install
sudo systemctl start cloudflared
```

The template `deploy/cloudflare/config.yml` explains each line.

## Protect the dashboard with Cloudflare Access

In **Zero Trust → Access → Applications**, add a self-hosted app for `dash.example.com`, with a policy such as *emails ending in @yourdomain* or a one-time PIN.

IoT devices can't complete an Access login, so for MQTT either:
- add a **Bypass** policy for the path `/mqtt` (the broker's own username/password still protects it), or
- use a second hostname for devices without Access, pointing at the same service.

## Raw MQTT over TCP (optional)

The tunnel can also carry port 1883 (`tcp://localhost:1883`), but every client then has to run:

```bash
cloudflared access tcp --hostname mqtt-tcp.example.com --url localhost:1883
```

For remote devices, `wss://…/mqtt` is usually much simpler.
