// This example requires a minecraft server running with rcon
// enabled on port 25575 and 'password' as password

import { Rcon } from "../src"

const connectOptions = {
    host: "localhost", port: 25575, password: "password"
}

async function main() {
    const rcon = await Rcon.connect(connectOptions)

    console.log("Connected")

    let listResponse = await rcon.send("list")
    console.log(listResponse)

    let responses = await Promise.all([
        rcon.send("help"),
        rcon.send("whitelist list")
    ])

    for (let response of responses) {
        console.log(response)
    }

    rcon.end()
}

main().catch(console.error)
