// A one-off script: fail fast, run some commands, close.
// node examples/script.ts
import { Rcon } from "../src/index.ts";

const rcon = await Rcon.connect({
  host: process.env.RCON_HOST ?? "localhost",
  password: process.env.RCON_PASSWORD ?? "",
});

console.log(await rcon.send("list"));

// Commands run one at a time, in order, so Promise.all is safe.
const replies = await Promise.all(["seed", "difficulty", "time query daytime"].map((c) => rcon.send(c)));
console.log(replies);

await rcon.end();
