import {Emitter, Disposable} from "event-kit"
import {Socket, createConnection} from "net"

import {Packet} from "./packet"
export {Packet}

export type RconSendCallback = (response: string) => any

export interface RconOptions {
  timeout?: number
}

export class Rcon {
  emitter = new Emitter
  options: RconOptions
  connectOptions: RconConnectOptions

  requestId: number
  socket: Socket
  connecting: boolean
  authenticated: boolean

  get connected() {
    return this.socket != null && this.socket.writable
  }

  private resolveConnectPromise: () => any
  private rejectConnectPromise: (err: Error) => any

  private callbackQueue: {[index: number]: RconSendCallback}
  private sendQueue: Buffer[]
  private processingSendQueue: boolean

  constructor(options: RconOptions = {}) {
    this.options = {
      timeout: options.timeout || 500
    }
    this.reset()
  }

  public reset() {
    this.requestId = 0
    this.authenticated = false
    this.connecting = false

    this.callbackQueue = {}
    this.sendQueue = []
    this.processingSendQueue = false

    this.socket = null
  }

  /*
    Section: Event Subscription
  */

  public onDidConnect(callback: () => any) {
    return this.emitter.on("did-connect", callback)
  }

  public onDidAuthentificate(callback: () => any) {
    return this.emitter.on("did-authenticate", callback)
  }

  public onDidDisconnect(callback: () => any) {
    return this.emitter.on("did-disconnect", callback)
  }

  public onError(callback: (error: Error) => any) {
    return this.emitter.on("error", callback)
  }

  /*
    Section: General public methods
  */

  public connect(options: RconConnectOptions): Promise<any> {
    if (this.connected && this.authenticated) return Promise.resolve()

    options = this.connectOptions = {
      host: options.host || "localhost",
      port: options.port || 25575,
      password: options.password
    }

    let onConnected = () => {
      this.connecting = false
      this.emitter.emit("did-connect", null)

      if (!this.socket) return

      let authPacket = Packet.encode({
        id: 0,
        body: options.password,
        type: Packet.TYPE_SERVERDATA_AUTH
      })

      this.socket.write(authPacket)
    }

    this.socket = createConnection({
      host: options.host,
      port: options.port
    }, onConnected)

    this.connecting = true
    this.subscribeToSocketEvents()

    return new Promise((resolve, reject) => {
      let onError = this.onError(error => {
        reject(error)
        clear()
      })
      let timeout = setTimeout(() => {
        let error = new Error("Timeout")
        error.name = "TimeoutError"
        reject(error)
      }, 2000)
      let clear = () => {
        clearTimeout(timeout)
        onError.dispose()
      }
      this.resolveConnectPromise = () => {clear(); resolve()}
      this.rejectConnectPromise = (error) => {clear(); reject(error)}
    })
  }

  public disconnect() {
    let end = () => {
      this.socket.end()
      this.authenticated = false
      this.socket = null
      this.emitter.emit("did-disconnect", null)
    }

    if (this.connecting) {
      let didConnect = this.onDidConnect(() => {
        end()
        didConnect.dispose()
      })
    }
    else end()
  }

  // alias for ::disconnect
  public end() {
    this.disconnect()
  }

  public send(command: string, callback?: RconSendCallback) {
    let id = this.requestId++

    let packet = Packet.encode({
      id: id,
      type: Packet.TYPE_SERVERDATA_EXECCOMMAND,
      body: command
    })

    this.sendQueue.push(packet)
    this.processSendQueue()

    this.addCallbackHandler(id, callback)
  }

  /*
    Section: Private methods
  */

  private subscribeToSocketEvents() {
    this.socket.on("end", () => {
      this.authenticated = false
      this.connecting = false
      this.emitter.emit("disconnected", null)
    })

    this.socket.on("error", error => {
      this.emitter.emit("error", error)
      if (this.connecting) {
        this.connecting = false
      }
      setTimeout(() => this.disconnect())
    })

    this.socket.on("data", data => {
      let packets = Packet.decode(data)
      packets.forEach((packet) => this.processPacket(packet))
    })
  }

  /*
    Section: Private Queue Methods
  */

  private processSendQueue() {
    if (!this.authenticated || this.processingSendQueue || this.sendQueue.length == 0)
    return

    let stopQueueProcessing = () => {
      clearInterval(interval)
    }

    let i = 0
    let interval = setInterval(() => {
      if (!this.connected || !this.authenticated) return stopQueueProcessing()

      const buffer = this.sendQueue.shift()
      if (!buffer) return stopQueueProcessing()

      this.socket.write(buffer)
      i++
    }, 0)
  }

  private processPacket(packet: Packet) {
    if (packet.type == Packet.TYPE_SERVERDATA_AUTH_RESPONSE) {
      if (packet.id == -1) {
        let authError = new Error(`Wrong password for ${this.connectOptions.host}:${this.connectOptions.port}`)
        authError.name = "AuthError"
        if (this.rejectConnectPromise) this.rejectConnectPromise(authError)
        this.rejectConnectPromise = null
        this.resolveConnectPromise = null
        this.emitter.emit("error", authError)
        this.end()
      } else {
        this.authenticated = true
        if (this.resolveConnectPromise) this.resolveConnectPromise()
        this.rejectConnectPromise = null
        this.resolveConnectPromise = null
        this.emitter.emit("did-authenticate", null)
        this.processSendQueue()
      }
    } else {
      this.processCallbackQueue(packet)
    }
  }

  private addCallbackHandler(id: number, callback?: RconSendCallback) {
    this.callbackQueue[id] = callback || null

    let setResponseTimeout = () => {
      setTimeout(() => {
        if (this.callbackQueue[id] === undefined) return
        this.emitter.emit("error", (() => {
          let error = new Error("Timeout for response for packet id " + id)
          error.name = "TimeoutError"
          return error
        })())
      }, this.options.timeout)
    }

    if (this.authenticated) {
      setResponseTimeout()
    } else {
      let e = this.onDidAuthentificate(() => {
        setResponseTimeout()
        e.dispose()
      })
    }
  }

  private processCallbackQueue(packet: Packet) {
    let handler = this.callbackQueue[packet.id]

    if (handler instanceof Function)
    handler(packet.body)

    if (handler !== undefined)
    delete this.callbackQueue[packet.id]
  }
}

export interface RconConnectOptions {
  host?: string
  port?: number
  password: string
}
