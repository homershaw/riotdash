# Getting started

## Requirements

- Linux (any distro), or anywhere else Node.js runs
- **Node.js 18 or newer.** Check with `node -v`. On older Ubuntu/Debian releases the `apt` version can be too old; NodeSource and nodejs.org have newer builds.

There's nothing else to install. riotdash has no npm dependencies.

## Get it and run it

```bash
git clone https://github.com/homershaw/riotdash.git
cd riotdash
node server/index.js
```

You should see:

```
MQTT Dash UI       http://localhost:8080/
MQTT over WS       ws://<host>:8080/mqtt
MQTT broker (TCP)  mqtt://<host>:1883
```

Open **http://localhost:8080**. On first start the app:
- creates `config.json` from `config.example.json` (edit this one; updates never overwrite it)
- creates a `data/` folder for dashboards, history and retained messages
- adds a **Plant demo** dashboard

Leave the terminal open. **Ctrl+C** stops the server.

### Demo data

In a second terminal:

```bash
node tools/simulator.js
```

This runs a small simulated plant: a tank, valves, a pump, a heater and a room sensor. Switches and valves on the demo dashboard really control it.

## Port already in use?

*Port 8080 is already in use* (or `:1883`) means another program has that port. Often that's riotdash itself, already running in another terminal or as the service (`systemctl status riotdash`). Find it:

```bash
sudo ss -ltnp | grep -E ':8080|:1883'
```

Either stop that program, or move riotdash. To try another port once:

```bash
HTTP_PORT=8090 node server/index.js          # web UI + MQTT over WebSockets
MQTT_PORT=1884 node server/index.js          # MQTT TCP
```

To make it permanent, set it in `config.json`:

```json
"http": { "host": "0.0.0.0", "port": 8090, "basicAuth": null },
```

`1883` is usually taken by Mosquitto (`sudo systemctl stop mosquitto`).

## Reach it from other computers and phones

riotdash already listens on all network interfaces. You need the machine's address and an open firewall.

**1. Find the IP address**

```bash
hostname -I        # use the first address, e.g. 192.168.1.50 (ignore 172.x Docker addresses)
```

**2. Open it** from any device on the same network:

- Dashboard: `http://192.168.1.50:8080`
- Explorer: `http://192.168.1.50:8080/explorer`

**3. Open the firewall if it doesn't load**

Ubuntu / Debian (`ufw`):

```bash
sudo ufw status                  # "inactive" → nothing to do
sudo ufw allow 8080/tcp          # dashboard + MQTT over WebSockets
sudo ufw allow 1883/tcp          # MQTT for devices
sudo ufw reload
```

Fedora / RHEL (`firewalld`):

```bash
sudo firewall-cmd --permanent --add-port=8080/tcp --add-port=1883/tcp
sudo firewall-cmd --reload
```

> **Tip:** if the rules are added but it still doesn't connect, run the **reload** command. New rules often don't apply until the firewall is reloaded.

**Common snags**

- Phones on a **guest Wi-Fi** usually can't reach other devices. Use the main network.
- Give the machine a **fixed IP** in your router (a "DHCP reservation"), so devices don't lose the broker after a reboot.
- Quick check from another computer: `curl http://192.168.1.50:8080/healthz` should return `{"ok":true}`.

**Connecting MQTT devices** (ESP32, Tasmota, Shelly, Home Assistant, Node-RED…): broker `192.168.1.50`, port `1883`. Add a username and password once you turn on authentication (see [Configuration](configuration.md)).

### On a phone

Use **Add to Home Screen** (Safari share menu, or the Chrome menu on Android) to get an app icon. It then opens full screen. Phones automatically get the **List** layout (see [Dashboards](dashboards.md#phones-and-tablets)).

## Run it as a service (starts on boot)

From your riotdash folder:

```bash
bash deploy/install-service.sh
```

This turns the folder you're in into a system service called **riotdash**. It:
- runs as your user, from the same folder, so your `config.json`, logins, dashboards and history stay put
- starts at boot and restarts if it ever crashes
- keeps in-app updates working
- stops any copy you'd started by hand in a terminal, then checks the service answers

| | |
|---|---|
| Live log | `journalctl -u riotdash -f` |
| Restart | `sudo systemctl restart riotdash` |
| Stop / start | `sudo systemctl stop riotdash` / `sudo systemctl start riotdash` |
| Remove the service | `bash deploy/install-service.sh --uninstall` (your files are kept) |

If you also use the Cloudflare tunnel, `cloudflared` is a service too, so after a reboot both come back by themselves.

### Alternative: system-wide install in /opt

`sudo ./deploy/install.sh` copies the app to `/opt/mqtt-dash` with a dedicated `mqttdash` user, config in `/etc/mqtt-dash/config.json` and data in `/var/lib/mqtt-dash`. It starts with a **fresh** config and data folder, so use it for new machines rather than to convert an existing install.
