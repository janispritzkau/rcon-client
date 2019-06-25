import { Socket, createConnection } from "net"
import { Emitter } from "event-kit"

import { decodePacket, encodePacket, PacketType, IPacket } from "./packet"
import { createSplitter } from "./splitter"
import { PromiseQueue } from "./utils/queue"

export interface RconOptions {
    /** @default 2000 ms */
    packetResponseTimeout?: number,
    /** @default 1 */
    maxPending?: number
}

const defaultOptions: RconOptions = {
    packetResponseTimeout: 2000,
    maxPending: 2
}

export class Rcon {
    private emitter = new Emitter()
    private sendQueue: PromiseQueue
    private socket: Socket

    private requestId = 0
    connecting: boolean
    authenticated: boolean

    constructor(private options: RconOptions = {}) {
        this.options = { ...defaultOptions, ...options }
        this.sendQueue = new PromiseQueue(this.options.maxPending)
    }

    /**
      Create `Rcon` instance and call the `.connect()` function with options

      @returns A promise that will be resolved after the client is authenticated
      with the server.
    */
    static async connect(options: { host: string, port: number, password: string }): Promise<Rcon> {
        const rcon = new Rcon()
        await rcon.connect(options)
        return rcon
    }

    onError(callback: (error: any) => any) {
        return this.emitter.on("error", callback)
    }

    onDidConnect(callback: () => any) {
        return this.emitter.on("did-connect", callback)
    }

    onDidAuthenticate(callback: () => any) {
        return this.emitter.on("did-authenticate", callback)
    }

    onDidDisconnect(callback: () => any) {
        return this.emitter.on("did-disconnect", callback)
    }

    /**
      Connect and authenticate with the server.

      @returns A promise that will be resolved after the client is authenticated
      with the server.
    */
    async connect(options: { host: string, port: number, password: string }) {
        if (this.authenticated) return Promise.resolve()

        const { host, port } = options

        this.socket = await new Promise<Socket>((resolve, reject) => {
            const socket = createConnection({ host, port }, error => {
                if (error) reject(error)
                else resolve(socket)
                socket.removeListener("error", reject)
            })
            socket.on("error", reject)
            this.connecting = true
        })

        this.emitter.emit("did-connect")

        this.subscribeToSocketEvents()
        this.connecting = false

        this.sendQueue.resume()

        const id = this.requestId
        let packet = await this.sendPacket(PacketType.Auth, options.password, true)
        if (packet.id != id || packet.id == -1) throw new Error("Authentication failed: wrong password")

        this.authenticated = true
        this.emitter.emit("did-authenticate", null)
    }

    /**
      Close the connection to the server.
    */
    async disconnect() {
        if (!this.socket) return
        // half close the socket
        this.socket.end()
        this.authenticated = false
        this.sendQueue.pause()

        await new Promise<void>((resolve, reject) => {
            const listener = this.onDidDisconnect(() => {
                resolve()
                listener.dispose()
            })
        })
    }

    /** Alias for `.disconnect()` */
    async end() {
        await this.disconnect()
    }

    /**
      Send a command to the server.

      @param command The command that will be executed on the server.
      @returns A promise that will be resolved with the command's response from the server.
    */
    async send(command: string) {
        let packet = await this.sendPacket(PacketType.Command, command)

        return packet.payload
    }

    /**
      Send a raw packet to the server and handle the response packet. If there is no
      connection, wait until the server is authenticated.

      We need to queue the packets before they're sent because minecraft can't
      handle 4 or more packets at once.
    */
    private async sendPacket(type: number, payload: string, isAuth = false): Promise<IPacket> {
        const id = this.requestId++

        const createPacketResponsePromise = () => new Promise<IPacket>((resolve, reject) => {
            const timeout = setTimeout(() => {
                packetListener.dispose()
                reject(new Error(`Response timeout for packet id ${id}`))
            }, this.options.packetResponseTimeout)

            const packetListener = this.onPacket(packet => {
                if (!isAuth && packet.id == id || isAuth) {
                    clearTimeout(timeout)
                    packetListener.dispose()
                    resolve(packet)
                }
            })
        })

        const addPacketToQueue = () => this.sendQueue.add(() => {
            this.socket.write(encodePacket({ id, type, payload }))
            return createPacketResponsePromise()
        })

        if (isAuth || this.authenticated) {
            return addPacketToQueue()
        } else {
            // wait for authentication
            await new Promise<IPacket>((resolve, reject) => {
                const listener = this.onDidAuthenticate(() => {
                    resolve()
                    listener.dispose()
                })
            })
            return addPacketToQueue()
        }
    }

    private onPacket(callback: (packet: IPacket) => any) {
        return this.emitter.on("packet", (packet: IPacket) => {
            callback(packet)
        })
    }

    private subscribeToSocketEvents() {
        this.socket.on("close", () => {
            this.authenticated = false
            this.sendQueue.pause()
            this.socket = null
            this.emitter.emit("did-disconnect", null)
        })

        this.socket.on("error", error => {
            this.emitter.emit("error", error)
        })

        this.socket
            // Split incoming data into packets
            .pipe(createSplitter())
            .on("data", (data: Buffer) => {
                this.emitter.emit("packet", decodePacket(data))
            })
    }
}
