import {Socket, createConnection} from "net"
import {Emitter, Disposable} from "event-kit"

import {decodePacket, encodePacket, PacketType, IPacket} from "./packet"
import {createSplitter} from "./splitter"
import {PromiseQueue} from "./utils/queue"

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
  constructor(options?: {packetResponseTimeout?: number}) {
    if (options)
      this.options = Object.assign(this.options, options)

    this.sendPacketQueue = new PromiseQueue({maxConcurrent: 1})
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

    @returns A promise that will be resolved when the client is authenticated
    with the server.
  */
  connect(options: {host: string, port: number, password: string}) {
    if (this.authenticated) return Promise.resolve()

    const {host, port, password} = options

    const promise = new Promise<any>((resolve, reject) => {
      const onConnected = () => {
        this.emitter.emit("did-connect", null)
        this.socket.removeListener("error", connectErrorHandler)
        this.subscribeToSocketEvents()
        this.connecting = false

        this.sendPacketQueue.resume()

        const id = this.requestId
        this.sendPacket(PacketType.Auth, options.password, true)
        .then((packet) => {
          if (packet.id != id || packet.id == -1) return reject(new Error("Authentication failed: wrong password"))
          // auth success
          this.authenticated = true
          this.emitter.emit("did-authenticate", null)
          resolve()
        })
      }

      this.socket = createConnection({host, port}, onConnected)

      const connectErrorHandler = err => reject(err)
      this.socket.on("error", connectErrorHandler)

      this.connecting = true
    })

    return promise
  }

  /**
    Close the connection to the server.
  */
  disconnect() {
    // half close the socket
    this.socket.end()
    this.authenticated = false
    this.sendPacketQueue.pause()

    return new Promise<void>((resolve, reject) => {
      const listener = this.onDidDisconnect(() => {
        resolve()
        listener.dispose()
      })
    })
  }

  /** Alias for [[Rcon.disconnect]] */
  end() {
    return this.disconnect()
  }

  /**
    Send a command to the server.

    @param command The command that will be executed on the server.
    @returns A promise that will be resolved with the command's response from the server.
  */
  send(command: string) {
    return this.sendPacket(PacketType.Command, command)
    .then(packet => packet.payload)
  }

  /*
    Section: Private methods for handling with packets
  */

  /**
    Send a raw packet to the server and handle the response packet. If there is no
    connection at the moment it'll wait until the server is authenticated the next time.

    We have to queue the packets before they're sent because the minecraft server can't
    handle 4 or more simultaneously sent rcon packets.
  */
  private sendPacket(type: number, payload: string, isAuth = false) {
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

    const createQueuedPromise = () => this.sendPacketQueue.add(() => {
      this.socket.write(encodePacket({id, type, payload}))
      return createPacketResponsePromise()
    })

    if (isAuth || this.authenticated) {
      return createQueuedPromise()
    } else {
      return new Promise<IPacket>((resolve, reject) => {
        const listener = this.onDidAuthenticate(() => {
          resolve()
          listener.dispose()
        })
      })
      .then(createQueuedPromise)
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
