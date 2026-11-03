/**
 * Downloads a Minecraft server, starts it in the background with RCON on
 * port 25575 (password "ci-password") and exits once RCON accepts connections.
 *
 *   node scripts/minecraft-server.ts <vanilla|paper> <version|latest> <directory>
 */
import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [kind = "vanilla", version = "latest", directory = "server"] = process.argv.slice(2);

async function json(url: string): Promise<any> {
  const response = await fetch(url, { headers: { "user-agent": "rcon-client-ci" } });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
}

async function vanillaJar(version: string): Promise<string> {
  const manifest = await json("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json");
  const id = version === "latest" ? manifest.latest.release : version;
  const entry = manifest.versions.find((v: { id: string }) => v.id === id);
  if (!entry) throw new Error(`Unknown version ${id}`);
  return (await json(entry.url)).downloads.server.url;
}

async function paperJar(version: string): Promise<string> {
  let id = version;
  if (version === "latest") {
    const project = await json("https://fill.papermc.io/v3/projects/paper");
    id = Object.values(project.versions as Record<string, string[]>)[0]![0]!;
  }
  const build = await json(`https://fill.papermc.io/v3/projects/paper/versions/${id}/builds/latest`);
  return build.downloads["server:default"].url;
}

mkdirSync(directory, { recursive: true });
const url = kind === "paper" ? await paperJar(version) : await vanillaJar(version);
console.log(`Downloading ${url}`);
const jar = await fetch(url);
if (!jar.ok) throw new Error(`${url}: ${jar.status}`);
writeFileSync(join(directory, "server.jar"), Buffer.from(await jar.arrayBuffer()));
writeFileSync(join(directory, "eula.txt"), "eula=true\n");
writeFileSync(join(directory, "server.properties"), [
  "enable-rcon=true",
  "rcon.port=25575",
  "rcon.password=ci-password",
  "level-type=minecraft\\:flat",
  "generate-structures=false",
  "spawn-protection=0",
  "online-mode=false",
  "server-port=25565",
  "",
].join("\n"));

const logPath = join(directory, "server.log");
const log = openSync(logPath, "a");
const java = spawn("java", ["-Xmx2G", "-jar", "server.jar", "--nogui"], {
  cwd: directory,
  detached: true,
  stdio: ["ignore", log, log],
});
java.unref();
let exited = false;
java.on("exit", () => (exited = true));

const deadline = Date.now() + 5 * 60_000;
while (Date.now() < deadline) {
  if (exited) break;
  if (readFileSync(logPath, "utf8").includes("RCON running")) {
    console.log("RCON is up");
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
console.error(readFileSync(logPath, "utf8"));
throw new Error(exited ? "Server exited" : "Server did not start in time");
