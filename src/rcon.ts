import { EventEmitter } from "node:events";
import { Connection, type ConnectionOptions } from "./connection.ts";
import { RconError } from "./error.ts";

export interface RconOptions {
  /** @default "localhost" */
  host?: string;
  /** @default 25575 */
  port?: number;
  password: string;
  /**
   * Default time a command may take, including time spent waiting in the
   * queue and for a reconnect. `0` disables it.
   * @default 30_000
   */
  timeout?: number;
  /**
   * Time allowed for one TCP connect plus authentication.
   * @default 10_000
   */
  connectTimeout?: number;
  /**
   * Reconnect with backoff after a failed connect or a dropped connection,
   * while commands are waiting. With `false`, a failed connect rejects every
   * queued command with `CONNECTION_FAILED`.
   * @default true
   */
  reconnect?: boolean;
  /**
   * When idle for this many milliseconds, send a ping. If no reply arrives in
   * the same time, the connection is dropped and rebuilt. With a heartbeat,
   * the client also reconnects after a drop without waiting for a command.
   * `0` disables it.
   * @default 0
   */
  heartbeat?: number;
  /**
   * Longest command, in UTF-8 bytes. Minecraft closes the connection on
   * anything longer than 1446 bytes. Longer commands reject with
   * `COMMAND_TOO_LONG` before they are sent.
   * @default 1446
   */
  maxCommandBytes?: number;
}

export interface SendOptions {
  /** Cancels the command. A command that was already sent may still run. */
  signal?: AbortSignal;
  /** Overrides the client's `timeout` for this command. `0` disables it. */
  timeout?: number;
}

export interface ReconnectInfo {
  /** Starts at 1 and resets after a successful connect. */
  attempt: number;
  /** Milliseconds until the next attempt. */
  delay: number;
  /** Why the last attempt failed. */
  error: Error;
}

export interface RconEvents {
  /** Connected and authenticated. */
  connect: [];
  /** An established connection closed. `error` is unset for a clean close. */
  disconnect: [error: Error | undefined];
  /** A connect attempt failed and another one is scheduled. */
  reconnecting: [info: ReconnectInfo];
  /** `end()` finished. */
  end: [];
}

type Kind = "exec" | "ping" | "beat";

interface Job {
  kind: Kind;
  command: string;
  sent: boolean;
  done: boolean;
  connection?: Connection;
  resolve(value: string | number): void;
  reject(error: RconError): void;
}

const DEFAULTS = {
  host: "localhost",
  port: 25575,
  timeout: 30_000,
  connectTimeout: 10_000,
  reconnect: true,
  heartbeat: 0,
  maxCommandBytes: 1446,
};

export class Rcon extends EventEmitter<RconEvents> {
  /**
   * Creates a client and connects right away. Rejects on the first failure,
   * so a wrong host or password shows up immediately. Good for scripts.
   */
  static async connect(options: RconOptions): Promise<Rcon> {
    const rcon = new Rcon(options);
    await rcon.connect();
    return rcon;
  }

  readonly #options: Required<RconOptions>;
  /** Pings and heartbeats run before queued commands. */
  #urgent: Job[] = [];
  #queue: Job[] = [];
  #head = 0;
  /** Unsettled jobs that a caller is waiting for (not heartbeats). */
  #pending = 0;
  #connection: Connection | undefined;
  #opening: Promise<Connection> | undefined;
  #running = false;
  #wake: (() => void) | undefined;
  #heartbeat: NodeJS.Timeout | undefined;
  /** A ref'd handle that keeps the process alive while a caller waits. */
  #hold: NodeJS.Timeout | undefined;
  #holders = 0;
  #ended: Promise<void> | undefined;
  /** Resolved when the last pending job settles. */
  #drained: (() => void)[] = [];

  /** Does no I/O. The first command connects, and drops recover by themselves. */
  constructor(options: RconOptions) {
    super();
    const defined = Object.fromEntries(
      Object.entries(options).filter(([, value]) => value !== undefined),
    );
    this.#options = { ...DEFAULTS, ...defined } as Required<RconOptions>;
  }

  /** `true` while an authenticated connection is open. */
  get connected(): boolean {
    return this.#connection?.alive ?? false;
  }

  /** Commands and pings that have not settled yet. */
  get pending(): number {
    return this.#pending;
  }

