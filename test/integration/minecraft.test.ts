/**
 * Runs against a real Minecraft server. Skipped unless RCON_PORT is set.
 *
 *   RCON_HOST=127.0.0.1 RCON_PORT=25575 RCON_PASSWORD=... npm run test:integration
 *
 * The server should be a throwaway flat world: the tests write to command
 * storage `rcon:test`.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Rcon, RconError } from "../../src/index.ts";

const { RCON_HOST = "127.0.0.1", RCON_PORT, RCON_PASSWORD = "" } = process.env;
const options = { host: RCON_HOST, port: Number(RCON_PORT), password: RCON_PASSWORD };

/** Paper cuts long `data get` output and ends it with an ellipsis. */
const truncated = (reply: string) => /\.\.\.$/.test(reply);

describe(`Minecraft server at ${RCON_HOST}:${RCON_PORT}`, { skip: !RCON_PORT && "RCON_PORT not set" }, () => {
  let rcon: Rcon;
  before(async () => {
    rcon = await Rcon.connect(options);
  });
  after(() => rcon?.end());

  test("runs a command", async () => {
    assert.match(await rcon.send("list"), /players online/);
  });

  test("ping is answered", async () => {
    const ms = await rcon.ping();
    assert.ok(ms >= 0 && ms < 1000, `${ms}ms`);
  });

  test("a wrong password fails with AUTH_FAILED", async () => {
    await assert.rejects(
      Rcon.connect({ ...options, password: `${RCON_PASSWORD}-wrong` }),
      (error: RconError) => error.code === "AUTH_FAILED",
    );
  });

  test("1000 parallel commands stay in order", async () => {
    const replies = await Promise.all(Array.from({ length: 1000 }, (_, i) => rcon.send(`seed`).then((r) => [i, r] as const)));
    for (const [, reply] of replies) assert.match(reply, /^Seed: \[-?\d+\]$/);
  });

  test("a 1446-byte command is accepted", async () => {
    const command = `say ${"x".repeat(1446 - 4)}`;
    assert.equal(Buffer.byteLength(command), 1446);
    await rcon.send(command);
    assert.match(await rcon.send("list"), /players online/, "the connection survived");
  });

  test("large replies arrive whole", async () => {
    const item = "y".repeat(1300);
    await rcon.send("data remove storage rcon:test s");
    await rcon.send("data modify storage rcon:test s set value []");
    for (let i = 0; i < 12; i++) await rcon.send(`data modify storage rcon:test s append value "${item}"`);
    const reply = await rcon.send("data get storage rcon:test s");
    if (truncated(reply)) {
      // Paper shortens long NBT output itself, but it still spans fragments.
      assert.ok(reply.length > 4096, `reply is ${reply.length} characters`);
    } else {
      assert.ok(reply.length > 4096 * 3, `reply is ${reply.length} characters`);
      assert.equal(reply.split(item).length - 1, 12, "every element is present");
      assert.match(reply, /]$/);
    }
    assert.match(await rcon.send("list"), /players online/, "no leftover fragments");
  });

  test("multi-byte replies count UTF-16 units", async () => {
    const item = "€".repeat(400);
    await rcon.send("data modify storage rcon:test e set value []");
    for (let i = 0; i < 15; i++) await rcon.send(`data modify storage rcon:test e append value "${item}"`);
    const reply = await rcon.send("data get storage rcon:test e");
    if (!truncated(reply)) {
      assert.ok(reply.length > 4096, `reply is ${reply.length} characters`);
      assert.equal(reply.split(item).length - 1, 15);
    }
    assert.doesNotMatch(reply, /\uFFFD/, "no broken characters");
  });

  test("sendAll streams many commands", async () => {
    let count = 0;
    for await (const reply of rcon.sendAll(Array.from({ length: 2000 }, () => "difficulty"))) {
      assert.match(reply, /difficulty/i);
      count++;
    }
    assert.equal(count, 2000);
  });
});
