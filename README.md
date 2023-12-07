# rcon-client

[![npm](https://img.shields.io/npm/v/rcon-client.svg)](https://www.npmjs.com/package/rcon-client)
[![downloads](https://img.shields.io/npm/dm/rcon-client.svg)](https://www.npmjs.com/package/rcon-client)

> **⚠️ This library has not been maintained for a while. Please use it with caution or switch to another implementation!**

A simple and easy to use RCON client made to work with Minecraft servers.
It's written in Typescript and uses async methods.

`rcon-client` has a built-in packet queue with a max pending setting which limits
the number of packets sent before one is received.
If you need to send a bunch of packets at once, this library might be right for you.
This was mainly the reason why I created yet another implementation.

The `Rcon` class supports connecting and disconnecting at any time, making it easier to share an instance in many places.

## Usage

```js
import { Rcon } from "rcon-client"

const rcon = await Rcon.connect({
    host: "localhost", port: 25575, password: "1234"
})

console.log(await rcon.send("list"))

let responses = await Promise.all([
    rcon.send("help"),
    rcon.send("whitelist list")
])

for (response of responses) {
    console.log(response)
}

rcon.end()
```

Or alternatively you can create an instance via the constructor.

```js
const rcon = new Rcon({ host: "localhost", port: 25575, password: "1234" })

await rcon.connect()
rcon.end()
```

More examples can be found in the repository's [`examples/`](https://github.com/janispritzkau/rcon-client/tree/master/examples) folder.

## Events

`rcon-client` uses node's event emitter internally. The event emitter is accessible
with the `emitter` property. Additionally the `on`, `once` and `off` methods are exposed on the main class.

The `Rcon` class has these events:

- `connect`
- `authenticated`
- `end`
- `error`

Auto reconnect can be implemented with these events.
