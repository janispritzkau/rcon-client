# rcon-client

A simple and easy to use RCON client made to work with Minecraft servers.
It's written in Typescript and uses async methods.

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

More examples are in the [`examples/`](https://gitlab.com/janispritzkau/rcon-client/tree/master/examples) folder.

## Further Reading

Read more about the [RCON Protocol](http://wiki.vg/RCON)

## License

MIT
