import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { afterEach, describe, test } from "node:test";
import { Rcon, RconError, type RconOptions } from "../src/index.ts";
import { FakeServer, wait, type FakeServerOptions } from "./fake-server.ts";

const servers: FakeServer[] = [];
const clients: Rcon[] = [];

async function setup(server?: FakeServerOptions, client?: Partial<RconOptions>) {
  const fake = await FakeServer.start(server);
  servers.push(fake);
  const rcon = new Rcon({ host: "127.0.0.1", port: fake.port, password: "secret", ...client });
  clients.push(rcon);
  return { fake, rcon };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((rcon) => rcon.end()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** A port with nothing listening on it. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * Idle client sockets are unref'd on purpose, so waiting for an event alone
 * would let the event loop drain on some Node versions.
 */
async function held<T>(promise: Promise<T>): Promise<T> {
  const timer = setTimeout(() => {}, 10_000);
  try {
    return await promise;
  } finally {
    clearTimeout(timer);
  }
}

function rejectsWith(promise: Promise<unknown>, code: string, sent?: boolean) {
  return assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof RconError, `expected RconError, got ${error}`);
    assert.equal(error.code, code);
    if (sent !== undefined) assert.equal(error.sent, sent, "sent");
    return true;
  });
}

describe("basics", () => {
  test("sends a command and returns its output", async () => {
    const { rcon } = await setup();
    assert.equal(await rcon.send("list"), "ran list");
  });

  test("Rcon.connect connects and authenticates", async () => {
    const fake = await FakeServer.start();
    servers.push(fake);
    const rcon = await Rcon.connect({ host: "127.0.0.1", port: fake.port, password: "secret" });
    clients.push(rcon);
    assert.equal(rcon.connected, true);
    assert.equal(await rcon.send("seed"), "ran seed");
  });

  test("the constructor does no I/O", async () => {
    const { fake, rcon } = await setup();
    await wait(50);
    assert.equal(fake.connections, 0);
    assert.equal(rcon.connected, false);
    await rcon.send("list");
    assert.equal(fake.connections, 1);
  });

  test("keeps empty replies and unicode intact", async () => {
    const { rcon } = await setup({ handler: (command) => (command === "empty" ? "" : `→ ${command} ✓`) });
    assert.equal(await rcon.send("empty"), "");
    assert.equal(await rcon.send("töst €"), "→ töst € ✓");
  });

  test("emits connect, disconnect and end", async () => {
    const { rcon } = await setup();
    const events: string[] = [];
    rcon.on("connect", () => events.push("connect"));
    rcon.on("disconnect", () => events.push("disconnect"));
    rcon.on("end", () => events.push("end"));
    await rcon.send("list");
    await rcon.end();
    assert.deepEqual(events, ["connect", "disconnect", "end"]);
  });
});

describe("rule 1: one at a time, in order", () => {
  test("Promise.all of many commands never overlaps on the wire", async () => {
    const { fake, rcon } = await setup({ handler: async (command) => (await wait(0), command) });
    const commands = Array.from({ length: 500 }, (_, i) => `cmd ${i}`);
    const replies = await Promise.all(commands.map((command) => rcon.send(command)));
    assert.deepEqual(replies, commands);
    assert.deepEqual(fake.commands, commands);
    assert.deepEqual(fake.violations, []);
    assert.equal(fake.connections, 1);
  });

  test("ping overtakes queued commands", async () => {
    const order: string[] = [];
    const { rcon } = await setup({ handler: async (command) => (await wait(20), command) });
    const a = rcon.send("a").then(() => order.push("a"));
    const b = rcon.send("b").then(() => order.push("b"));
    await wait(5);
    const ping = rcon.ping().then((ms) => {
      assert.equal(typeof ms, "number");
      order.push("ping");
    });
    await Promise.all([a, b, ping]);
    assert.deepEqual(order, ["a", "ping", "b"]);
  });
});

