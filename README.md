# rcon-client

[![npm](https://img.shields.io/npm/v/rcon-client.svg)](https://www.npmjs.com/package/rcon-client)
[![downloads](https://img.shields.io/npm/dm/rcon-client.svg)](https://www.npmjs.com/package/rcon-client)

A simple and easy to use RCON client made to work with Minecraft servers.
It's written in TypeScript and uses async methods.

`rcon-client` has a built-in packet queue with a max pending setting which limits
the number of packets sent before one is received. It can be useful against bad
server implementations.

## Usage

```js
import { RconClient } from "rcon-client"

const rcon = await RconClient.connect("localhost", 25575, "password")

console.log(await rcon.send("list"))

const responses = await Promise.all([
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
const rcon = new RconClient()
await rcon.connect("localhost", 25575, "password")
rcon.end()
```

More examples can be found in the repository's [`examples/`](https://github.com/janispritzkau/rcon-client/tree/next/examples) folder.

## Events and error handling

The class `RconClient` extends Node's `EventEmitter`. All methods of it will be available.
These are all the events the clients might emit:

- `error` - Socket error has occured
- `connect` - Socket is connected but not yet authenticated.
- `authenticated` - Client has successfully authenticated with the server.
- `end` - Client connection was closed.

Make sure to add a `error` event handler to the `RconClient` instance to prevent
unexpected crashes.
