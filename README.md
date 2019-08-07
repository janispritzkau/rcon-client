# rcon-client

[![npm version](https://img.shields.io/npm/v/rcon-client.svg)](https://www.npmjs.com/package/rcon-client)

A simple and easy to use RCON client made to work with Minecraft servers.
It's written in Typescript and uses async methods.

## Basic Usage

```js
import { Rcon } from "rcon-client"

const rcon = await Rcon.connect({
    host: "localhost", port: 25575,
    password: "password"
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

More examples are in the [`examples/`](https://github.com/janispritzkau/rcon-client/tree/master/examples) folder.

## Further Reading

Read more about the [RCON Protocol](http://wiki.vg/RCON)

## License

MIT
