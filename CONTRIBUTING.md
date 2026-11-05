# Contributing

Bug reports and pull requests are welcome. For a larger change, open an issue first so we can agree on the approach.

The package has no runtime dependencies, and it should stay that way.

## Setup

You need Node.js 22.18 or later, the first 22.x that runs TypeScript without a flag. The package itself supports 22.12, but the tests and scripts run the `.ts` sources directly, so there is no build step during development.

```sh
npm ci
```

## Checks

CI runs all of these on Node 22, 24 and 26. Run them before you open a pull request:

```sh
npm run fmt:check     # formatting (Oxfmt); `npm run fmt` fixes it
npm run lint          # Oxlint, including type-aware rules such as no-floating-promises
npm run typecheck     # tsc
npm test              # unit tests
npm run build         # compiles src/ to dist/
npm run check:package # publint and attw against the packed tarball
```

The unit tests in `test/*.test.ts` use `node:test` and a fake RCON server in `test/fake-server.ts`. It can act like Minecraft, Factorio or a Source server, so most protocol behaviour can be tested without a real server. If you change how the client handles a server quirk, add a test against the fake server.

## Integration tests

`test/integration/` runs against real servers. Each file is skipped unless the environment points it at a matching server:

```sh
# Minecraft (Java Edition)
RCON_PORT=25575 RCON_PASSWORD=... npm run test:integration

# Factorio
RCON_SERVER=factorio RCON_PORT=27015 RCON_PASSWORD=... npm run test:integration

# Source (CS:S, HL2DM, ...)
RCON_SERVER=source RCON_PORT=27015 RCON_PASSWORD=... npm run test:integration
```

`RCON_HOST` defaults to `127.0.0.1`. Use a throwaway server: the tests change state, and the header of each test file says how.

The scripts in `scripts/` download and start a server with RCON enabled and the password `ci-password`, as CI does:

```sh
node scripts/minecraft-server.ts vanilla latest /tmp/mc   # needs Java; or paper, or a version such as 1.20.1
scripts/factorio-server.sh /tmp/factorio                  # Linux x64 only
scripts/source-server.sh 232370 hl2mp dm_lockdown /tmp/srcds  # Linux, needs 32-bit libraries
```

CI runs the integration tests on every pull request, so you don't have to run all of them locally.

## Releases

Maintainers only. Bump `version` in `package.json`, commit, and push a matching `v*` tag. The release workflow stages the version on npm and creates a GitHub Release with generated notes. It becomes installable after `npm stage approve rcon-client@<version>`. Pre-release versions such as `5.0.0-beta.1` go to the `next` dist-tag.
