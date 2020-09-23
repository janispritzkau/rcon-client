import { RconClient } from "../src"

async function main() {
  const rcon = new RconClient()

  rcon.on("error", (error) => console.log("error", error))
  rcon.on("connect", () => console.log("connected"))
  rcon.on("authenticated", () => console.log("authenticated"))
  rcon.on("end", () => console.log("end"))

  await rcon.connect("localhost", 25575, "1234")

  console.log(await rcon.send("list"))

  rcon.end()
}

main().catch(console.error)
