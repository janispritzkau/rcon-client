import { RconClient } from "../src";

async function main() {
  const client = await RconClient.connect({
    port: 25575,
    password: "1234",
  });

  for (let i = 0; i < 1000; i++) {
    await client.cmd(
      `data modify storage foo bar append value ${
        JSON.stringify(Math.random().toString(36).slice(2))
      }`,
    );
    const response = await client.cmd("data get storage foo bar");
    console.log(response);
  }

  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
