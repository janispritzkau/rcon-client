export const PacketType = {
  /** `SERVERDATA_RESPONSE_VALUE` */
  Response: 0,
  /** `SERVERDATA_EXECCOMMAND`, also `SERVERDATA_AUTH_RESPONSE` in replies */
  Command: 2,
  /** `SERVERDATA_AUTH` */
  Auth: 3,
} as const;

/** Header (id + type) plus the two terminating null bytes. */
const OVERHEAD = 10;
/** Upper bound for an incoming packet. Real servers stay far below this. */
const MAX_INCOMING = 1 << 24;

export interface Packet {
  id: number;
  type: number;
  body: Buffer;
}

export function encodePacket(id: number, type: number, body: string | Buffer): Buffer {
  const payload = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  const packet = Buffer.alloc(4 + OVERHEAD + payload.length);
  packet.writeInt32LE(OVERHEAD + payload.length, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  payload.copy(packet, 12);
  return packet;
}

/** Splits a TCP byte stream into packets. */
export class PacketReader {
  #buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): void {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
  }

  /**
   * Returns the next complete packet, or `undefined` if more data is needed.
   * Throws on a length field no RCON server would send.
   */
  read(): Packet | undefined {
    const buffer = this.#buffer;
    if (buffer.length < 4) return undefined;
    const length = buffer.readInt32LE(0);
    if (length < OVERHEAD || length > MAX_INCOMING) {
      throw new Error(`Invalid packet length ${length}`);
    }
    if (buffer.length < 4 + length) return undefined;
    const packet = {
      id: buffer.readInt32LE(4),
      type: buffer.readInt32LE(8),
      // Copy so a long-lived reply does not pin the whole receive buffer.
      body: Buffer.from(buffer.subarray(12, 4 + length - 2)),
    };
    this.#buffer = buffer.subarray(4 + length);
    return packet;
  }
}
