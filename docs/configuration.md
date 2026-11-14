# Configuration

Settings live in **`config.json`** in the app folder, or `/etc/mqtt-dash/config.json` when installed as a service. It's created from `config.example.json` the first time the app starts. Updates never change it.

Restart after editing: press Ctrl+C and start it again, or `sudo systemctl restart mqtt-dash`.

```jsonc
{
  "http": {
    "host": "0.0.0.0",        // listen on all interfaces
    "port": 8080,             // web UI, API and MQTT over WebSockets
    "basicAuth": null         // or {"username": "..", "password": ".."} to password-protect the web UI/API
  },
  "mqtt": {
    "enabled": true,
    "host": "0.0.0.0",
    "port": 1883,             // MQTT over TCP
    "wsPath": "/mqtt"         // MQTT over WebSockets path on the web port
  },
  "auth": {
    "enabled": false,         // true = every MQTT client must log in
    "users": [
      { "username": "dashboard", "passwordHash": "scrypt$..." },
      { "username": "sensor1",   "passwordHash": "scrypt$...", "publish": ["sensors/sensor1/#"] }
    ]
  },
  "dataDir": "./data",        // dashboards, history, retained messages, admin password
  "historyPoints": 2000,      // messages kept per topic for trends and the Explorer
  "sysTopics": true,          // publish $SYS/broker/... statistics
  "updates": { "github": "homershaw/riotdash", "channel": "main" },   // see docs/updating.md
  "remote": { "requireLogin": true },  // anything arriving through Cloudflare must log in (see docs/cloudflare.md)
  "riot": {                   // RIOT controllers (see docs/riots.md)
    "prefix": "riot",
    "allowWrites": true,      // false = never change controller settings from riotdash
    "protectSetTopics": true, // only riotdash may publish riot/+/opt/set, unless a user's publish ACL names the topic
    "writeTimeoutMs": 15000   // how long to wait for the controller's reply to a change
  }
}
```

These environment variables override the config: `HTTP_PORT`, `MQTT_PORT`, `MQTTDASH_CONFIG` (path to the config file) and `MQTTDASH_DATA` (data folder).

## Logins (users)

The users in `auth.users` are used for:
- **Internet access** (through Cloudflare): always required, for both the dashboard and MQTT, while `remote.requireLogin` is `true` (the default).
- **Everyone, including your home network**: only if you set `auth.enabled` to `true`.

Manage them from the app folder. riotdash picks up changes within a few seconds:

```bash
node server/index.js add-user rob 'a-good-password'                       # add or change password
node server/index.js add-user sensor-garage 'pw…' 'sensors/garage/#'     # may only publish under sensors/garage/
node server/index.js list-users
node server/index.js remove-user sensor-garage
```

The optional topics after the password limit what that user may **publish** (wildcards allowed). Other publishes are silently dropped.

To make every device on your network log in too, set `"enabled": true` under `auth`, then enter a username and password in **⚙ Settings** on each browser.

> If you expose riotdash some other way than Cloudflare (e.g. router port forwarding), set `auth.enabled` to `true`. Only Cloudflare traffic is recognised as coming from the internet.

## Using another broker

Under **⚙ Settings → WebSocket URL**, the dashboard can point at any MQTT-over-WebSocket broker (Mosquitto, EMQX, HiveMQ…). Live widgets work with any broker. Trend history and the initial topic list come from the built-in broker only.

## Admin password

The admin password protects in-app updates. It's stored as a hash in `data/admin.json`. See [Updating](updating.md).

## Limits

The broker is sized for home and plant telemetry: up to a few hundred clients.
- Outbound QoS is capped at 1.
- Offline sessions keep their subscriptions but not queued messages.
- MQTT 5 isn't supported.

If you outgrow it, run Mosquitto or EMQX and point the dashboard at it.
