#!/usr/bin/env bash
# Downloads a Source dedicated server with SteamCMD, starts it in the background
# with RCON on port 27015 (password "ci-password") and exits once RCON accepts
# connections. Needs the 32-bit libraries: lib32gcc-s1 lib32stdc++6.
#
#   scripts/source-server.sh <app id> <game> <map> <directory>
#   scripts/source-server.sh 232330 cstrike de_dust2 srcds
set -euo pipefail
app=$1 game=$2 map=$3 dir=$(realpath -m "${4:-srcds}")
mkdir -p "$dir/steamcmd"
curl -fsSL https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz | tar -xz -C "$dir/steamcmd"
# SteamCMD fails now and then with "Missing configuration"; a retry fixes it.
for _ in 1 2 3; do
  "$dir/steamcmd/steamcmd.sh" +force_install_dir "$dir/server" +login anonymous +app_update "$app" validate +quit | tail -2
  [ -x "$dir/server/srcds_run" ] && break
done
mkdir -p ~/.steam/sdk32
cp "$dir/steamcmd/linux32/steamclient.so" ~/.steam/sdk32/
cd "$dir/server"
# srcds stalls during startup without a terminal, so give it one with script.
nohup script -qfec "./srcds_run -game $game -console -insecure -norestart -port 27015 +ip 0.0.0.0 +sv_lan 1 +maxplayers 2 +rcon_password ci-password +map $map" \
  /dev/null > server.log 2>&1 < /dev/null &
for _ in $(seq 180); do
  if (exec 3<>/dev/tcp/127.0.0.1/27015) 2>/dev/null; then echo "RCON is up"; exit 0; fi
  sleep 1
done
tail -50 server.log
exit 1
