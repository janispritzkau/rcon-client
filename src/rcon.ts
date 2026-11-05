import { EventEmitter } from "node:events";
import { Connection, type ConnectionOptions } from "./connection.ts";
import { isDelay } from "./delay.ts";
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
   * Time allowed for one TCP connect plus authentication. `0` disables it.
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
   * Longest command, in UTF-8 bytes. Longer commands reject with
   * `COMMAND_TOO_LONG` before they are sent. Minecraft closes the connection
   * on anything over 1446 bytes. Source servers allow 1014 by default and ban
   * the address after oversized packets, so when this option is not set and
   * the server turns out to be a Source server, the limit drops to 1014.
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

type Kind = "exec" | "ping";

interface Job {
  kind: Kind;
  /** Heartbeats: no caller waits, so they never keep the process alive or delay `end()`. */
  background: boolean;
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

/** Source's default `sv_rcon_maxpacketsize` of 1024, minus the 10-byte header. */
const SOURCE_MAX_COMMAND_BYTES = 1014;

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
  /** `false` if the caller set `maxCommandBytes`, so it must not be lowered for Source. */
  readonly #autoLimit: boolean;
  /** Pings and heartbeats run before queued commands. */
  #urgent: Job[] = [];
  #queue: Job[] = [];
  #head = 0;
  /** Unsettled jobs that a caller is waiting for (not heartbeats). */
  #pending = 0;
  #connection: Connection | undefined;
  #opening: Promise<Connection> | undefined;
  /** Cancels `#opening` when `end()` no longer needs it. */
  #openAbort: AbortController | undefined;
  /** Jobs settled since the queues were last cleaned up. */
  #settledSinceCompact = 0;
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
    this.#autoLimit = options.maxCommandBytes === undefined;
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
    if (command === "") {
      return Promise.reject(new RconError("EMPTY_COMMAND", "Command is empty"));
    }
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
   * Sends commands in order and yields their outputs in the same order, each
   * as soon as it arrives. At most 16 commands are queued ahead, so a large or
   * endless source stays cheap. The first failure is thrown from the loop;
   * commands already queued at that point still run.
   * If the loop ends early while a read from `commands` is in progress,
   * `commands` is closed once that read finishes, without waiting for it.
   */
  async *sendAll(
    commands: Iterable<string> | AsyncIterable<string>,
    options?: SendOptions,
  ): AsyncGenerator<string, void, undefined> {
    const iterator: Iterator<string> | AsyncIterator<string> = Symbol.asyncIterator in commands
      ? commands[Symbol.asyncIterator]()
      : commands[Symbol.iterator]();
    const window: Promise<string>[] = [];
    let pull: Promise<IteratorResult<string>> | undefined;
    let exhausted = false;
    try {
      for (;;) {
        if (!exhausted && !pull && window.length < 16) pull = Promise.resolve(iterator.next());
        const head = window[0];
        // Wait for whichever comes first: the oldest reply or the next command.
        const next = head && pull
          ? await Promise.race([head.then(() => "reply", () => "reply"), pull.then(() => "source")])
          : head ? "reply" : pull ? "source" : "done";
        if (next === "done") return;
        if (next === "reply") {
          window.shift();
          yield await head!;
          continue;
        }
        const result = await pull!;
        pull = undefined;
        if (result.done) {
          exhausted = true;
          continue;
        }
        const promise = this.send(result.value, options);
        // Rejections are thrown when the loop reaches them, not reported early.
        promise.catch(() => {});
        window.push(promise);
      }
    } finally {
      if (!exhausted) {
        if (pull) {
          // An async generator queues return() behind the read in progress,
          // which may never finish, so close it without waiting.
          pull.then(() => iterator.return?.(), () => {}).catch(() => {});
        } else {
          await iterator.return?.();
        }
      }
    }
  }

  /**
   * Round trip in milliseconds. It runs before queued commands, but after
   * the command in flight. On Minecraft the RCON thread answers it, so it
   * succeeds even while the main thread is busy.
   */
  ping(options?: SendOptions): Promise<number> {
    return this.#enqueue("ping", "", options) as Promise<number>;
  }

