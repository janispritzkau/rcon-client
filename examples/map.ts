/*
This example draws a mandelbrot map art at 0, 64, 0 on your minecraft server.
*/

import { Rcon } from "../src"

async function main() {
    const rcon = await Rcon.connect({
        host: "localhost", port: 25575, password: "1234"
    })

    const start = Date.now()

    for (let j = 0; j < 128 ** 2; j++) {
        const x = j % 128, y = (j / 128) | 0

        const c_re = (2 * x / 127 - 1.6) * 1.2
        const c_im = (2 * y / 127 - 1) * 1.2
        let z_re = 0, z_im = 0, i = 0

        while (i < 23 && z_re ** 2 + z_im ** 2 < 4) {
            let re = z_re ** 2 - z_im ** 2 + c_re
            z_im = 2 * z_re * z_im + c_im
            z_re = re
            i += 1
        }

        const block = ["obsidian", "obsidian", "blue_terracotta", "cyan_wool", "light_blue_wool", "white_wool"][(i / 4) | 0]
        await rcon.send(`/setblock ${-64 + x} ${64} ${-64 + y} ${block}`)
    }

    const elapsed = Date.now() - start
    console.log(`Took ${elapsed / 1000} seconds`)

    rcon.end()
}

main().catch(console.error)
