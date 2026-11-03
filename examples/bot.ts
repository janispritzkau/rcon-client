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

async function announce(message: string, attempt = 1): Promise<void> {
  try {
    await rcon.send(`say ${message}`, { timeout: 10_000 });
  } catch (error) {
    if (!(error instanceof RconError)) throw error;
    // `sent: false` means it definitely did not run. Only a timeout is worth
    // retrying: AUTH_FAILED, CLOSED and COMMAND_TOO_LONG would fail again.
    if (!error.sent && error.code === "TIMEOUT" && attempt < 3) return announce(message, attempt + 1);
    console.error(error.sent ? "may or may not have run:" : "did not run:", error.code);
  }
}

setInterval(() => announce(`It is ${new Date().toLocaleTimeString()}`), 60_000);
process.on("SIGINT", () => rcon.end().then(() => process.exit()));
