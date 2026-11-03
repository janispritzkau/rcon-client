// Stream a large list of commands with backpressure.
// node examples/bulk.ts commands.txt
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { Rcon } from "../src/index.ts";

const rcon = await Rcon.connect({
  host: process.env.RCON_HOST ?? "localhost",
  password: process.env.RCON_PASSWORD ?? "",
});

const lines = createInterface({ input: createReadStream(process.argv[2]!) });
let count = 0;
for await (const reply of rcon.sendAll(lines)) {
  if (++count % 1000 === 0) console.log(count, reply);
}
console.log(`ran ${count} commands`);
await rcon.end();
