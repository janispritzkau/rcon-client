# rcon-client

[![npm version](https://img.shields.io/npm/v/rcon-client.svg)](https://www.npmjs.com/package/rcon-client)
[![licence](https://img.shields.io/github/license/janispritzkau/rcon-client)](https://github.com/janispritzkau/rcon-client/blob/master/LICENSE)

A simple and easy to use RCON client made to work with Minecraft servers.
It's written in Typescript and uses async methods.

`rcon-client` has a built-in package queue with a max pending setting which
restricts the number of packets sent before one is received.

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

More examples can be found inthe repository's [`examples/`](https://github.com/janispritzkau/rcon-client/tree/master/examples) folder.

`rcon-client` uses node's event emitter internally. The `Rcon` class doesn't
extend the `EventEmitter` class but instead has a `emitter` property that can be used
to access all of the methods of the event emitter. Additionally the `on`, `once` and `off` methods are exposed on the main class.

The `Rcon` class has these events:

- `connect`
- `authenticated`
- `end`
- `error`

## Further Reading

Read more about the [RCON Protocol](http://wiki.vg/RCON)

## License

MIT
