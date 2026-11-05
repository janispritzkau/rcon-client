# rcon-client

[![npm](https://img.shields.io/npm/v/rcon-client.svg)](https://www.npmjs.com/package/rcon-client)
[![downloads](https://img.shields.io/npm/dm/rcon-client.svg)](https://www.npmjs.com/package/rcon-client)

An RCON client for Node.js that is safe for short scripts and long-running bots.
It is tested against Minecraft, Factorio and Source servers, and has no runtime dependencies.

- Commands run one at a time, in order, so `Promise.all` is safe.
- Long replies that the server splits into fragments arrive whole.
- Reconnects with backoff, but never sends a command twice.
- Timeouts and cancellation use `AbortSignal`.
- A socket error can never crash the process, and an idle client never keeps it alive.

Upgrading from 4.x? See the [migration guide](MIGRATION.md).

```sh
npm install rcon-client
```

Requires Node.js 22.12 or later. It also runs on Deno and Bun.

## Usage

### Scripts

`Rcon.connect()` connects right away and rejects on the first error, so a wrong host or password shows up immediately.

```js
import { Rcon } from "rcon-client";

const rcon = await Rcon.connect({ host: "localhost", password: "secret" });
console.log(await rcon.send("list"));
await rcon.end();
```

On Node.js 24+ (or with a transpiler), `await using` closes the client for you:

```js
await using rcon = await Rcon.connect({ host: "localhost", password: "secret" });
```

### Long-running processes

`new Rcon()` does no I/O until the first command. After that it reconnects by itself. With `heartbeat`, it also notices a dead connection while idle and rebuilds it.

```js
const rcon = new Rcon({ host: "localhost", password: "secret", heartbeat: 30_000 });

rcon.on("connect", () => console.log("connected"));
rcon.on("disconnect", (error) => console.log("disconnected", error));
rcon.on("reconnecting", ({ attempt, delay, error }) => console.log(attempt, delay, error));
```

### Timeouts, cancelling and retrying

```js
import { RconError } from "rcon-client";

try {
  await rcon.send("give @a diamond", { signal: AbortSignal.timeout(5000) });
} catch (error) {
  if (error instanceof RconError && !error.sent && error.code === "TIMEOUT") {
    // The command definitely did not run, so it is safe to retry.
  }
}
```

### Many commands

`sendAll` reads from any iterable or async iterable as commands complete and yields the replies in order, so a huge file stays cheap.

```js
for await (const reply of rcon.sendAll(commands)) console.log(reply);
```

More examples are in [`examples/`](examples).

## API

### `new Rcon(options)`

| Option | Default | |
|---|---|---|
| `host` | `"localhost"` | |
| `port` | `25575` | |
| `password` | required | |
| `timeout` | `30000` | Default time a command may take, in milliseconds. Time spent in the queue and reconnecting counts. `0` disables it. |
| `connectTimeout` | `10000` | Time for one TCP connect plus authentication. `0` disables it. |
| `reconnect` | `true` | Retry failed connects with backoff while commands wait. With `false`, a failed connect rejects the queue. |
| `heartbeat` | `0` | When idle this long, send a ping. If no reply arrives in the same time, rebuild the connection. `0` disables it. |
| `maxCommandBytes` | `1446` | Longer commands reject before they are sent. Minecraft closes the connection on anything longer. If you leave it unset and the server is a Source server, the limit drops to 1014 (see below). Factorio has no limit, so raise it there if you need to. |

### Methods and properties

- `Rcon.connect(options)`: creates a client, connects once, and rejects on failure.
- `rcon.connect()`: connects now if not connected. Makes one attempt.
- `rcon.send(command, { signal, timeout }?)`: resolves with the command's output.
- `rcon.sendAll(commands, { signal, timeout }?)`: async generator of outputs, in order, each yielded as soon as it arrives. At most 16 commands are queued ahead. It throws the first failure. Commands that were already queued at that point still run.
- `rcon.ping({ signal, timeout }?)`: round trip in milliseconds. It runs after the command in flight but before queued commands. On Minecraft and Factorio it is answered outside the game loop, so it works while the server is busy.
- `rcon.end()`: waits for queued commands to settle, then closes. If the server is unreachable, it makes one more connect attempt and then rejects what is left with `CONNECTION_FAILED`. Later calls to `send` reject with `CLOSED`.
- `rcon[Symbol.asyncDispose]()`: same as `end()`.
- `rcon.connected`: `true` while an authenticated connection is open.
- `rcon.pending`: commands and pings that have not settled.

### Events

| Event | Arguments | |
|---|---|---|
| `connect` | | Connected and authenticated. |
| `disconnect` | `error?` | An open connection closed. `error` is unset for a clean close. |
| `reconnecting` | `{ attempt, delay, error }` | A connect attempt failed and another is scheduled. |
| `end` | | `end()` finished. |

There is no `error` event. Every failure goes to the command it affects.

### Errors

Every rejection is an `RconError` with `code` and `sent`. `sent: true` means the command reached the socket and may have run.

| Code | `sent` | Meaning |
|---|---|---|
| `TIMEOUT` | either | No reply within the timeout. If the command was in flight, the connection is dropped, because its late reply would otherwise block the queue. |
| `ABORTED` | either | The `signal` fired. Same as above. |
| `CONNECTION_LOST` | `true` | The connection dropped before the full reply arrived. |
| `CONNECTION_FAILED` | `false` | Could not connect, and retrying was not allowed (`Rcon.connect`, `connect()`, `reconnect: false` or during `end()`). |
| `AUTH_FAILED` | `false` | Wrong password. It is permanent, so the queue is rejected and the client does not retry in a loop. |
| `COMMAND_TOO_LONG` | `false` | Longer than `maxCommandBytes`. |
| `CLOSED` | `false` | `end()` was called. |
| `PROTOCOL` | either | The server sent something that is not RCON. |

## Things to know

**Retrying.** The client never resends a command after it has been written to the socket. A command that timed out on the client may still have run on the server. Only retry automatically when `error.sent` is `false`, or when the command is safe to run twice. Do not retry `AUTH_FAILED`, `CLOSED` or `COMMAND_TOO_LONG`: they fail the same way every time.

**How ping works.** `ping()`, `heartbeat` and the end marker for long replies all send the password again. Every tested server answers that in order, and none of them logs it. Packets of an unknown type would not work: Factorio ignores them and logs an error for each one.

**Source servers ban addresses.** By default, Source allows commands up to 1014 bytes (`sv_rcon_maxpacketsize 1024`, minus the header) and bans the sender's address after oversized packets (`sv_rcon_maxpacketbans`). The client detects Source servers when it connects and then rejects longer commands with `COMMAND_TOO_LONG`, unless you set `maxCommandBytes` yourself. Wrong passwords count toward a ban too (`sv_rcon_maxfailures`, default 10). The client does not retry `AUTH_FAILED`, but a script that restarts in a loop with a wrong password can still get banned. With `sv_rcon_banpenalty 0`, the default, the ban is permanent until the server restarts, or longer if the ban list is saved. After a wrong password, the tested Source servers also stopped answering other open connections from the same address, without closing them. Commands on such a connection time out with `sent: true`, the client drops the socket, and the next command reconnects. Set a `heartbeat` to notice this while idle.

**Acks during shutdown.** Minecraft keeps answering commands for a moment after `stop`. A reply at that point does not mean the change was saved: in one test, about 1,600 of 4,000 acknowledged commands were missing after the restart.

**Parallel connections on vanilla Minecraft.** Vanilla servers collect command output in one buffer that all RCON connections share. If two connections run commands at the same moment, they can receive each other's output, an empty reply, or both joined together. The commands still run, but replies can be wrong. In a stress test with two connections, half of the replies were wrong. This also happens when two separate programs connect to the same server. One `Rcon` instance uses one connection, so it is not affected alone. Paper does not have this problem.

**Speed.** Each command waits for its reply before the next is sent (Minecraft closes the connection otherwise), so the round-trip time sets the limit. On Minecraft that is about 20,000 commands/s on localhost, but only about 50/s over a 20 ms link. Factorio runs one RCON command per game tick, so it handles about 60 commands/s. The tested Source servers took about 45 ms per command, about 22/s.

**Long-running commands.** A large `fill` can freeze a Minecraft server for over 10 seconds. The default timeout is 30 seconds for that reason.

## Compatibility

Only setups that were actually tested are listed here.

| Server | Status |
|---|---|
| Minecraft Java 1.16.5, 1.20.1, 26.3 (vanilla) | Tested in CI, including fragmented replies |
| Paper 1.21.11, 26.3 | Tested in CI |
| Factorio 2.1 | Tested in CI, including 1 MB replies |
| Counter-Strike: Source | Tested in CI, including fragmented replies |
| Half-Life 2: Deathmatch | Tested once, same results as CS:S |
| CS2, L4D2, TF2, Palworld, Rust, ARK, others | Not tested. Reports are welcome. |

Runtimes: Node.js 22, 24 and 26 (both `import` and `require()`), Deno 2 and Bun 1.

## Maintenance

This library gets bug fixes and compatibility updates. New features are unlikely. Please open an issue with the server software and version if something does not work.

## License

MIT
