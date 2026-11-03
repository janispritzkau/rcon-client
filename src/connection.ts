import { connect, type Socket } from "node:net";
import { RconError } from "./error.ts";
import { isDelay } from "./delay.ts";
import { encodePacket, PacketReader, PacketType, type Packet } from "./packet.ts";

/**
 * Minecraft answers any unknown packet type with "Unknown request ffffffff"
 * from the RCON thread, without touching the main thread.
 */
const PING_TYPE = -1;

/**
 * Minecraft splits long replies every 4096 UTF-16 units and sends no end
 * marker. Source splits on bytes, a bit below 4096. A reply below both limits
 * cannot have more fragments.
 */
const FRAGMENT_UNITS = 4096;
const FRAGMENT_BYTES = 4000;

export interface ConnectionOptions {
  host: string;
  port: number;
  password: string;
  connectTimeout: number;
}

interface Waiter {
  resolve: (packet: Packet) => void;
  reject: (error: Error) => void;
}

/**
 * One authenticated socket. It sends strictly one request at a time and
 * waits for the reply before the next one, because Minecraft closes the
 * connection if a second packet arrives early.
 *
 * Callers must not overlap `exec` and `ping` calls.
 */
export class Connection {
  readonly #socket: Socket;
  readonly #reader = new PacketReader();
  #waiter: Waiter | undefined;
  #id = 0;
  #error: Error | undefined;
  #onClose: ((error?: Error) => void) | undefined;

  private constructor(socket: Socket) {
    this.#socket = socket;
    socket.on("data", (chunk: Buffer) => this.#receive(chunk));
    socket.on("error", (error) => this.destroy(error));
    // Only reached when the server closed first; destroy() ignores repeats.
    socket.on("close", () => this.destroy(new Error("Connection closed by the server")));
  }

  /**
   * Connects and authenticates. Rejects with `AUTH_FAILED` on a wrong
   * password, or with the socket error. The socket is unref'd, so it never
   * keeps the process alive by itself; the client holds the process open
   * while it has work.
   */
  static open(options: ConnectionOptions, onClose: (error?: Error) => void): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: options.host, port: options.port });
      socket.unref();
      const fail = (error: Error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };
      const timer = isDelay(options.connectTimeout)
        ? setTimeout(() => fail(new Error(`Connect timed out after ${options.connectTimeout}ms`)), options.connectTimeout)
        : undefined;
      timer?.unref();
      socket.once("error", fail);
      socket.once("connect", async () => {
        socket.off("error", fail);
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 30_000);
        const connection = new Connection(socket);
        try {
          await connection.#authenticate(options.password);
          clearTimeout(timer);
          if (!connection.alive) throw connection.#error;
          connection.#onClose = onClose;
          resolve(connection);
        } catch (error) {
          clearTimeout(timer);
          connection.destroy();
          reject(error);
        }
      });
    });
  }

  get alive(): boolean {
    return this.#error === undefined;
  }

  async exec(command: string): Promise<string> {
    const id = this.#send(PacketType.Command, command);
    const first = await this.#reply(id);
    const text = first.body.toString("utf8");
    if (text.length < FRAGMENT_UNITS && first.body.length < FRAGMENT_BYTES) return text;

    // The reply may continue. Every fragment was written before the server
    // read our next packet, so the reply to this probe marks the end. The
    // probe goes out only now, after the first fragment, never earlier.
    const probe = this.#send(PacketType.Response, "");
    const parts = [first.body];
    for (;;) {
      const packet = await this.#next();
      if (packet.id === probe) break;
      if (packet.id === id) parts.push(packet.body);
    }
    // Decode once so a UTF-8 sequence split on a byte boundary survives.
    return Buffer.concat(parts).toString("utf8");
  }

  /** Round trip in milliseconds, measured from the write. */
  async ping(): Promise<number> {
    const started = performance.now();
    await this.#reply(this.#send(PING_TYPE, ""));
    return performance.now() - started;
  }

  destroy(error?: Error): void {
    if (!this.alive) return;
    this.#error = error ?? new Error("Connection closed");
    this.#socket.destroy();
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.reject(this.#error);
    this.#onClose?.(error);
  }

  async #authenticate(password: string): Promise<void> {
    const id = this.#send(PacketType.Auth, password);
    // Source sends an empty RESPONSE_VALUE before the AUTH_RESPONSE, so wait
    // for the packet that carries the verdict.
    for (;;) {
      const packet = await this.#next();
      if (packet.type !== PacketType.Command) continue;
      if (packet.id === -1) throw new RconError("AUTH_FAILED", "Wrong RCON password");
      if (packet.id === id) return;
    }
  }

  async #reply(id: number): Promise<Packet> {
    for (;;) {
      const packet = await this.#next();
      // Leftovers from an earlier request (for example Source's second probe
      // reply) carry older ids and are skipped.
      if (packet.id === id) return packet;
    }
  }

  #send(type: number, body: string): number {
    if (this.#error) throw this.#error;
    this.#id = (this.#id % 0x7fff_fffe) + 1;
    // One write call per packet: Minecraft closes the connection if a request
    // arrives split across reads.
    this.#socket.write(encodePacket(this.#id, type, body));
    return this.#id;
  }

  #next(): Promise<Packet> {
    if (this.#error) return Promise.reject(this.#error);
    const { promise, resolve, reject } = Promise.withResolvers<Packet>();
    this.#waiter = { resolve, reject };
    this.#drain();
    return promise;
  }

  #receive(chunk: Buffer): void {
    this.#reader.push(chunk);
    this.#drain();
  }

  #drain(): void {
    const waiter = this.#waiter;
    if (!waiter) return;
    let packet: Packet | undefined;
    try {
      packet = this.#reader.read();
    } catch (error) {
      this.destroy(new RconError("PROTOCOL", (error as Error).message));
      return;
    }
    if (!packet) return;
    this.#waiter = undefined;
    waiter.resolve(packet);
  }
}
