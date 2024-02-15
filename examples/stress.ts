import { randomBytes } from "crypto";
import { RconClient } from "../src";

async function main() {
  const client = await RconClient.connect({
    port: 25575,
    password: "1234",
  });

  await client.cmd("data remove storage foo bar");

  for (let i = 0; i < 20; i++) {
    const text = randomBytes(Math.floor(1000 * Math.random()))
      .toString("base64");

    await client.cmd(
      `data modify storage foo bar append value ${JSON.stringify(text)}`,
    );

    const res = await client.cmd("data get storage foo bar");
    console.log(res.length);
  }

  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
