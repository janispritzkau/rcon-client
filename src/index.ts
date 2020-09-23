// export * from "./rcon"

import { Socket } from "net"
import { EventEmitter } from "events"
import TypedEmitter from "typed-emitter"
import { decodePacket, encodePacket, Packet, PacketType } from "./packet"
import { createSplitter } from "./splitter"
import { PromiseQueue } from "./queue"

export interface RconOptions {
  /**
   * Maximum time in milliseconds to connect until an error is thrown.
   * @default 5000
   */
  connectTimeout?: number
  /**
   * Maximum time in milliseconds for a packet response to arrive before
   * an error is thrown.
   * @default 5000 ms
   */
  timeout?: number
  /**
   * Close connection on packet timeout.
   * @default false
   */
  closeOnTimeout?: boolean
  /**
   * Maximum number of parallel requests. Most minecraft servers can
   * only reliably process one packet at a time.
   * @default 1
   */
  maxPending?: number
}

const defaultOptions: RconOptions = {
  connectTimeout: 5000,
  timeout: 5000,
  maxPending: 1
}

type PacketCallback = (packet: Packet) => void

interface Events {
  connect(): void
  authenticated(): void
  error(error: Error): void
  end(): void
}

export class RconClient extends (EventEmitter as new () => TypedEmitter<Events>) {
  static async connect(host: string, port: number, password: string, options?: RconOptions) {
    const rcon = new RconClient(options)
    await rcon.connect(host, port, password)
    return rcon
  }

  socket: Socket
  authenticated = false
  nextRequestId = 0

  private sendQueue = new PromiseQueue(this.options.maxPending)
  private callbacks = new Map<number, PacketCallback>()

  constructor(public options: RconOptions = {}) {
    super()
    this.setMaxListeners(0)
    this.options.timeout = options.timeout ?? defaultOptions.timeout
    this.options.connectTimeout = options.connectTimeout ?? defaultOptions.connectTimeout
    this.options.maxPending = options.maxPending ?? defaultOptions.maxPending
    this.socket = new Socket()
    this.socket.on("error", error => this.emit("error", error))
    this.socket.on("close", () => this.emit("end"))
    this.socket.setNoDelay(true)
  }

  async connect(host: string, port: number, password: string) {
    if (this.socket.writable || this.socket.destroyed) {
      throw new Error("connect called twice")
    }

    await new Promise((resolve, reject) => {
      this.socket.setTimeout(this.options.connectTimeout!, () => {
        this.socket.destroy()
        reject(new Error("Connection timed out"))
      })
      this.on("error", reject)
      this.socket.connect({ host, port }, () => {
        this.socket.setTimeout(0)
        this.off("error", reject)
        resolve()
      })
    })

    this.emit("connect")

    this.socket
      .pipe(createSplitter())
      .on("data", this.handlePacket.bind(this))

    const packet = await this.sendPacket(PacketType.Auth, Buffer.from(password))

    if (packet.id != this.nextRequestId - 1 || packet.id == -1) {
      this.socket.destroy()
      throw new Error("Authentication failed")
    }

    this.authenticated = true
    this.emit("authenticated")
  }

  async end() {
    if (!this.socket.writable) return
    this.socket.end()
    await new Promise(resolve => this.once("end", resolve))
  }

  async send(command: string) {
    const packet = await this.sendPacket(PacketType.Command, Buffer.from(command))
    return packet.payload.toString()
  }

  private async sendPacket(type: PacketType, payload: Buffer): Promise<Packet> {
    const id = this.nextRequestId++

    return await this.sendQueue.add(() => new Promise((resolve, reject) => {
      if (!this.socket.writable) throw new Error("Socket closed or not connected")
      if (type == PacketType.Command && !this.authenticated) throw new Error("Client not yet authenticated")
      this.socket.write(encodePacket({ id, type, payload }))

      const onEnd = () => {
        clearTimeout(timeout)
        reject(new Error("Connection closed"))
      }
      this.on("end", onEnd)

      const timeout = setTimeout(() => {
        reject(new Error(`Packet with id ${id} timed out`))
        if (this.options.closeOnTimeout) this.socket.destroy()
      }, this.options.timeout!)

      this.callbacks.set(id, packet => {
        this.off("end", onEnd)
        clearTimeout(timeout)
        resolve(packet)
      })
    }))
  }

  private handlePacket(data: Buffer) {
    const packet = decodePacket(data)
    const id = this.authenticated ? packet.id : this.nextRequestId - 1
    const handler = this.callbacks.get(packet.id)

    if (handler) {
      handler(packet)
      this.callbacks.delete(id)
    }
  }
}
