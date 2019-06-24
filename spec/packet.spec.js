const { decodePacket, encodePacket } = require("../lib/packet")

describe("encodePacket", () => {
  it("creates a buffer from a packet", () => {
    const buffer = encodePacket({ id: 0xf, type: 0x3, payload: "payload" })
    expect(buffer instanceof Buffer).toBeTruthy()

    //                                  id      |    type   |  payload  |  padding
    const bufferB = Buffer.from("\x0f\x00\x00\x00\x03\x00\x00\x00payload\x00\x00")

    expect(buffer.slice(4)).toEqual(bufferB)
  })
})

describe("decodePacket", () => {
  it("reads a packet from a buffer and returns the packet", () => {
    const packet = { id: 235, type: 3, payload: "command" }

    expect(decodePacket(encodePacket(packet))).toEqual(packet)
  })
})
