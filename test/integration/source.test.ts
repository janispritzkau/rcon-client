/**
 * Runs against a real Source dedicated server (tested with CS:S and HL2DM).
 * Skipped unless RCON_SERVER=source.
 *
 *   RCON_SERVER=source RCON_PORT=27015 RCON_PASSWORD=... npm run test:integration
 *
 * Sends one wrong password, as the last test: after it, the server stops
 * answering other connections from the same address. Source bans an address
 * after `sv_rcon_maxfailures` (default 10) wrong passwords.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Rcon, RconError } from "../../src/index.ts";

const { RCON_HOST = "127.0.0.1", RCON_PORT = "27015", RCON_PASSWORD = "", RCON_SERVER } = process.env;
// Short timeouts so a hang fails in seconds instead of after the 30s default.
const options = { host: RCON_HOST, port: Number(RCON_PORT), password: RCON_PASSWORD, timeout: 10_000 };

describe(`Source server at ${RCON_HOST}:${RCON_PORT}`, { skip: RCON_SERVER !== "source" && "RCON_SERVER is not source" }, () => {
  let rcon: Rcon;
  before(async () => {
    rcon = await Rcon.connect(options);
  });
  after(() => rcon?.end());

  test("runs a command", async () => {
    assert.match(await rcon.send("version"), /Server version/);
  });

  test("ping is answered", async () => {
    const ms = await rcon.ping({ timeout: 2000 });
    assert.ok(ms >= 0 && ms < 2000, `${ms}ms`);
  });

  test("heartbeat keeps the connection", async () => {
    const client = await Rcon.connect({ ...options, heartbeat: 100 });
    let drops = 0;
    client.on("disconnect", () => drops++);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(drops, 0);
    assert.equal(client.connected, true);
    await client.end();
  });

  test("cvarlist arrives whole although its fragments are short", async () => {
    const reply = await rcon.send("cvarlist");
    const total = reply.match(/(\d+) total convars\/concommands/);
    assert.ok(total, "the reply ends with the total line");
    const rows = reply.split("\n").filter((line) => / : /.test(line)).length;
    assert.ok(reply.length > 50_000, `reply is ${reply.length} characters`);
    // Every cvar row is there: the header row is the only extra one.
    assert.ok(Math.abs(rows - Number(total[1])) <= 1, `${rows} rows, server says ${total[1]}`);
    assert.match(await rcon.send("version"), /Server version/, "no leftover fragments");
  });

  test("commands over 1014 bytes reject before they get the address banned", async () => {
    await rcon.send(`echo ${"x".repeat(1014 - 5)}`);
    await assert.rejects(
      rcon.send(`echo ${"x".repeat(1015 - 5)}`),
      (error: RconError) => error.code === "COMMAND_TOO_LONG" && !error.sent,
    );
    assert.match(await rcon.send("version"), /Server version/, "the connection survived");
  });

  test("100 parallel commands stay in order", async () => {
    const replies = await Promise.all(
      Array.from({ length: 100 }, (_, i) => rcon.send(`echo marker${i}`)),
    );
    replies.forEach((reply, i) => assert.match(reply, new RegExp(`^marker${i}\\b`)));
  });

  // Keep this last.
  test("a wrong password fails with AUTH_FAILED, and the client recovers from the silence that follows", async (t) => {
    await assert.rejects(
      Rcon.connect({ ...options, password: `${RCON_PASSWORD}-wrong` }),
      (error: RconError) => error.code === "AUTH_FAILED",
    );
    // Source stops answering the existing connection. The command times out
    // with sent: true, the socket is dropped, and the next command reconnects.
    const first = await rcon.send("version", { timeout: 3000 }).then(() => "answered", (error: RconError) => error.code);
    t.diagnostic(`command on the existing connection after a wrong password: ${first}`);
    assert.match(await rcon.send("version"), /Server version/);
  });
});
