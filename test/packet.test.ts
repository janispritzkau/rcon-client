import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:net";
import { describe, test } from "node:test";
import { Rcon, RconError } from "../src/index.ts";
import { encodePacket, PacketReader } from "../src/packet.ts";

describe("PacketReader", () => {
  test("round-trips a packet", () => {
    const reader = new PacketReader();
    reader.push(encodePacket(7, 2, "héllo"));
    assert.deepEqual(reader.read(), { id: 7, type: 2, body: Buffer.from("héllo") });
    assert.equal(reader.read(), undefined);
  });

  test("reassembles packets split at every byte and joined together", () => {
    const stream = Buffer.concat([encodePacket(1, 0, "first"), encodePacket(-1, 2, ""), encodePacket(3, 0, "€")]);
    const reader = new PacketReader();
    const packets = [];
    for (const byte of stream) {
      reader.push(Buffer.from([byte]));
      for (let packet; (packet = reader.read());) packets.push(packet);
    }
    assert.deepEqual(packets.map((p) => [p.id, p.type, p.body.toString()]), [[1, 0, "first"], [-1, 2, ""], [3, 0, "€"]]);
  });

  test("rejects impossible lengths", () => {
    const reader = new PacketReader();
    const bad = Buffer.alloc(14);
    bad.writeInt32LE(3, 0);
    reader.push(bad);
    assert.throws(() => reader.read(), /Invalid packet length/);
  });
});

describe("Source-style servers", () => {
  /** Answers auth like srcds: an empty RESPONSE_VALUE, then the AUTH_RESPONSE. */
  async function source(password: string) {
    const server = createServer((socket) => {
      const reader = new PacketReader();
      socket.on("data", (chunk) => {
        reader.push(chunk);
        for (let packet; (packet = reader.read());) {
          if (packet.type === 3) {
            socket.write(encodePacket(packet.id, 0, ""));
            socket.write(encodePacket(packet.body.toString() === password ? packet.id : -1, 2, ""));
          } else if (packet.type === 2) {
            socket.write(encodePacket(packet.id, 0, `ok ${packet.body.toString()}`));
          } else if (packet.type === 0) {
            socket.write(encodePacket(packet.id, 0, ""));
            socket.write(encodePacket(packet.id, 0, Buffer.from([0, 1, 0, 0])));
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, port: (server.address() as AddressInfo).port };
  }

  test("waits for the AUTH_RESPONSE before deciding", async () => {
    const { server, port } = await source("pw");
    try {
      await assert.rejects(
        Rcon.connect({ host: "127.0.0.1", port, password: "wrong" }),
        (error: RconError) => error.code === "AUTH_FAILED",
      );
      const rcon = await Rcon.connect({ host: "127.0.0.1", port, password: "pw" });
      assert.equal(await rcon.send("status"), "ok status");
      await rcon.end();
    } finally {
      server.close();
    }
  });
});
