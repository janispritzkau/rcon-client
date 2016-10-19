# rcon-client

A simple RCON client made to work with Minecraft servers for Node.js.
It's written in Typescript and uses ES6 Promises.

## Installation

```shell
npm install --save rcon-client
```

## Basic Usage

```js
import {Rcon} from "rcon-client"

const rcon = new Rcon()

// the send method can be called before the client is connected
rcon.send("list").then(response => console.log(response))

rcon.connect({host: "localhost", port: 25525, password: "2xGWv4zSf4"})
.then(() => {
  console.log("[Info] Connected")

  Promise.all([
    rcon.send("help 1"),
    rcon.send("help 2")
  ])
  .then(responses => {
    console.log(`Help pages:\n`, responses)
    return rcon.disconnect()
  })
  .then(() => console.log("[Info] Disconnected"))
})
```

More examples are in the [`examples/`](examples/) folder.

## API

See [API Reference](API.md).

## Further Reading

Read more about the [RCON Protocol](http://wiki.vg/RCON)

## License

MIT
