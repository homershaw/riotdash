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
  "sysTopics": true           // publish $SYS/broker/... statistics
}
```

These environment variables override the config: `HTTP_PORT`, `MQTT_PORT`, `MQTTDASH_CONFIG` (path to the config file) and `MQTTDASH_DATA` (data folder).

## Broker users and passwords

1. Create a password hash:
   ```bash
   node server/index.js hash-password 'a-good-password'
   ```
2. Paste the output into `passwordHash` for that user, and set `"enabled": true`.
3. **`publish`** (optional) limits which topics a user may publish to. Wildcards are allowed, and other publishes from that user are silently dropped. Leave it out to allow everything.
4. In the dashboard, open **⚙ Settings** and enter the username and password the browser should use. Each browser remembers its own.

> **Turn on `auth` before exposing riotdash to the internet.** Without it, anyone who can reach the broker can read and write every topic.

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
