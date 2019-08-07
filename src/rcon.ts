import { Socket, connect } from "net"
import { Emitter } from "event-kit"

import { decodePacket, encodePacket, PacketType, Packet } from "./packet"
import { createSplitter } from "./splitter"
import { PromiseQueue } from "./queue"

export interface RconConfig {
    host: string
    /** @default 25575 */
    port?: number
    password: string
    /** @default 2000 ms */
    timeout?: number,
    /** @default 1 */
    maxPending?: number
    /** @default false */
    reconnect?: boolean
}

const defaultConfig = {
    port: 25575,
    timeout: 2000,
    maxPending: 1,
    reconnect: false
}

export class Rcon {
    private emitter = new Emitter()
    private sendQueue: PromiseQueue
    private callbacks = new Map<number, (packet: Packet) => void>()
    private requestId = 0

    config: Required<RconConfig>
    socket: Socket | null = null
    authenticated = false

    constructor(config: RconConfig) {
        this.config = { ...defaultConfig, ...config }
        this.sendQueue = new PromiseQueue(this.config.maxPending)
    }

    /**
      Create `Rcon` instance and call the `.connect()` function with options

      @returns A promise that will be resolved after the client is authenticated
      with the server.
    */
    static async connect(config: RconConfig): Promise<Rcon> {
        const rcon = new Rcon(config)
        await rcon.connect()
        return rcon
    }

    onError(callback: (error: any) => any) {
        return this.emitter.on("error", callback)
    }

    onConnected(callback: () => any) {
        return this.emitter.on("connected", callback)
    }

    /**
      Connect and authenticate with the server.

      @returns A promise that will be resolved after the client is authenticated
      with the server.
    */
    async connect() {
        if (this.authenticated) return this

        this.socket = connect({ host: this.config.host, port: this.config.port })

        await new Promise((resolve, reject) => {
            this.socket!.on("error", reject)
            this.socket!.on("connect", (error: any) => {
                if (error) reject(error)
                else resolve()
                this.socket!.removeListener("error", reject)
            })
        })

        // socket.end() was called before connected
        if (!this.socket.writable) return

        this.socket.on("end", () => {
            this.socket = null
            this.sendQueue.pause()
            this.authenticated = false
        })

        this.socket
            .pipe(createSplitter())
            .on("data", this.handlePacket.bind(this))

        const id = this.requestId
        const packet = await this.sendPacket(PacketType.Auth, this.config.password)

        this.sendQueue.resume()

        if (packet.id != id || packet.id == -1) {
            this.sendQueue.pause()
            this.socket.destroy()
            this.socket = null
            throw new Error("Authentication failed")
        }

        this.authenticated = true

        return this
    }

    /**
      Close the connection to the server.
    */
    async end() {
        if (!this.socket) return
        this.sendQueue.pause()
        this.socket.end()
        this.authenticated = false

        return new Promise(resolve => this.socket!.once("end", resolve))
    }

    /**
      Send a command to the server.

      @param command The command that will be executed on the server.
      @returns A promise that will be resolved with the command's response from the server.
    */
    async send(command: string) {
        const packet = await this.sendPacket(PacketType.Command, command)
        return packet.payload
    }

    private async sendPacket(type: PacketType, payload: string) {
        const id = this.requestId++

        const createSendPromise = () => {
            this.socket!.write(encodePacket({ id, type, payload }))

            return new Promise<Packet>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error(`Timeout for packet id ${id}`))
                }, this.config.timeout)

                this.callbacks.set(id, packet => {
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
