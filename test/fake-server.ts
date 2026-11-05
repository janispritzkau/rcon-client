import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { encodePacket, PacketReader, type Packet } from "../src/packet.ts";

export type Handler = (command: string, socket: Socket) => string | Promise<string>;

export interface FakeServerOptions {
  password?: string;
  /** Produces a command's output. May be async to simulate a busy main thread. */
  handler?: Handler;
  /** Largest accepted request payload in bytes. Minecraft: 1446. */
  maxPayload?: number;
  /** Fragment size in UTF-16 units. Minecraft: 4096. Factorio: `Infinity`. */
  fragment?: number;
  /** Ignore packets of unknown types and empty commands instead of answering them, like Factorio. */
  ignoreUnknown?: boolean;
  /**
   * Behave like a Source dedicated server instead: an empty RESPONSE_VALUE
   * before every AUTH_RESPONSE, pipelined requests allowed, replies split on
   * line boundaries below 4096 bytes, and an oversized request bans the
   * client's address.
   */
  source?: boolean;
}

/** Largest reply fragment a Source server sends, in bytes. */
const SOURCE_FRAGMENT = 4096;

/** Splits like Source: whole lines while they fit, so fragment sizes vary. */
function sourceFragments(output: string): Buffer[] {
  const fragments: Buffer[] = [];
  let current = Buffer.alloc(0);
  for (const line of output.split(/(?<=\n)/)) {
    let rest = Buffer.from(line);
    if (current.length + rest.length > SOURCE_FRAGMENT && current.length) {
      fragments.push(current);
      current = Buffer.alloc(0);
    }
    while (rest.length > SOURCE_FRAGMENT) {
      fragments.push(rest.subarray(0, SOURCE_FRAGMENT));
      rest = rest.subarray(SOURCE_FRAGMENT);
    }
    current = Buffer.concat([current, rest]);
  }
  if (current.length || !fragments.length) fragments.push(current);
  return fragments;
}

/**
 * An RCON server that behaves like the vanilla Minecraft server, including
 * the strict parts that break naive clients:
 *
 * - a packet arriving before the previous reply closes the connection
 * - a request split across reads, or two in one read, closes it
 * - a payload over 1446 bytes closes it
 * - a wrong password gets reply id -1 and the socket stays open
 * - unknown packet types are answered with "Unknown request <hex>"
 * - replies are split every 4096 UTF-16 units with no end marker
 */
export class FakeServer {
  readonly options: Required<FakeServerOptions>;
  readonly sockets = new Set<Socket>();
  /** Every command the server executed, across all connections. */
  readonly commands: string[] = [];
  connections = 0;
  /** Connections the server closed because the client broke the protocol. */
  violations: string[] = [];
  /** While set, the server reads nothing and answers nothing, like a stopped JVM. */
  frozen = false;
  /** Source mode: set once a client sent an oversized packet. Every later connection is dropped. */
  banned = false;
  /**
   * Source mode: the next command is answered and the rest of the read is left
   * unprocessed, like Source right after another connection closed. When more
   * data arrives, the stuck command runs again, as on a real server.
   */
  stallNext = false;
  #server: Server | undefined;
  port = 0;

  constructor(options: FakeServerOptions = {}) {
    this.options = {
      password: "secret",
      handler: (command) => `ran ${command}`,
      maxPayload: 1446,
      fragment: 4096,
      ignoreUnknown: false,
      source: false,
      ...options,
    };
  }

  static async start(options?: FakeServerOptions): Promise<FakeServer> {
    const server = new FakeServer(options);
    await server.listen();
    return server;
  }

