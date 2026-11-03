export type RconErrorCode =
  /** The client was ended, or `end()` was called before the command could run. */
  | "CLOSED"
  /** The server rejected the password. Permanent: the client does not retry it. */
  | "AUTH_FAILED"
  /** No connection could be made and the client is not allowed to retry. */
  | "CONNECTION_FAILED"
  /** The connection dropped after the command was sent, before the full reply arrived. */
  | "CONNECTION_LOST"
  /** The command did not finish within its timeout. Queue time counts. */
  | "TIMEOUT"
  /** The command's `AbortSignal` fired. */
  | "ABORTED"
  /** The command is longer than `maxCommandBytes` and was never sent. */
  | "COMMAND_TOO_LONG"
  /** The server sent something that is not a valid RCON packet. */
  | "PROTOCOL";

export class RconError extends Error {
  override name = "RconError";
  readonly code: RconErrorCode;
  /**
   * `true` if the command reached the socket, so it may have run on the server.
   * `false` means it definitely did not run and retrying is safe.
   */
  readonly sent: boolean;

  constructor(code: RconErrorCode, message: string, sent = false, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.code = code;
    this.sent = sent;
  }
}
