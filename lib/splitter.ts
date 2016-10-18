import {Transform} from "stream"

/**
  Creates a transform stream which splits / combines the buffer chunks to single messages.
*/
export function createSplitter() {
  let transform = new Transform()

  let buffer = Buffer.alloc(0)
  let cursor = 0

  let packetLength: number

  transform._transform = (chunk, encoding, callback) => {
    const bufferChunk = <Buffer>chunk
    buffer = Buffer.concat([buffer.slice(cursor), chunk])
    cursor = 0

    function splitPacket(cursor: number) {
      if (cursor + 4 > buffer.length) return cursor
      if (packetLength == null) packetLength = buffer.readInt32LE(cursor)
      if (buffer.length < cursor + 4 + packetLength) return cursor
      cursor += 4

      transform.push(buffer.slice(cursor - 4, cursor + packetLength))

      cursor += packetLength
      packetLength = null

      return splitPacket(cursor)
    }

    cursor = splitPacket(cursor)
    callback()
  }

  return transform
}
