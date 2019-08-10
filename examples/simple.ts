import { Rcon } from "../src"

async function main() {
    const rcon = new Rcon({
        host: "localhost",
        port: 25575,
        password: "1234"
    })

    rcon.on("connect", () => console.log("connected"))
    rcon.on("authenticated", () => console.log("authenticated"))
    rcon.on("end", () => console.log("end"))

    await rcon.connect()

    console.log(await rcon.send("/list"))

    await Promise.all([...Array(10)].map((_, i) => rcon.send(`/say ${i}`)))

    rcon.end()
}

main().catch(console.error)