  /** Listens on a random port the first time, then on the same port again. */
  async listen(): Promise<void> {
    const server = createServer((socket) => this.#accept(socket));
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, "127.0.0.1", () => resolve());
    });
    this.port = (server.address() as AddressInfo).port;
  }

  /** Stops listening and drops every connection, like a server shutdown. */
  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    const server = this.#server;
    this.#server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Drops every open connection but keeps listening. */
  dropAll(): void {
    for (const socket of this.sockets) socket.destroy();
  }

  #accept(socket: Socket): void {
    this.connections++;
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => {});
    if (this.options.source) return this.#acceptSource(socket);
    let authed = false;
    let busy = false;

    const violate = (reason: string) => {
      this.violations.push(reason);
      socket.destroy();
    };

    const reply = (id: number, type: number, body: string) => {
      if (!socket.destroyed) socket.write(encodePacket(id, type, body));
    };

    const handle = async (chunk: Buffer) => {
      if (busy) return violate("packet before reply");
      if (chunk.length < 14) return violate("short read");
      const length = chunk.readInt32LE(0);
      if (chunk.length !== length + 4) {
        return violate(chunk.length < length + 4 ? "split packet" : "two packets in one read");
      }
      const id = chunk.readInt32LE(4);
      const type = chunk.readInt32LE(8);
      const payload = chunk.subarray(12, chunk.length - 2);
      if (payload.length > this.options.maxPayload) return violate("payload too long");
      const body = payload.toString("utf8");

      if (type === 3) {
        authed = body === this.options.password;
        reply(authed ? id : -1, 2, "");
        return;
      }
      if (!authed) return violate("not authenticated");
      if (type !== 2) {
        if (this.options.ignoreUnknown) return;
        reply(id, 0, `Unknown request ${(type >>> 0).toString(16)}`);
        return;
      }

      if (body === "" && this.options.ignoreUnknown) return;
      busy = true;
      this.commands.push(body);
      let output: string;
      try {
        output = await this.options.handler(body, socket);
      } finally {
        busy = false;
      }
      const size = this.options.fragment;
      if (output.length === 0) reply(id, 0, "");
      for (let i = 0; i < output.length; i += size) reply(id, 0, output.slice(i, i + size));
    };

    socket.on("data", (chunk: Buffer) => {
      if (!this.frozen) void handle(chunk);
    });
  }

  /** Source dedicated server behaviour, as measured on CS:S and HL2DM. */
  #acceptSource(socket: Socket): void {
    if (this.banned) return void socket.destroy();
    const reader = new PacketReader();
    const queue: Packet[] = [];
    let authed = false;
    let working = false;
    let stalled: Packet[] | undefined;

    const reply = (id: number, type: number, body: string | Buffer) => {
      if (!socket.destroyed) socket.write(encodePacket(id, type, body));
    };

    const work = async () => {
      if (working) return;
      working = true;
      while (queue.length && !socket.destroyed) {
        const { id, type, body: payload } = queue.shift()!;
        if (payload.length > this.options.maxPayload) {
          this.violations.push("payload too long");
          this.banned = true;
          socket.destroy();
          break;
        }
        const body = payload.toString("utf8");
        if (type === 3) {
          authed = body === this.options.password;
          reply(id, 0, "");
          reply(authed ? id : -1, 2, "");
        } else if (!authed) {
          socket.destroy();
        } else if (type === 0) {
          // The documented end marker: an empty mirror, then 00 01 00 00.
          reply(id, 0, "");
          reply(id, 0, Buffer.from([0, 1, 0, 0]));
        } else if (type !== 2) {
          reply(id, 0, "");
        } else {
          this.commands.push(body);
          const output = await this.options.handler(body, socket);
          for (const fragment of sourceFragments(output)) reply(id, 0, fragment);
          if (this.stallNext) {
            this.stallNext = false;
            // Keep the rest unread and replay the command with it later.
            stalled = [{ id, type, body: payload }, ...queue.splice(0)];
            break;
          }
        }
      }
      working = false;
    };

    socket.on("data", (chunk: Buffer) => {
      if (this.frozen) return;
      reader.push(chunk);
      if (stalled) {
        queue.push(...stalled);
        stalled = undefined;
      }
      for (let packet = reader.read(); packet; packet = reader.read()) queue.push(packet);
      void work();
    });
  }
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