describe("fragmented replies", () => {
  for (const [length, fragments] of [[4095, 1], [4096, 1], [4097, 2], [8192, 2], [8193, 3], [20_000, 5]] as const) {
    test(`${length} characters arrive whole (${fragments} fragments)`, async () => {
      const output = Array.from({ length }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
      const { fake, rcon } = await setup({ handler: () => output });
      assert.equal(await rcon.send("big"), output);
      assert.equal(await rcon.send("small"), output, "the next command is not confused by leftovers");
      assert.deepEqual(fake.violations, []);
    });
  }

  test("counts UTF-16 units, not bytes: 5000 € characters", async () => {
    const output = "€".repeat(5000);
    const { rcon } = await setup({ handler: () => output });
    assert.equal(await rcon.send("euro"), output);
  });

  test("a fragmented reply in the middle of a busy queue", async () => {
    const big = "x".repeat(9200);
    const { rcon } = await setup({ handler: (command) => (command === "big" ? big : command) });
    const replies = await Promise.all(["a", "big", "b", "big", "c"].map((command) => rcon.send(command)));
    assert.deepEqual(replies, ["a", big, "b", big, "c"]);
  });
});

describe("command size", () => {
  test("rejects oversized commands before sending", async () => {
    const { fake, rcon } = await setup();
    await rejectsWith(rcon.send("x".repeat(1447)), "COMMAND_TOO_LONG", false);
    await rejectsWith(rcon.send("€".repeat(483)), "COMMAND_TOO_LONG", false);
    assert.equal(fake.connections, 0);
  });

  test("accepts exactly 1446 bytes", async () => {
    const { fake, rcon } = await setup({ handler: (command) => String(command.length) });
    assert.equal(await rcon.send("x".repeat(1446)), "1446");
    assert.deepEqual(fake.violations, []);
  });

  test("maxCommandBytes is configurable", async () => {
    const { rcon } = await setup({ maxPayload: 4000 }, { maxCommandBytes: 4000 });
    assert.equal(await rcon.send("x".repeat(3000)), "ran " + "x".repeat(3000));
  });
});

describe("rule 2 and 6: connecting and reconnecting", () => {
  test("Rcon.connect fails on the first error", async () => {
    const port = await freePort();
    await rejectsWith(Rcon.connect({ host: "127.0.0.1", port, password: "x" }), "CONNECTION_FAILED", false);
  });

  test("new Rcon keeps retrying until the command's deadline", async () => {
    const port = await freePort();
    const rcon = new Rcon({ host: "127.0.0.1", port, password: "x" });
    clients.push(rcon);
    let attempts = 0;
    rcon.on("reconnecting", ({ attempt, delay, error }) => {
      attempts = attempt;
      assert.ok(delay > 0);
      assert.ok(error instanceof Error);
    });
    await rejectsWith(rcon.send("list", { timeout: 800 }), "TIMEOUT", false);
    assert.ok(attempts >= 2, `expected retries, got ${attempts}`);
  });

  test("unsent commands wait through a server restart", async () => {
    const { fake, rcon } = await setup();
    await rcon.send("before");
    const dropped = held(new Promise((resolve) => rcon.once("disconnect", resolve)));
    await fake.close();
    await dropped;
    const pending = Promise.all([rcon.send("a"), rcon.send("b")]);
    await wait(400);
    await fake.listen();
    assert.deepEqual(await pending, ["ran a", "ran b"]);
  });

  test("reconnect: false rejects queued commands when the connect fails", async () => {
    const port = await freePort();
    const rcon = new Rcon({ host: "127.0.0.1", port, password: "x", reconnect: false });
    clients.push(rcon);
    await Promise.all([
      rejectsWith(rcon.send("a"), "CONNECTION_FAILED", false),
      rejectsWith(rcon.send("b"), "CONNECTION_FAILED", false),
    ]);
  });

  test("connect timeout covers a server that accepts but never answers", async () => {
    const { fake, rcon } = await setup({}, { connectTimeout: 200, reconnect: false });
    fake.frozen = true;
    await rejectsWith(rcon.connect(), "CONNECTION_FAILED", false);
  });
});

describe("rule 3: sent commands are never replayed", () => {
  test("a drop mid-command rejects with sent: true and does not resend", async () => {
    let runs = 0;
    const { fake, rcon } = await setup({
      handler: (command, socket) => {
        if (command === "give") {
          runs++;
          socket.destroy();
        }
        return command;
      },
    });
    const give = rcon.send("give");
    const next = rcon.send("next");
    await rejectsWith(give, "CONNECTION_LOST", true);
    assert.equal(await next, "next", "queued commands continue on a new connection");
    assert.equal(runs, 1);
    assert.equal(fake.connections, 2);
  });
});

describe("rule 4: timeouts", () => {
  test("the default timeout is 30s", async () => {
    const { rcon } = await setup({ handler: async () => (await wait(2500), "slow") });
    assert.equal(await rcon.send("fill"), "slow");
  });

  test("an unsent command times out with sent: false", async () => {
    const { rcon } = await setup({ handler: async (command) => (await wait(300), command) });
    const first = rcon.send("first");
    await rejectsWith(rcon.send("second", { timeout: 100 }), "TIMEOUT", false);
    assert.equal(await first, "first");
  });

  test("a sent command times out with sent: true and drops the socket", async () => {
    const { fake, rcon } = await setup({
      handler: async (command) => {
        if (command === "stall") await wait(500);
        return command;
      },
    });
    await rejectsWith(rcon.send("stall", { timeout: 100 }), "TIMEOUT", true);
    assert.equal(await rcon.send("after"), "after", "the late reply does not leak into the next command");
    assert.equal(fake.connections, 2);
  });

  test("queue time counts toward the timeout", async () => {
    const { rcon } = await setup({ handler: async (command) => (await wait(150), command) });
    const started = performance.now();
    const blocker = rcon.send("blocker");
    await rejectsWith(rcon.send("queued", { timeout: 100 }), "TIMEOUT", false);
    assert.ok(performance.now() - started < 140);
    await blocker;
  });

  test("an AbortSignal cancels a queued command", async () => {
    const { fake, rcon } = await setup({ handler: async (command) => (await wait(100), command) });
    const controller = new AbortController();
    const first = rcon.send("first");
    const second = rcon.send("second", { signal: controller.signal });
    controller.abort();
    await rejectsWith(second, "ABORTED", false);
    assert.equal(await first, "first");
    assert.deepEqual(fake.commands, ["first"]);
  });

  test("an already aborted signal rejects at once", async () => {
    const { fake, rcon } = await setup();
    await rejectsWith(rcon.send("x", { signal: AbortSignal.abort() }), "ABORTED", false);
    assert.equal(fake.connections, 0);
  });

  test("AbortSignal.timeout works as a deadline", async () => {
    const { rcon } = await setup({ handler: async () => (await wait(300), "late") });
    await rejectsWith(rcon.send("x", { signal: AbortSignal.timeout(50) }), "ABORTED", true);
  });
});

describe("rule 5: wrong password", () => {
  test("rejects every queued command and does not retry in a loop", async () => {
    const { fake, rcon } = await setup({ password: "right" });
    await Promise.all([
      rejectsWith(rcon.send("a"), "AUTH_FAILED", false),
      rejectsWith(rcon.send("b"), "AUTH_FAILED", false),
    ]);
    await wait(300);
    assert.equal(fake.connections, 1);
  });

  test("Rcon.connect rejects with AUTH_FAILED", async () => {
    const fake = await FakeServer.start({ password: "right" });
    servers.push(fake);
    await rejectsWith(Rcon.connect({ host: "127.0.0.1", port: fake.port, password: "wrong" }), "AUTH_FAILED");
  });
});

describe("rule 7 and 8: no crashes, no hangs", () => {
  test("a connection reset without listeners does not crash", async () => {
    const { fake, rcon } = await setup();
    await rcon.send("a");
    for (const socket of fake.sockets) socket.resetAndDestroy();
    await wait(50);
    assert.equal(await rcon.send("b"), "ran b");
  });

  test("forgetting end() does not keep the process alive", async () => {
    const fake = await FakeServer.start();
    servers.push(fake);
    const script = `
      import { Rcon } from "./src/index.ts";
      const rcon = new Rcon({ host: "127.0.0.1", port: ${fake.port}, password: "secret", heartbeat: 1000 });
      console.log(await rcon.send("list"));
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => (child.kill(), reject(new Error("process hung"))), 5000);
      child.on("exit", (code) => (clearTimeout(timer), resolve(code)));
    });
    assert.equal(code, 0);
    assert.equal(output.trim(), "ran list");
  });

  test("Rcon.connect keeps a script alive until it settles", async () => {
    const fake = await FakeServer.start();
    servers.push(fake);
    const script = `
      import { Rcon } from "./src/index.ts";
      const rcon = await Rcon.connect({ host: "127.0.0.1", port: ${fake.port}, password: "secret" });
      console.log(rcon.connected);
      await rcon.end();
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    const code = await new Promise((resolve) => child.on("exit", resolve));
    assert.equal(output.trim(), "true");
    assert.equal(code, 0);
  });

  test("a pending command keeps the process alive while reconnecting", async () => {
    const port = await freePort();
    const script = `
      import { Rcon } from "./src/index.ts";
      const rcon = new Rcon({ host: "127.0.0.1", port: ${port}, password: "x", timeout: 600 });
      try { await rcon.send("list"); } catch (error) { console.log(error.code); }
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    await new Promise((resolve) => child.on("exit", resolve));
    assert.equal(output.trim(), "TIMEOUT");
  });
});

describe("end and dispose", () => {
  test("end() finishes queued commands first", async () => {
    const { rcon } = await setup({ handler: async (command) => (await wait(10), command) });
    const replies = Promise.all([rcon.send("a"), rcon.send("b"), rcon.send("c")]);
    await rcon.end();
    assert.deepEqual(await replies, ["a", "b", "c"]);
    assert.equal(rcon.connected, false);
  });

  test("send after end() rejects with CLOSED", async () => {
    const { rcon } = await setup();
    await rcon.end();
    await rejectsWith(rcon.send("x"), "CLOSED", false);
    await rejectsWith(rcon.connect(), "CLOSED");
  });

  test("end() is idempotent and works without a connection", async () => {
    const { fake, rcon } = await setup();
    await Promise.all([rcon.end(), rcon.end()]);
    assert.equal(fake.connections, 0);
  });

  test("Symbol.asyncDispose ends the client", async () => {
    const { rcon } = await setup();
    await rcon.send("x");
    await rcon[Symbol.asyncDispose]();
    await rejectsWith(rcon.send("y"), "CLOSED");
  });
});

describe("heartbeat", () => {
  test("detects a frozen server and reconnects after it recovers", async () => {
    const { fake, rcon } = await setup({}, { heartbeat: 100 });
    const events: string[] = [];
    rcon.on("connect", () => events.push("connect"));
    rcon.on("disconnect", () => events.push("disconnect"));
    await rcon.connect();
    fake.frozen = true;
    await wait(350);
    assert.equal(rcon.connected, false);
    fake.frozen = false;
    fake.dropAll();
    await wait(600);
    assert.equal(rcon.connected, true);
    assert.deepEqual(events.slice(0, 3), ["connect", "disconnect", "connect"]);
    assert.equal(await rcon.send("list"), "ran list");
  });

  test("does not ping while commands keep the connection busy", async () => {
    const { fake, rcon } = await setup({ handler: async (command) => (await wait(30), command) }, { heartbeat: 50 });
    for (let i = 0; i < 6; i++) await rcon.send(`c${i}`);
    assert.equal(fake.commands.length, 6);
    assert.equal(fake.connections, 1);
  });
});

describe("sendAll", () => {
  test("yields results in order", async () => {
    const { rcon } = await setup();
    const results: string[] = [];
    for await (const reply of rcon.sendAll(["a", "b", "c"])) results.push(reply);
    assert.deepEqual(results, ["ran a", "ran b", "ran c"]);
  });

  test("pulls from the source only as results are consumed", async () => {
    const { rcon } = await setup();
    let pulled = 0;
    function* endless() {
      for (;;) {
        pulled++;
        yield "x";
      }
    }
    let seen = 0;
    for await (const _ of rcon.sendAll(endless())) if (++seen === 100) break;
    assert.ok(pulled <= 100 + 16, `pulled ${pulled}`);
  });

  test("throws the first failure", async () => {
    const { rcon } = await setup({ handler: (command, socket) => (command === "bad" && socket.destroy(), command) });
    const results: string[] = [];
    await assert.rejects(async () => {
      for await (const reply of rcon.sendAll(["a", "bad", "c"])) results.push(reply);
    }, (error: RconError) => error.code === "CONNECTION_LOST");
    assert.deepEqual(results, ["a"]);
  });
});
