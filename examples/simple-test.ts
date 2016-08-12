// This test requires a minecraft server started with rcon
// enabled on port 25575 and the following password

const password = "e3IuiM9DFyEC"

import {Rcon, Packet} from "../lib/rcon"

let rcon = new Rcon

rcon.connect({port: 25575, password})
.then(() => console.log("Connected"))
.catch((error) => console.log(error.message))

function getAllHelpPages(): Promise<string[]> {
  let helpPages: string[] = []
  return new Promise((resolve, reject) => {
    for (let i = 1; i <= 9; i++) {
      rcon.send(`help ${i}`, response => {
        helpPages.push(response)
        if (i == 9) {
          rcon.disconnect()
          resolve(helpPages)
        }
      })
    }
  })
}

getAllHelpPages().then(helpPages => {
  helpPages.forEach(helpPage => console.log(helpPage.slice(0, 96) + " .."))
}).then(() => {
  rcon.send("list", (res) => {
    console.log(res)
    rcon.disconnect()
  })
  rcon.connect({port: 25575, password})
})
