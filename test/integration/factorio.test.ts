/**
 * Runs against a real Factorio server. Skipped unless RCON_SERVER=factorio.
 *
 *   RCON_SERVER=factorio RCON_PORT=27015 RCON_PASSWORD=... npm run test:integration
 *
 * Uses `/sc`, which disables achievements for the save.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Rcon, RconError } from "../../src/index.ts";

const { RCON_HOST = "127.0.0.1", RCON_PORT = "27015", RCON_PASSWORD = "", RCON_SERVER } = process.env;
const options = { host: RCON_HOST, port: Number(RCON_PORT), password: RCON_PASSWORD };

describe(`Factorio server at ${RCON_HOST}:${RCON_PORT}`, { skip: RCON_SERVER !== "factorio" && "RCON_SERVER is not factorio" }, () => {
  let rcon: Rcon;
  before(async () => {
    rcon = await Rcon.connect({ ...options, maxCommandBytes: 100_000 });
    // The first /sc only warns that achievements will be disabled.
    await rcon.send("/sc rcon.print('ready')");
    assert.equal(await rcon.send("/sc rcon.print('ready')"), "ready\n");
  });
  after(() => rcon?.end());

  test("runs a command", async () => {
    assert.match(await rcon.send("/version"), /^\d+\.\d+\.\d+\n$/);
  });

  test("ping is answered although Factorio ignores unknown packet types", async () => {
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

  test("a wrong password fails with AUTH_FAILED", async () => {
    await assert.rejects(
      Rcon.connect({ ...options, password: `${RCON_PASSWORD}-wrong` }),
      (error: RconError) => error.code === "AUTH_FAILED",
    );
  });

  test("a 1 MB reply arrives whole and quickly", async () => {
    const started = performance.now();
    const reply = await rcon.send(`/sc rcon.print(string.rep("x", 1000000))`, { timeout: 5000 });
    assert.equal(reply.length, 1_000_001);
    assert.ok(performance.now() - started < 2000);
  });

  test("multi-byte replies stay intact", async () => {
    assert.equal(await rcon.send(`/sc rcon.print(string.rep("€", 50000))`), `${"€".repeat(50000)}\n`);
  });

  test("commands longer than Minecraft's limit work with maxCommandBytes", async () => {
    const text = "y".repeat(5000);
    assert.equal(await rcon.send(`/sc rcon.print("${text}")`), `${text}\n`);
  });

  test("200 parallel commands stay in order", async () => {
    const replies = await Promise.all(
      Array.from({ length: 200 }, (_, i) => rcon.send(`/sc rcon.print(${i})`)),
    );
    replies.forEach((reply, i) => assert.equal(reply, `${i}\n`));
  });
});