  /**
   * Connects now if not connected. Makes one attempt and rejects on failure,
   * without retrying.
   */
  async connect(): Promise<void> {
    if (this.#ended) throw new RconError("CLOSED", "Client is closed");
    if (this.connected) return;
    this.#retain();
    try {
      await this.#open();
    } catch (error) {
      throw toRconError(error);
    } finally {
      this.#release();
    }
  }

  /**
   * Runs a command and resolves with its output. Commands run one at a time,
   * in the order they were sent, so `Promise.all` is safe.
   *
   * A command that was sent is never sent again. If the connection drops
   * before its reply, it rejects with `sent: true`.
   */
  send(command: string, options?: SendOptions): Promise<string> {
    const bytes = Buffer.byteLength(command);
    if (bytes > this.#options.maxCommandBytes) {
      return Promise.reject(new RconError(
        "COMMAND_TOO_LONG",
        `Command is ${bytes} bytes, the limit is ${this.#options.maxCommandBytes}`,
      ));
    }
    return this.#enqueue("exec", command, options) as Promise<string>;
  }

  /**
   * Sends commands in order and yields their outputs in the same order. The
   * iterable is read only as commands complete, so a large or endless source
   * stays cheap. The first failure is thrown from the loop; commands already
   * queued at that point still run.
   */
  async *sendAll(
    commands: Iterable<string> | AsyncIterable<string>,
    options?: SendOptions,
  ): AsyncGenerator<string, void, undefined> {
    const window: Promise<string>[] = [];
    const queue = (command: string) => {
      const promise = this.send(command, options);
      // Rejections are thrown when the loop reaches them, not reported early.
      promise.catch(() => {});
      window.push(promise);
    };
    for await (const command of commands) {
      queue(command);
      if (window.length >= 16) yield await window.shift()!;
    }
    while (window.length) yield await window.shift()!;
  }

  /**
   * Round trip in milliseconds. It runs before queued commands, but after
   * the command in flight. On Minecraft the RCON thread answers it, so it
   * succeeds even while the main thread is busy.
   */
  ping(options?: SendOptions): Promise<number> {
    return this.#enqueue("ping", "", options) as Promise<number>;
  }

  /** Waits for queued commands to settle, then closes the connection. */
  end(): Promise<void> {
    this.#ended ??= (async () => {
      this.#stopHeartbeat();
      for (const job of this.#urgent) if (job.kind === "beat") this.#settle(job);
      while (this.#pending) await new Promise<void>((resolve) => this.#drained.push(resolve));
      this.#connection?.destroy();
      this.#connection = undefined;
      this.emit("end");
    })();
    return this.#ended;
  }

  /** Lets `await using rcon = ...` call `end()`. */
  [Symbol.asyncDispose](): Promise<void> {
    return this.end();
  }

  #enqueue(kind: Kind, command: string, options: SendOptions = {}): Promise<string | number> {
    if (this.#ended) return Promise.reject(new RconError("CLOSED", "Client is closed"));
    const { signal, timeout = this.#options.timeout } = options;
    const { promise, resolve, reject } = Promise.withResolvers<string | number>();

    if (signal?.aborted) {
      reject(new RconError("ABORTED", "Aborted", false, signal.reason));
      return promise;
    }

    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => this.#fail(job, new RconError("ABORTED", "Aborted", job.sent, signal!.reason));
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const job: Job = {
      kind,
      command,
      sent: false,
      done: false,
      resolve: (value) => {
        if (this.#settle(job)) cleanup(), resolve(value);
      },
      reject: (error) => {
        if (this.#settle(job)) cleanup(), reject(error);
      },
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (timeout > 0 && Number.isFinite(timeout)) {
      timer = setTimeout(
        () => this.#fail(job, new RconError("TIMEOUT", `No reply within ${timeout}ms`, job.sent)),
        timeout,
      );
    }

    if (kind === "beat") {
      // Heartbeats never keep the process alive.
      timer?.unref();
      this.#urgent.push(job);
    } else {
      this.#pending++;
      this.#retain();
      (kind === "ping" ? this.#urgent : this.#queue).push(job);
    }
    this.#stopHeartbeat();
    void this.#run();
    return promise;
  }

  /** Rejects a job. If it was in flight, its late reply would block the queue, so drop the socket. */
  #fail(job: Job, error: RconError): void {
    if (job.done) return;
    job.reject(error);
    if (job.sent) job.connection?.destroy(error);
  }

  /** Marks a job done. Returns `false` if it already was. */
  #settle(job: Job): boolean {
    if (job.done) return false;
    job.done = true;
    if (job.kind === "beat") return true;
    this.#release();
    if (--this.#pending === 0) {
      this.#wake?.();
      for (const resolve of this.#drained.splice(0)) resolve();
    }
    return true;
  }

  /** Sockets and timers are unref'd; this keeps the process alive while a caller waits. */
  #retain(): void {
    if (this.#holders++ === 0) this.#hold = setInterval(() => {}, 1 << 30);
  }

  #release(): void {
    if (--this.#holders === 0) {
      clearInterval(this.#hold);
      this.#hold = undefined;
    }
  }

  #hasWork(): boolean {
    return this.#pending > 0 || this.#urgent.some((job) => !job.done);
  }

  #take(): Job | undefined {
    while (this.#urgent.length) {
      const job = this.#urgent.shift()!;
      if (!job.done) return job;
    }
    while (this.#head < this.#queue.length) {
      const job = this.#queue[this.#head++]!;
      if (this.#head > 1024 && this.#head * 2 > this.#queue.length) {
        this.#queue = this.#queue.slice(this.#head);
        this.#head = 0;
      }
      if (!job.done) return job;
    }
    return undefined;
  }

  async #run(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      while (this.#hasWork()) {
        const connection = await this.#ready();
        if (!connection) continue;
        const job = this.#take();
        if (!job) break;
        job.sent = true;
        job.connection = connection;
        try {
          const result = job.kind === "exec"
            ? await connection.exec(job.command)
            : await connection.ping();
          job.resolve(result);
        } catch (error) {
          job.reject(error instanceof RconError && error.code === "PROTOCOL"
            ? new RconError("PROTOCOL", error.message, true)
            : new RconError("CONNECTION_LOST", "Connection lost before the reply", true, error));
        }
      }
    } finally {
      this.#running = false;
      this.#scheduleHeartbeat();
    }
  }

