# API Reference

## Rcon

#### constructor

`new Rcon(options?: object)`

**Parameters**

- **options**?: _object_ (optional)
  - **packetResponseTimeout**?: number (optional)
    Timeout of the command responses in milliseconds. Defaults to `500`.
  - **resendPacketOnTimeout**?: number (optional)
    Should the packet resend if the server hasn't responded.

### Methods

#### connect

`connect(options?: object): Promise<void>`

Connect and authenticate with the server.

**Parameters**

- **options**: _object_
  - **host**: _string_
  - **password**: _string_
  - **port**: _number_

**Returns** _Promise&lt;void&gt;_
A promise that will be resolved when the client is authenticated with the server.

---

#### send

`send(command: string): Promise<string>`

Send a command to the server.

**Parameters**

- **command**: _string_

**Returns** _Promise&lt;string&gt;_
A promise that will be resolved with the command's response from the server.

---

#### disconnect

`disconnect(): Promise<void>`

Close the connection to the server.

**Returns** _Promise&lt;any&gt;_

---

#### end

Alias for `.disconnect()`

---

#### onDidAuthenticate

`onDidAuthenticate(callback: function): Disposable`

Call your callback function when the client has authenticated with the server.

**Parameters**

- **callback**: _`() => any`_

**Returns** _Disposable_

---

#### onDidConnect

`onDidConnect(callback: function): Disposable`

Call your callback function when the client has connected to the server.

**Parameters**

- **callback**: _`() => any`_

**Returns** _Disposable_

---

#### onDidDisconnect

`onDidDisconnect(callback: function): Disposable`

Call your callback function when the client was disconnected with the server.

**Parameters**

- **callback**: _`() => any`_

**Returns** _Disposable_

- `socket: Socket` A net.Socket instance. Only exist when connected.
- `connected: boolean` If the socket is connected.
- `authenticated: boolean` If the server is connected and has sent
  back a positive authentication packet. -->
