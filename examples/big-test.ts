// This test requires a minecraft server started with rcon
// enabled on port 25575 and the following password

const password = "password"

import {Rcon} from "../lib/rcon"

const connectOptions = {
  host: "localhost", port: 25575, password
}

const rcon = new Rcon({packetResponseTimeout: 500, resendPacketOnTimeout: true})

rcon.connect(connectOptions)
.catch(e => console.error("Couldn't connect:", e))
.then(() => {
  let promises = []

  for (let i = 0; i < 1024; i++) {
    // promises.push(rcon.send(`help ${i % 9 + 1}`))
    promises.push(rcon.send("say " + i))
  }

  console.time("help pages")
  Promise.all(promises)
  .then(helpPages => {
    console.timeEnd("help pages")
    console.log("===== All help pages =====")
    console.log(helpPages[0])
    console.log(helpPages.length)
    rcon.disconnect()
  })
  .catch(e => console.error("Error while sending packets:", e))
})
