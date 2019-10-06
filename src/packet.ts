export interface Packet {
    id: number
    type: number
    payload: Buffer
}

export function encodePacket(packet: Packet): Buffer {
    const buffer = Buffer.alloc(packet.payload.length + 14)

    buffer.writeInt32LE(packet.payload.length + 10, 0)
    buffer.writeInt32LE(packet.id, 4)
    buffer.writeInt32LE(packet.type, 8)
    packet.payload.copy(buffer, 12)

    return buffer
}

export function decodePacket(buffer: Buffer): Packet {
    const length = buffer.readInt32LE(0)
    const id = buffer.readInt32LE(4)
    const type = buffer.readInt32LE(8)
    const payload = buffer.slice(12, length + 2)

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
