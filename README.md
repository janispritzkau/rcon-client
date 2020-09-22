# rcon-client

[![npm](https://img.shields.io/npm/v/rcon-client.svg)](https://www.npmjs.com/package/rcon-client)
[![downloads](https://img.shields.io/npm/dm/rcon-client.svg)](https://www.npmjs.com/package/rcon-client)

A simple and easy to use RCON client made to work with Minecraft servers.
It's written in Typescript and uses async methods.

`rcon-client` has a built-in packet queue with a max pending setting which limits
the number of packets sent before one is received.
If you need to send a bunch of packets at once, this library might be right for you.
This was mainly the reason why I created yet another implementation.

## Install

```
npm install rcon-client@next
```

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

## Events

The `RconClient` class extends Node's `EventEmitter`. All methods of it will be available. These are all the events which the client might emit:

- `error` - Socket error has occured
- `connect` - Socket is connected but not yet authenticated.
- `authenticated` - Client has successfully authenticated with the server.
- `end` - Client connection was closed.
