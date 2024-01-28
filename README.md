# `rcon-client`

A simple and easy to use RCON client made to work with Minecraft servers.

## Usage

```ts

const client = await RconClient.connect({
  port: 25575,
  password: "1234",
});

const list = await client.cmd("list");
console.log(list);

await client.close();
```
