// This test requires a minecraft server started with rcon
// enabled on port 25575 and the following password

const password = "password"

import {Rcon} from "../lib/rcon"

const connectOptions = {
  host: "localhost", port: 25575, password
}

const rcon = new Rcon

rcon.onDidConnect(() => console.log("Client connected"))
rcon.onDidAuthenticate(() => console.log("Client authenticated"))
rcon.onDidDisconnect(() => console.log("Client disconnected"))

rcon.send("list").then(console.log)

rcon.connect(connectOptions)
.catch(e => console.error("Couldn't connect:", e))
.then(() => {
  Promise.all([1, 2, 3, 4, 5, 6, 7, 8, 9].map(a => rcon.send(`help ${a}`)))
  .then(helpPages => {
    console.log("===== All help pages =====")
    console.log(helpPages.map(a => a.slice(0, 80) + " .."))
    rcon.disconnect()
  })
})
