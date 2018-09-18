# rcon-client

A simple RCON client made to work with Minecraft servers for Node.js.
It's written in Typescript and uses async functions.

## Installation

```shell
npm i --save rcon-client
```

## Basic Usage

```js
import { Rcon } from "rcon-client"

const rcon = await Rcon.connect({
  host: "localhost", port: 25575,
  password: "password"
})

console.log("Connected")

let listResponse = await rcon.send("list")
console.log(listResponse)

let responses = await Promise.all([
  rcon.send("help"),
  rcon.send("whitelist list")
])

for (response of responses) {
  console.log(response)
}

rcon.end()
```

More examples are in the [`examples/`](examples/) folder.

## API

See [API Reference](API.md).

## Further Reading

Read more about the [RCON Protocol](http://wiki.vg/RCON)

## License

MIT
