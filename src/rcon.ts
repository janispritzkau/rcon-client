import { Socket, connect } from "net"
import TypedEmitter from "typed-emitter"

import { decodePacket, encodePacket, PacketType, Packet } from "./packet"
import { createSplitter } from "./splitter"
import { PromiseQueue } from "./queue"
import { EventEmitter } from "events"

export interface RconOptions {
    host: string
    /** @default 25575 */
    port?: number
    password: string
    /**
     * Maximum time for a packet to arrive before an error is thrown
     * @default 2000 ms
     */
    timeout?: number,
    /**
     * Maximum number of parallel requests. Most minecraft servers can
     * only reliably process one packet at a time.
     * @default 1
     */
    maxPending?: number
}

const defaultOptions = {
    port: 25575,
    timeout: 2000,
    maxPending: 1
}

interface Events {
    connect: () => void
    authenticated: () => void
    end: () => void
    error: (error: any) => void
}

export class Rcon {
    static async connect(config: RconOptions): Promise<Rcon> {
        const rcon = new Rcon(config)
        await rcon.connect()
        return rcon
    }

    private sendQueue: PromiseQueue
    private callbacks = new Map<number, (packet: Packet) => void>()
    private requestId = 0

    config: Required<RconOptions>

    emitter = new EventEmitter() as TypedEmitter<Events>
    socket: Socket | null = null
    authenticated = false

    on = this.emitter.on.bind(this.emitter)
    once = this.emitter.once.bind(this.emitter)
    off = this.emitter.removeListener.bind(this.emitter)

    constructor(config: RconOptions) {
        this.config = { ...defaultOptions, ...config }
        this.sendQueue = new PromiseQueue(this.config.maxPending)
    }

    async connect() {
        if (this.socket) {
            throw new Error("Already connected or connecting")
        }

        const socket = this.socket = connect({
            host: this.config.host,
            port: this.config.port
        })

        socket.setNoDelay(true)
        socket.on("error", error => this.emitter.emit("error", error))

        await new Promise((resolve, reject) => {
            socket.once("error", reject)
            socket.on("connect", () => {
                socket.off("error", reject)
                resolve()
            })
        })

        this.emitter.emit("connect")

        this.socket.on("close", () => {
            this.emitter.emit("end")
            this.sendQueue.pause()
            this.socket = null
            this.authenticated = false
        })

        this.socket
            .pipe(createSplitter())
            .on("data", this.handlePacket.bind(this))

        const id = this.requestId
        const packet = await this.sendPacket(PacketType.Auth, Buffer.from(this.config.password))

        this.sendQueue.resume()

        if (packet.id != id || packet.id == -1) {
            this.sendQueue.pause()
            this.socket.destroy()
            this.socket = null
            throw new Error("Authentication failed")
        }

        this.authenticated = true
        this.emitter.emit("authenticated")
        return this
    }

    /**
      Close the connection to the server.
    */
    async end() {
        if (!this.socket || this.socket.connecting) {
            throw new Error("Not connected")
        }
        if (!this.socket.writable) throw new Error("End called twice")
        this.sendQueue.pause()
        this.socket.end()
        await new Promise(resolve => this.on("end", resolve))
    }

    /**
      Send a command to the server.

      @param command The command that will be executed on the server.
      @returns A promise that will be resolved with the command's response from the server.
    */
    async send(command: string) {
        const payload = await this.sendRaw(Buffer.from(command, "utf-8"))
        return payload.toString("utf-8")
    }

    async sendRaw(buffer: Buffer) {
        if (!this.authenticated || !this.socket) throw new Error("Not connected")
        const packet = await this.sendPacket(PacketType.Command, buffer)
        return packet.payload
    }

    private async sendPacket(type: PacketType, payload: Buffer) {
        const id = this.requestId++

        const createSendPromise = () => {
            this.socket!.write(encodePacket({ id, type, payload }))

            return new Promise<Packet>((resolve, reject) => {
                const onEnd = () => (reject(new Error("Connection closed")), clearTimeout(timeout))
                this.emitter.on("end", onEnd)

                const timeout = setTimeout(() => {
                    this.off("end", onEnd)
                    reject(new Error(`Timeout for packet id ${id}`))
                }, this.config.timeout)

                this.callbacks.set(id, packet => {
                    this.off("end", onEnd)
                    clearTimeout(timeout)
                    resolve(packet)
                })
            })
        }

        if (type == PacketType.Auth) {
            return createSendPromise()
        } else {
            return await this.sendQueue.add(createSendPromise)
        }
    }

    private handlePacket(data: Buffer) {
        const packet = decodePacket(data)

        const id = this.authenticated ? packet.id : this.requestId - 1
        const handler = this.callbacks.get(id)

        if (handler) {
            handler(packet)
            this.callbacks.delete(id)
        }
    }
}
