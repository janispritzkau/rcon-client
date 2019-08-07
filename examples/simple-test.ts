import { Rcon } from "../src"

async function main() {
    const rcon = await Rcon.connect({
        host: "localhost", port: 25575, password: "password"
    })

    for (let i = 0; i < 10; i++) {
        console.log(await rcon.send("list"))
        await rcon.end()
        rcon.connect()
    }

    rcon.end()
}

main().catch(console.error)
