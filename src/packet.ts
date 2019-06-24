export interface IPacket {
    id: number
    type: number
    payload: string
}

export function encodePacket(packet: IPacket): Buffer {
    const payloadSize = Buffer.byteLength(packet.payload, "ascii")
    const packetSize = payloadSize + 10

    const buffer = Buffer.allocUnsafe(packetSize + 4)

    buffer.writeInt32LE(packetSize, 0)
    buffer.writeInt32LE(packet.id, 4)
    buffer.writeInt32LE(packet.type, 8)
    buffer.write(packet.payload, 12, packetSize + 2, "ascii")
    buffer.fill(0x00, payloadSize + 12)

    return buffer
}

export function decodePacket(buffer: Buffer, offset = 0): IPacket {
    const length = buffer.readInt32LE(offset)
    const id = buffer.readInt32LE(offset + 4)
    const type = buffer.readInt32LE(offset + 8)
    const payload = buffer.toString("ascii", offset + 12, length + 2)

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
