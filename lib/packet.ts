
export class Packet {
  static TYPE_SERVERDATA_AUTH = 0x03
  static TYPE_SERVERDATA_AUTH_RESPONSE = 0x02
  static TYPE_SERVERDATA_EXECCOMMAND = 0x02
  static TYPE_SERVERDATA_RESPONSE_VALUE = 0x00

  static encode(packet: Packet): Buffer {
    const {id, type, body} = packet
    const size = Buffer.byteLength(body) + 14
    const buffer = new Buffer(size)

    buffer.writeInt32LE(size - 4, 0)
    buffer.writeInt32LE(id, 4)
    buffer.writeInt32LE(type, 8)
    buffer.write(body + "\x00\x00", 12, size - 2, "ascii")
    return buffer
  }

  static decode(buffer: Buffer): Packet[] {
    let responsePackets: Packet[] = []

    let size: number
    let offset = 0

    while (true) {
      if (buffer[offset] == undefined) break
      size = buffer.readInt32LE(offset + 0)
      let id = buffer.readInt32LE(offset + 4)
      let type = buffer.readInt32LE(offset + 8)
      let body = buffer.toString("ascii", offset + 12, size + 2)
      responsePackets.push({id, type, body})
      offset += 4 + size
    }

    return responsePackets
  }

  id: number
  type: number
  body: string
}
