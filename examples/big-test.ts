// This example requires a minecraft server running with rcon
// enabled on port 25575 and 'password' as password

import { Rcon } from "../src"

const rcon = new Rcon({ timeout: 500, host: "localhost", port: 25575, password: "password" })

rcon.connect()
    .catch(e => console.error("Couldn't connect:", e))
    .then(() => {
        const promises = new Array(2000).fill(null).map((_, i) => {
            return rcon.send("say " + i)
        })

        console.time("promises")
        Promise.all(promises).then(responses => {
            console.timeEnd("promises")
            console.log(responses.length)
            return rcon.end()
        })
            .catch(e => console.error("Error while sending packets:", e))
    })
