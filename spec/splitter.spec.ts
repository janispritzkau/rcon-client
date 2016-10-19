import {Transform} from "stream"

import {encodePacket, decodePacket, IPacket} from "../lib/packet"
import {createSplitter} from "../lib/splitter"

describe("createSplitter", () => {
  const examplePackets: IPacket[] = [
    {id: 0, type: 3, payload: "test"},
    {id: 234, type: 1, payload: "foo"},
    {id: 9023, type: 2, payload: "bar"}
  ]

  const messagesBuffer = Buffer.concat(examplePackets.map(packet => encodePacket(packet)))

  let splitter: Transform

  beforeEach(() => {
    splitter = createSplitter()
  })

  it("splits multiple length prefixed messages in one chunk", done => {
    let messages = []

    splitter.on("data", message => {
      messages.push(message)
    })

    splitter.on("end", () => {
      let packets = messages.map(a => decodePacket(a))
      expect(packets).toEqual(examplePackets)
      done()
    })

    splitter.write(messagesBuffer)
    splitter.end()
  })

  it("reassembles splitted message chunks", done => {
    const exampleMessage = encodePacket(examplePackets[1])

    let onDataCalls = jasmine.createSpy("data")

    splitter.on("data", message => {
      expect(message).toEqual(exampleMessage)
      onDataCalls()
    })

    splitter.on("end", () => {
      expect(onDataCalls).toHaveBeenCalledTimes(1)
      done()
    })

    splitter.write(exampleMessage.slice(0, 2))
    splitter.write(exampleMessage.slice(2, 6))
    splitter.write(exampleMessage.slice(6))
    splitter.end()
  })
})
