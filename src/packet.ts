export interface Packet {
    id: number
    type: number
    payload: string
}

export function encodePacket(id: number, type: number, payload: string): Buffer {
    const payloadSize = Buffer.byteLength(payload)
    const buffer = Buffer.alloc(payloadSize + 14)

    buffer.writeInt32LE(payloadSize + 10, 0)
    buffer.writeInt32LE(id, 4)
    buffer.writeInt32LE(type, 8)
    buffer.write(payload, 12)
    buffer.fill(0, payloadSize + 12)

    return buffer
}

export function decodePacket(buffer: Buffer): Packet {
    const length = buffer.readInt32LE(0)
    const id = buffer.readInt32LE(4)
    const type = buffer.readInt32LE(8)
    const payload = buffer.toString("utf-8", 12, length + 2)

    return {
        id, type, payload
    }
}

export enum PacketType {
    Auth = 3,
    AuthResponse = 2,
    Command = 2,
    CommandResponse = 0
}
