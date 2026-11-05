#!/usr/bin/env bash
# Downloads the Factorio headless server, starts it in the background with RCON
# on port 27015 (password "ci-password") and exits once RCON accepts connections.
#
#   scripts/factorio-server.sh <directory>
set -euo pipefail
dir=${1:-factorio}
mkdir -p "$dir"
curl -fsSL https://factorio.com/get-download/stable/headless/linux64 | tar -xJ -C "$dir"
cd "$dir/factorio"
./bin/x64/factorio --create saves/ci.zip > create.log 2>&1
nohup ./bin/x64/factorio --start-server saves/ci.zip --rcon-port 27015 --rcon-password ci-password \
  > server.log 2>&1 < /dev/null &
for _ in $(seq 120); do
  if grep -q "Starting RCON interface" server.log; then echo "RCON is up"; exit 0; fi
  sleep 1
done
cat server.log
exit 1
