import { EventEmitter } from "node:events";
import { createConnection, Socket, TcpSocketConnectOpts } from "node:net";
import TypedEmitter from "typed-emitter";
import { AsyncLock } from "./lock";

export interface RconConnectOptions extends TcpSocketConnectOpts {
  password: string;
}

type RconClientEvents = {
  connect: () => void;
  error: (err: Error) => void;
  close: () => void;
};

export class RconClient
  extends (EventEmitter as new () => TypedEmitter<RconClientEvents>) {
  static async connect(options: RconConnectOptions) {
    const client = new RconClient(options);
    await client.connect();
    return client;
  }

  #options: RconConnectOptions;
  #socket: Socket | null = null;
  #authed = false;

  #lock = new AsyncLock();
  #reqId = 0;

  #buffer = Buffer.alloc(0);
  #skipRead = false;
  #pos = 0;

  constructor(options: RconConnectOptions) {
    super();
    this.#options = options;
  }

  async connect() {
    if (this.#socket) {
      throw new Error(
        this.#authed ? "Already connected" : "Already connecting",
      );
    }

    const socket = createConnection(this.#options);
    socket.setNoDelay(true);
    this.#socket = socket;

    socket.on("error", (err) => {
      this.emit("error", err);
    });

    socket.on("close", () => {
      this.emit("close");
      this.#socket = null;
      this.#authed = false;
    });

    await new Promise<void>((resolve, reject) => {
      socket.on("connect", () => {
        resolve();
        socket.removeListener("error", reject);
      });
      socket.on("error", reject);
    });

    try {
      const reqId = this.#nextReqId();
      await this.#send(reqId, 3, this.#options.password);

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
    } catch (err) {
      if (err instanceof Error) socket.destroy(err);
      else socket.destroy();
      this.#socket = null;
      throw err;
    }
  }

  async close() {
    if (!this.#socket) throw new Error("Not connected");
    const socket = this.#socket;
    await new Promise<void>((resolve) => {
      socket.once("close", resolve);
      socket.destroy();
    });
  }

  async cmd(cmd: string): Promise<string> {
    if (!this.#authed) throw new Error("Not authenticated");
    const release = await this.#lock.acquire();
    try {
      const reqId = this.#nextReqId();
      await this.#send(reqId, 2, cmd);

      // By reading immediately after each write, we avoid packets being combined by the TCP stack,
      // thus avoiding an implementation bug in the Minecraft server
      const res = await this.#recv();

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
      // send a dummy request which is guaranteed to be not fragmented
      await this.#send(dummyReqId, -1, "");

      let output = res.message;
      while (true) {
        const res = await this.#recv();

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
    } catch (err) {
      if (err instanceof Error) this.#socket?.destroy(err);
      else this.#socket?.destroy();
      this.#socket = null;
      throw err;
    } finally {
      release();
    }
  }

  async #send(id: number, type: number, message: string) {
    const socket = this.#socket;
    if (!socket) throw new Error("Not connected");
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
      socket.write(buf, (err) => {
        if (err) reject(err);
        else resolve();
      })
    );
  }

  async #recv(): Promise<{ id: number; type: number; message: string }> {
    while (this.#socket) {
      const socket = this.#socket;
      if (!this.#skipRead) {
        const chunk = socket.read();
        if (!chunk) {
          await new Promise<void>((resolve) => {
            socket.once("readable", resolve);
          });
          continue;
        }
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
    throw new Error("Not connected");
  }

  #nextReqId() {
    const id = this.#reqId;
    this.#reqId = (this.#reqId + 1) % 0x8000_0000;
    return id;
  }
}