  /**
   * Returns a live connection, reconnecting with backoff as needed. Returns
   * `undefined` once there is nothing left to wait for, after rejecting the
   * queue on a permanent failure.
   */
  async #ready(): Promise<Connection | undefined> {
    for (let attempt = 0; ;) {
      if (this.#connection?.alive) return this.#connection;
      if (!this.#hasWork()) return undefined;
      try {
        return await this.#open();
      } catch (error) {
        const failure = toRconError(error);
        if (failure.code === "AUTH_FAILED" || !this.#options.reconnect) {
          this.#rejectAll(failure);
          return undefined;
        }
        const delay = Math.round(Math.min(250 * 2 ** attempt, 10_000) * (0.75 + Math.random() / 2));
        this.emit("reconnecting", { attempt: ++attempt, delay, error: error as Error });
        await this.#sleep(delay);
      }
    }
  }

  #open(): Promise<Connection> {
    let connection: Connection | undefined;
    this.#opening ??= Connection.open(this.#connectionOptions(), (error) => {
      if (this.#connection === connection) this.#connection = undefined;
      this.emit("disconnect", error);
      this.#stopHeartbeat();
      if (this.#options.heartbeat > 0 && !this.#ended) {
        // Rebuild the connection in the background.
        this.#enqueue("beat", "", { timeout: 0 }).catch(() => {});
      }
    }).then((opened) => {
      connection = opened;
      this.#connection = opened;
      this.emit("connect");
      this.#scheduleHeartbeat();
      return opened;
    }).finally(() => {
      this.#opening = undefined;
    });
    return this.#opening;
  }

  #connectionOptions(): ConnectionOptions {
    const { host, port, password, connectTimeout } = this.#options;
    return { host, port, password, connectTimeout };
  }

  #rejectAll(error: RconError): void {
    for (const job of [...this.#urgent, ...this.#queue.slice(this.#head)]) {
      if (!job.done) job.reject(error);
    }
    this.#urgent = [];
    this.#queue = [];
    this.#head = 0;
  }

  /** Sleeps, but wakes early once no caller is waiting any more. */
  #sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.#wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref();
      this.#wake = done;
    });
  }

  #scheduleHeartbeat(): void {
    const { heartbeat } = this.#options;
    if (!heartbeat || this.#ended || this.#running || !this.connected || this.#heartbeat) return;
    this.#heartbeat = setTimeout(() => {
      this.#heartbeat = undefined;
      this.#enqueue("beat", "", { timeout: heartbeat }).catch(() => {});
    }, heartbeat);
    this.#heartbeat.unref();
  }

  #stopHeartbeat(): void {
    clearTimeout(this.#heartbeat);
    this.#heartbeat = undefined;
  }
}

function toRconError(error: unknown): RconError {
  if (error instanceof RconError) return error;
  return new RconError("CONNECTION_FAILED", `Could not connect: ${(error as Error).message}`, false, error);
}
