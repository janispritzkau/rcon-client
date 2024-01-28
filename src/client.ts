import { createConnection, Socket, TcpNetConnectOpts } from "node:net";
import { EventEmitter } from "node:events";

export interface RconConnectOptions extends TcpNetConnectOpts {
  password: string;
}

export class RconClient extends EventEmitter {
  readonly socket: Socket;

  #lockPromise: Promise<void> = Promise.resolve();
  #authed = false;
  #reqId = 0;
  #closed = false;

  #readable: Promise<void>;
  #buffer = Buffer.alloc(0);
  #skipRead = false;
  #pos = 0;

  static async connect(options: RconConnectOptions): Promise<RconClient> {
    const socket = createConnection(options);

    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });

    const client = new RconClient(socket);
    await client.auth(options.password);

    return client;
  }

  constructor(socket: Socket) {
    super();
    this.socket = socket;

    // TODO: proper socket event handling

    let resolveReadable: () => void;
    this.#readable = new Promise((resolve) => resolveReadable = resolve);

    socket.on("close", () => {
      resolveReadable();
      this.#closed = true;
      this.emit("close");
    });

    socket.on("readable", () => {
      resolveReadable();
      this.#readable = new Promise((resolve) => resolveReadable = resolve);
    });
  }

  async auth(password: string) {
    if (this.#authed) throw new Error("Already authenticated");
    const release = await this.#lock();
    try {
      const reqId = this.#nextReqId();
      await this.#send(reqId, 3, password);

      const res = await this.#recv();
      if (!res) throw new Error("Connection closed");

      if (res.id == -1) throw new Error("Authentication failed");
      if (res.id != reqId) {
        throw new Error(
          `Invalid response id (expected ${reqId}, got ${res.id})`,
        );
      }
      if (res.type != 2) {
        throw new Error(
          `Unexpected response type (expected 2, got ${res.type})`,
        );
      }

      this.#authed = true;
    } catch (e) {
      await this.close();
      throw e;
    } finally {
      release();
    }
  }

  async cmd(cmd: string): Promise<string | null> {
    if (!this.#authed) throw new Error("Not authenticated");
    const release = await this.#lock();
    try {
      const reqId = this.#nextReqId();
      await this.#send(reqId, 2, cmd);

      // By reading immediately after each write, we avoid packets being combined by the TCP stack,
      // thus avoiding an implementation bug in the Minecraft server
      const res = await this.#recv();
      if (!res) return null;

      if (res.id != reqId) {
        throw new Error(
          `Invalid response id (expected ${reqId}, got ${res.id})`,
        );
      }
      if (res.type != 0) {
        throw new Error(
          `Unexpected response type (expected 0, got ${res.type})`,
        );
      }

      if (res.message.length < 4096) {
        // message is guaranteed to be not fragmented
        // note: minecraft java counts the length as utf-16 code units (like we do here)
        this.#reqId += 1;
        return res.message;
      }

      const dummyReqId = this.#nextReqId();
      // send dummy request which is guaranteed to be not fragmented
      await this.#send(dummyReqId, -1, "");

      let output = res.message;
      while (true) {
        const res = await this.#recv();
        if (!res) return null;

        // message is complete when dummy response is received
        if (res.id == dummyReqId) break;

        if (res.id != reqId) {
          throw new Error(
            `Invalid response id (expected ${reqId}, got ${res.id})`,
          );
        }
        if (res.type != 0) {
          throw new Error(
            `Unexpected response type (expected 0, got ${res.type})`,
          );
        }

        output += res.message;
      }
      return output;
    } catch (e) {
      if (!this.#closed) await this.close();
      throw e;
    } finally {
      release();
    }
  }

  async close() {
    this.#closed = true;
    await new Promise<void>((resolve) => this.socket.end(resolve));
  }

  async #send(id: number, type: number, message: string) {
    if (this.#closed) throw new Error("Connection closed");
    const payload = new TextEncoder().encode(message);
    const buf = new Uint8Array(14 + payload.length);
    const view = new DataView(buf.buffer);
    view.setUint32(0, 10 + payload.length, true);
    view.setInt32(4, id, true);
    view.setInt32(8, type, true);
    buf.set(payload, 12);
    // this may still result in a fragmented tcp packet if used over external network interfaces,
    // therefore using RCON over anything other than localhost is not recommended
    if (buf.length > 1460) throw new Error("Message too long");
    await new Promise<void>((resolve, reject) =>
      this.socket.write(buf, (err) => {
        if (err) reject(err);
        else resolve();
      })
    );
  }

  async #recv(): Promise<{ id: number; type: number; message: string } | null> {
    while (!this.#closed) {
      if (!this.#skipRead) {
        await this.#readable;
        const chunk = this.socket.read();
        if (!chunk) continue;
        this.#buffer = Buffer.concat([this.#buffer, chunk]);
        this.#pos += chunk.length;
      }

      this.#skipRead = false;

      if (this.#pos < 4) continue;
      const len = this.#buffer.readUInt32LE(0);

      if (this.#pos < 4 + len) continue;
      const id = this.#buffer.readInt32LE(4);
      const type = this.#buffer.readInt32LE(8);
      const payload = this.#buffer.subarray(12, len + 2);
      const message = new TextDecoder().decode(payload);

      this.#buffer = this.#buffer.subarray(len + 4);
      this.#pos -= len + 4;
      this.#skipRead = true;
      return { id, type, message };
    }
    return null;
  }

  #lock(): Promise<() => void> {
    return new Promise((resolve) => {
      this.#lockPromise = this.#lockPromise.then(() => {
        return new Promise((release) => resolve(release));
      });
    });
  }

  #nextReqId() {
    const id = this.#reqId;
    this.#reqId = (this.#reqId + 1) % 0x8000_0000;
    return id;
  }
}
