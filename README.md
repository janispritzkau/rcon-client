rcon-client
===========

A Node.js RCON Client made for Minecraft

**rcon-client** is a simple Node JS RCON client for Minecraft servers written in typescript.

## Installation

```
npm install --save rcon-client
```

## Basic Usage

```js
let rcon = new Rcon

rcon.connect({port: 25525, password: "2xGWv4zSf4"}).then(() => {
  // connected and authenticated
  console.log("[RCON] Connected")
})

rcon.send("list", res => {
  console.log(res) // -> There are 0/4 players online:
  rcon.disconnect()
})
```

Chaining the `::send` method works too.

```js
rcon.send("say 1")
.send("say 2")
.send("time set 1000")
```

The order if you first call the `::send` or the `::connect` method is not important.
If there is no connection to the server the RCON client will wait until
there is a connection and queue the commands.

Some examples are in the [`examples/`](examples/) folder.

## API

`new Rcon(config: RconConfig)`

- `RconConfig.timeout` Timeout of packet response in milliseconds.

### Methods

- `connect(options: RconConnectOptions): Promise<any>` Connect client to the server
  Promise will be resolved when connected and authenticated to the server.
  - `options.password`
  - `options.host` (default: `"localhost"`)
  - `options.port` (default: `25575`)
- `disconnect()` Ends the socket to the server.
- `send(command: string, callback?: (response: string) => any)`
  Sends a command to the server and calls the callback function if defined.


- `onDidConnect(callback: () => any)` Client connected to server.
- `onDidAuthenticate(callback: () => any)` Client authenticated with server.
- `onDidDisconnect(callback: () => any)` Connection closed to server.
- `onError(callback: (error: Error) => any)` Rcon class error.

### Properties

- `socket: Socket` A net.Socket instance. Only exist when connected.
- `connected: boolean` If the socket is connected.
- `authenticated: boolean` If the server is connected and has sent
  back a positive authentication packet.