  /**
   * Waits for queued commands to settle, then closes the connection. If the
   * server is unreachable, makes one more attempt and then rejects the rest.
   */
  end(): Promise<void> {
    this.#ended ??= (async () => {
      this.#stopHeartbeat();
      const closed = new RconError("CLOSED", "Client is closed");
      for (const job of this.#urgent) if (job.background) job.reject(closed);
      // Skip the rest of a reconnect backoff: one more attempt, then give up.
      this.#wake?.();
      while (this.#pending) await new Promise<void>((resolve) => this.#drained.push(resolve));
      // Nothing waits for a connection any more, so give up an attempt that
      // is still running (for example a background reconnect).
      this.#openAbort?.abort();
      await this.#opening?.catch(() => {});
      this.#queue = [];
      this.#head = 0;
      this.#urgent = [];
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

  #enqueue(kind: Kind, command: string, options: SendOptions = {}, background = false): Promise<string | number> {
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
      background,
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
    if (isDelay(timeout)) {
      timer = setTimeout(
        () => this.#fail(job, new RconError("TIMEOUT", `No reply within ${timeout}ms`, job.sent)),
        timeout,
      );
    }

    if (background) {
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
    // Settled jobs stay queued until the worker reaches them, which may not
    // happen during a long outage, so clean up every so often.
    if (++this.#settledSinceCompact >= 1024) this.#compact();
    if (job.background) return true;
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

  #compact(): void {
    this.#queue = this.#queue.slice(this.#head).filter((job) => !job.done);
    this.#head = 0;
    this.#urgent = this.#urgent.filter((job) => !job.done);
    this.#settledSinceCompact = 0;
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
        if (job.kind === "exec" && this.#autoLimit && connection.source) {
          const bytes = Buffer.byteLength(job.command);
          if (bytes > SOURCE_MAX_COMMAND_BYTES) {
            job.reject(new RconError(
              "COMMAND_TOO_LONG",
              `Command is ${bytes} bytes, the limit on Source servers is ${SOURCE_MAX_COMMAND_BYTES}`,
            ));
            continue;
          }
        }
        job.sent = true;
        job.connection = connection;
        // A heartbeat that rebuilds the connection has no deadline of its own,
        // because it waits through reconnects. Once it is sent, it gets the
        // heartbeat interval like every other heartbeat.
        const { heartbeat } = this.#options;
        const guard = job.background && isDelay(heartbeat)
          ? setTimeout(() => connection.destroy(new Error(`No reply to the heartbeat within ${heartbeat}ms`)), heartbeat)
          : undefined;
        guard?.unref();
        try {
          const result = job.kind === "exec"
            ? await connection.exec(job.command)
            : await connection.ping();
          job.resolve(result);
        } catch (error) {
          job.reject(error instanceof RconError && error.code === "PROTOCOL"
            ? new RconError("PROTOCOL", error.message, true)
            : new RconError("CONNECTION_LOST", "Connection lost before the reply", true, error));
        } finally {
          clearTimeout(guard);
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
        if (failure.code === "AUTH_FAILED" || !this.#options.reconnect || this.#ended) {
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
    if (this.#opening) return this.#opening;
    let connection: Connection | undefined;
    const abort = new AbortController();
    this.#openAbort = abort;
    this.#opening = Connection.open(this.#connectionOptions(), (error) => {
      if (!connection) return;
      if (this.#connection === connection) this.#connection = undefined;
      this.emit("disconnect", error);
      this.#stopHeartbeat();
      if (isDelay(this.#options.heartbeat) && !this.#ended) {
        // Rebuild the connection in the background.
        this.#enqueue("ping", "", { timeout: 0 }, true).catch(() => {});
      }
    }, abort.signal).then((opened) => {
      if (this.#ended && !this.#pending) {
        // end() was called while connecting and nothing needs this connection.
        opened.destroy();
        throw new RconError("CLOSED", "Client is closed");
      }
      connection = opened;
      this.#connection = opened;
      this.emit("connect");
      this.#scheduleHeartbeat();
      return opened;
    }).finally(() => {
      this.#opening = undefined;
      if (this.#openAbort === abort) this.#openAbort = undefined;
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
    if (!isDelay(heartbeat) || this.#ended || this.#running || !this.connected || this.#heartbeat) return;
    this.#heartbeat = setTimeout(() => {
      this.#heartbeat = undefined;
      this.#enqueue("ping", "", { timeout: heartbeat }, true).catch(() => {});
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
