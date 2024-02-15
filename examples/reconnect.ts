import { RconClient } from "../src";

async function main() {
  const client = new RconClient({
    port: 25575,
    password: "1234",
  });

  for (let i = 0; i < 5; i++) {
    await client.connect();
    await client.cmd(`say hello ${i}`);
    await client.close();
  }

  await client.connect();
  try {
    await client.cmd(`say too long: ${"a".repeat(2000)}`);
  } catch {}
  console.log("done");
  await client.cmd(`say closing...`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
