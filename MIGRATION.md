# Migrating from 4.x to 5.0

Most code keeps working after a few small changes. The class, `Rcon.connect`, `send`, `end` and `on` keep their names.

## Requirements

- Node.js 22.12 or later.
- The package is ESM. `require("rcon-client")` still works on Node.js 22.12+.

## Changes

| 4.x | 5.0 |
|---|---|
| `host` required | Defaults to `"localhost"` |
| `timeout: 2000` per packet | `timeout: 30000` per command, including queue time. Per call: `send(cmd, { timeout })` or `{ signal }` |
| `maxPending` | Removed. Minecraft closes the connection if a second command arrives before the first reply, so commands always run one at a time |
| `error` event | Removed. Errors go to the affected command, and a socket error can no longer crash the process |
| `authenticated` event | Use `connect`, which now fires after authentication |
| `end` event on every close | `disconnect` fires when a connection closes; `end` fires once after `end()` |
| `authenticated` property | `connected` |
| `socket` property | Removed. The socket changes on every reconnect |
| `emitter`, `once`, `off` | `Rcon` is an `EventEmitter` now, so all its methods are available on it directly |
| `sendRaw(buffer)` | Removed. Use `send(string)` |
| No reconnect | Reconnects automatically while commands wait. `reconnect: false` turns this off |
| `end()` throws if not connected | `end()` always works, waits for queued commands, and can be called more than once |
| Errors are plain `Error` | `RconError` with `code` and `sent` |
| Long replies cut at 4096 characters | Arrive whole |
| `send("")` was sent to the server | Rejects with `EMPTY_COMMAND` (Factorio never answers an empty command) |
| Any command length | Longer than `maxCommandBytes` (default 1446, 1014 on Source servers) rejects with `COMMAND_TOO_LONG` |

## Example

```js
// 4.x
const rcon = new Rcon({ host: "localhost", port: 25575, password: "secret" });
rcon.on("error", console.error);
await rcon.connect();
console.log(await rcon.send("list"));
rcon.end();

// 5.0
const rcon = new Rcon({ host: "localhost", port: 25575, password: "secret" });
await rcon.connect(); // optional: the first send connects by itself
console.log(await rcon.send("list"));
await rcon.end();
```

## Reconnect code

If you built your own reconnect logic on the `end` and `error` events, you can delete it. To log what happens, listen to `connect`, `disconnect` and `reconnecting`.

A command that was sent before a disconnect is not sent again. It rejects with `CONNECTION_LOST` and `sent: true`, so you can decide whether it is safe to repeat.
