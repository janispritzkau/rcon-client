import { RconClient } from "../src";

async function main() {
  const client = await RconClient.connect({
    port: 25575,
    password: "1234",
  });

  const list = await client.cmd("list");
  console.log(list);

  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
