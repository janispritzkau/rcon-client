import { connect, type Socket } from "node:net";
import { RconError } from "./error.ts";
import { isDelay } from "./delay.ts";
import { encodePacket, PacketReader, PacketType, type Packet } from "./packet.ts";

/**
 * Minecraft splits long replies every 4096 UTF-16 units and sends no end
 * marker, so a shorter first packet is the whole reply. Source splits on line
 * boundaries, so its fragments can be much shorter; Source connections always
 * send a probe instead.
 */
const FRAGMENT_UNITS = 4096;

/**
 * Source writes every fragment of a reply in the same server frame. If the
 * reply has started but nothing follows for this long, the server is stuck:
 * Source stops reading a connection when another RCON connection closes in
 * the same frame, and handles the stuck command again (sending its reply a
 * second time) once more data arrives.
 */
const SOURCE_STALL_MS = 2000;

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
  readonly #password: string;
  readonly #reader = new PacketReader();
  #waiter: Waiter | undefined;
  #id = 0;
  #error: Error | undefined;
  #onClose: ((error?: Error) => void) | undefined;
  #source = false;

  private constructor(socket: Socket, password: string) {
    this.#socket = socket;
    this.#password = password;
    socket.on("data", (chunk: Buffer) => this.#receive(chunk));
    socket.on("error", (error) => this.destroy(error));
    // Only reached when the server closed first; destroy() ignores repeats.
    socket.on("close", () => this.destroy(new Error("Connection closed by the server")));
  }

  /**
   * Connects and authenticates. Rejects with `AUTH_FAILED` on a wrong
   * password, or with the socket error. The socket is unref'd, so it never
   * keeps the process alive by itself; the client holds the process open
   * while it has work. Aborting `signal` gives up the attempt and rejects
   * with `CLOSED`.
   */
  static open(
    options: ConnectionOptions,
    onClose: (error?: Error) => void,
    signal?: AbortSignal,
  ): Promise<Connection> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new RconError("CLOSED", "Client is closed"));
      const socket = connect({ host: options.host, port: options.port });
      socket.unref();
      const fail = (error: Error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        socket.destroy();
        reject(error);
      };
      const onAbort = () => fail(new RconError("CLOSED", "Client is closed"));
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = isDelay(options.connectTimeout)
        ? setTimeout(
            () => fail(new Error(`Connect timed out after ${options.connectTimeout}ms`)),
            options.connectTimeout,
          )
        : undefined;
      timer?.unref();
      socket.once("error", fail);
      socket.once("connect", async () => {
        socket.off("error", fail);
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 30_000);
        const connection = new Connection(socket, options.password);
        try {
          await connection.#authenticate();
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          if (!connection.alive) throw connection.#error;
          connection.#onClose = onClose;
          resolve(connection);
        } catch (error) {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          connection.destroy();
          reject(error);
        }
      });
    });
  }

  get alive(): boolean {
    return this.#error === undefined;
  }

  /**
   * `true` if the server behaves like a Source dedicated server: it sent an
   * empty RESPONSE_VALUE before the AUTH_RESPONSE. Minecraft and Factorio
   * do not.
   */
  get source(): boolean {
    return this.#source;
  }

  async exec(command: string): Promise<string> {
    let id: number;
    let probe: number;
    const parts: Buffer[] = [];
    if (this.#source) {
      // Source reads pipelined requests in order, so the probe can follow
      // right away and costs no extra round trip. Both go out in one write,
      // so the server normally reads them together: during the stuck-read
      // bug (see SOURCE_STALL_MS), a probe arriving later would make it
      // handle the command a second time.
      const [commandId, commandPacket] = this.#packet(PacketType.Command, command);
      const [probeId, probePacket] = this.#probePacket();
      this.#socket.write(Buffer.concat([commandPacket, probePacket]));
      id = commandId;
      probe = probeId;
    } else {
      id = this.#send(PacketType.Command, command);
      const first = await this.#reply(id);
      const text = first.body.toString("utf8");
      if (text.length < FRAGMENT_UNITS) return text;
      // The reply may continue. Every fragment was written before the server
      // read our next packet, so the reply to this probe marks the end.
      // Minecraft closes the connection on pipelined requests, so the probe
      // goes out only now, after the first fragment, never earlier.
      probe = this.#sendProbe();
      parts.push(first.body);
    }
    for (;;) {
      // Waiting longer would not help, and sending anything to nudge the
      // server would make it handle the command a second time, so drop the
      // connection instead.
      const packet =
        this.#source && parts.length
          ? await this.#nextWithin(
              SOURCE_STALL_MS,
              "The Source server stopped answering in the middle of a reply",
            )
          : await this.#next();
      if (packet.id === probe) break;
      if (packet.id === -1) throw this.#authLost();
      if (packet.id === id) parts.push(packet.body);
    }
    // Decode once so a UTF-8 sequence split on a byte boundary survives.
    return Buffer.concat(parts).toString("utf8");
  }

  /** Round trip in milliseconds, measured from the write. */
  async ping(): Promise<number> {
    const started = performance.now();
    const id = this.#sendProbe();
    for (;;) {
      const packet = await this.#next();
      if (packet.id === id) break;
      if (packet.id === -1) throw this.#authLost();
    }
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

  async #authenticate(): Promise<void> {
    const id = this.#send(PacketType.Auth, this.#password);
    // Source sends an empty RESPONSE_VALUE before the AUTH_RESPONSE, so wait
    // for the packet that carries the verdict.
    for (;;) {
      const packet = await this.#next();
      if (packet.type !== PacketType.Command) {
        if (packet.id === id && packet.type === PacketType.Response) this.#source = true;
        continue;
      }
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

  /**
   * Sends a request whose reply serves as a ping and as the end marker for
   * fragmented replies. Minecraft and Factorio answer a repeated password in
   * order and outside the game loop. Unknown packet types do not work there:
   * Factorio ignores them. Source gets its documented end marker instead, an
   * empty RESPONSE_VALUE that it mirrors.
   */
  #probePacket(): [id: number, packet: Buffer] {
    return this.#source
      ? this.#packet(PacketType.Response, "")
      : this.#packet(PacketType.Auth, this.#password);
  }

  #sendProbe(): number {
    const [id, packet] = this.#probePacket();
    this.#socket.write(packet);
    return id;
  }

  /** The server rejected the repeated password, so it changed since connect. */
  #authLost(): RconError {
    const error = new RconError("AUTH_FAILED", "Wrong RCON password");
    this.destroy(error);
    return error;
  }

  #packet(type: number, body: string): [id: number, packet: Buffer] {
    if (this.#error) throw this.#error;
    this.#id = (this.#id % 0x7fff_fffe) + 1;
    return [this.#id, encodePacket(this.#id, type, body)];
  }

  #send(type: number, body: string): number {
    const [id, packet] = this.#packet(type, body);
    // One write call per packet: Minecraft closes the connection if a request
    // arrives split across reads.
    this.#socket.write(packet);
    return id;
  }

  #next(): Promise<Packet> {
    if (this.#error) return Promise.reject(this.#error);
    const { promise, resolve, reject } = Promise.withResolvers<Packet>();
    this.#waiter = { resolve, reject };
    this.#drain();
    return promise;
  }

  /** Like `#next`, but destroys the connection if nothing arrives in time. */
  async #nextWithin(ms: number, message: string): Promise<Packet> {
    const timer = setTimeout(() => this.destroy(new Error(message)), ms);
    timer.unref();
    try {
      return await this.#next();
    } finally {
      clearTimeout(timer);
    }
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
