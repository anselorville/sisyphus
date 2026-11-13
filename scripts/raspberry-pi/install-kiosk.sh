#!/usr/bin/env bash
# Install for the Raspberry Pi OS desktop user, after building the application.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
node=$(command -v node)
chromium=$(command -v chromium)
for file in .venv/bin/python agent-runtime/dist/index.js client/dist/index.html; do
  [[ -f "$root/$file" ]] || { echo "Missing $root/$file" >&2; exit 1; }
done
units="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
autostart="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
mkdir -p "$units" "$autostart"
# Raspberry Pi OS runs kanshi on each desktop login.
outputs="${XDG_CONFIG_HOME:-$HOME/.config}/kanshi/config"
if [[ ! -s "$outputs" ]] && compgen -G "/sys/class/drm/card*-SPI-1/status" >/dev/null; then
  mkdir -p "$(dirname "$outputs")"
  printf 'profile {\n  output SPI-1 transform 90\n}\n' > "$outputs"
  pkill -HUP -u "$UID" -x kanshi || true
fi

write_service() {
  local name=$1
  local command=$2
  cat >"$units/sisyphus-$name.service" <<UNIT
[Unit]
Description=Sisyphus $name

[Service]
WorkingDirectory=$root
ExecStart=$command
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
UNIT
}

write_service runtime "\"$node\" --env-file-if-exists=.env agent-runtime/dist/index.js"
write_service backend "\"$root/.venv/bin/python\" -m app.server"
write_service screen "/usr/bin/python3 -m http.server 1420 --bind 127.0.0.1 --directory \"$root/client/dist\""

# Start Chromium only once labwc has exported this login's Wayland environment.
cat >"$units/sisyphus-kiosk.service" <<UNIT
[Unit]
Description=Sisyphus fullscreen touch interface
Requires=sisyphus-screen.service
After=sisyphus-screen.service
PartOf=graphical-session.target

[Service]
ExecStartPre=/bin/sh -c 'until curl -fsS -o /dev/null http://127.0.0.1:1420/; do sleep 1; done'
ExecStart="$chromium" --ozone-platform=wayland --password-store=basic --force-device-scale-factor=1 --user-data-dir=%h/.local/share/sisyphus-chromium --no-first-run --disable-session-crashed-bubble --kiosk http://127.0.0.1:1420/?display=pi-portrait
Restart=on-failure
RestartSec=3
UNIT
cat >"$autostart/sisyphus-kiosk.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Sisyphus
Exec=systemctl --user start sisyphus-kiosk.service
Terminal=false
DESKTOP
systemctl --user daemon-reload
services=(sisyphus-runtime.service sisyphus-backend.service sisyphus-screen.service)
systemctl --user enable "${services[@]}"
systemctl --user restart "${services[@]}" sisyphus-kiosk.service
