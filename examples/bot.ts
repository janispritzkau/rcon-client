// A long-running process: no I/O until the first command, recovers by itself.
// node examples/bot.ts
import { Rcon, RconError } from "../src/index.ts";

const rcon = new Rcon({
  host: process.env.RCON_HOST ?? "localhost",
  password: process.env.RCON_PASSWORD ?? "",
  heartbeat: 30_000,
});

rcon.on("connect", () => console.log("connected"));
rcon.on("disconnect", (error) => console.log("disconnected", error?.message ?? ""));
rcon.on("reconnecting", ({ attempt, delay }) => console.log(`retry ${attempt} in ${delay}ms`));

async function announce(message: string) {
  try {
    await rcon.send(`say ${message}`, { signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    // `sent: false` means the command definitely did not run, so retrying is safe.
    if (error instanceof RconError && !error.sent) return announce(message);
    console.error("may or may not have run:", error);
  }
}

setInterval(() => announce(`It is ${new Date().toLocaleTimeString()}`), 60_000);
process.on("SIGINT", () => rcon.end().then(() => process.exit()));
