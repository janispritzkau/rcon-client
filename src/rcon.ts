import { Socket, createConnection } from "net"
import { Emitter, Disposable } from "event-kit"

import { decodePacket, encodePacket, PacketType, IPacket } from "./packet"
import { createSplitter } from "./splitter"
import { PromiseQueue } from "./utils/queue"

export class Rcon {
    private options = {
        packetResponseTimeout: 1000
    }
    private emitter = new Emitter()
    private sendPacketQueue: PromiseQueue
    private socket: Socket

    private requestId = 0
    /** @hidden */
    connecting: boolean
    /** @hidden */
    authenticated: boolean

    /**
      @param options.packetResponseTimeout Timeout of the command responses in milliseconds.
      Defaults to `500`.
    */
    constructor(options?: { packetResponseTimeout?: number }) {
        // overwrite defaults if options provided
        if (options) this.options = Object.assign(this.options, options)

        this.sendPacketQueue = new PromiseQueue({ maxConcurrent: 1 })
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

    /*
      Section: Event Subscription
    */

    /**
      Call your callback function when the client has connected to the server.
    */
    onDidConnect(callback: () => any) {
        return this.emitter.on("did-connect", callback)
    }

    /**
      Call your callback function when the client has authenticated with the server.
    */
    onDidAuthenticate(callback: () => any) {
        return this.emitter.on("did-authenticate", callback)
    }

    /**
      Call your callback function when the client was disconnected with the server.
    */
    onDidDisconnect(callback: () => any) {
        return this.emitter.on("did-disconnect", callback)
    }

    /*
      Section: Public methods
    */

    /**
      Connect and authenticate with the server.

      @returns A promise that will be resolved after the client is authenticated
      with the server.
    */
    async connect(options: { host: string, port: number, password: string }) {
        if (this.authenticated) return Promise.resolve()

        const { host, port, password } = options

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

        this.sendPacketQueue.resume()

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
        this.sendPacketQueue.pause()

        await new Promise<void>((resolve, reject) => {
            const listener = this.onDidDisconnect(() => {
                resolve()
                listener.dispose()
            })
        })
    }

    /** Alias for [[Rcon.disconnect]] */
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

    /*
      Section: Private methods for handling with packets
    */

    /**
      Send a raw packet to the server and handle the response packet. If there is no
      connection at the moment it'll wait until the server is authenticated the next time.

      We need to queue the packets before they're sent because the minecraft server can't
      handle 4 or more simultaneously sent rcon packets.
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

        const addPacketToQueue = () => this.sendPacketQueue.add(() => {
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
            this.sendPacketQueue.pause()
            this.socket = null
            this.emitter.emit("did-disconnect", null)
        })

        this.socket.on("error", error => {
            throw error
        })

        this.socket
            // Split incoming data into packets
            .pipe(createSplitter())
            .on("data", (data: Buffer) => {
                this.emitter.emit("packet", decodePacket(data))
            })
    }
}
