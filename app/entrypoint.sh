#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf 'Configuration error: %s\n' "$1" >&2
  exit 64
}

require_value() {
  local name="$1"
  [[ -n "${!name:-}" ]] || fail "${name} is required"
}

require_integer_between() {
  local name="$1"
  local minimum="$2"
  local maximum="$3"
  local value="${!name}"

  [[ "$value" =~ ^[0-9]+$ ]] || fail "${name} must be an integer"
  (( value >= minimum && value <= maximum )) \
    || fail "${name} must be between ${minimum} and ${maximum}"
}

require_bitrate() {
  local name="$1"
  local value="${!name}"
  [[ "$value" =~ ^[1-9][0-9]*[kKmM]?$ ]] \
    || fail "${name} must be a positive FFmpeg bitrate such as 3500k"
}

require_value PAGE_URL
require_value RTMP_URL
require_value VNC_PASSWORD

[[ "$PAGE_URL" =~ ^https?:// ]] \
  || fail "PAGE_URL must start with http:// or https://"
[[ "$RTMP_URL" =~ ^rtmps?:// ]] \
  || fail "RTMP_URL must start with rtmp:// or rtmps://"

export RESOLUTION="${RESOLUTION:-1280x720}"
export FRAMERATE="${FRAMERATE:-30}"
export VIDEO_BITRATE="${VIDEO_BITRATE:-3500k}"
export VIDEO_ENCODER="${VIDEO_ENCODER:-auto}"
export AUDIO_ENABLED="${AUDIO_ENABLED:-true}"
export AUDIO_BITRATE="${AUDIO_BITRATE:-128k}"
export CONTROL_BIND="${CONTROL_BIND:-0.0.0.0}"
export CONTROL_PORT="${CONTROL_PORT:-6080}"
export RTMP_RETRY_DELAY="${RTMP_RETRY_DELAY:-5}"

[[ "$RESOLUTION" =~ ^([0-9]+)x([0-9]+)$ ]] \
  || fail "RESOLUTION must use WIDTHxHEIGHT syntax"
export VIDEO_WIDTH="${BASH_REMATCH[1]}"
export VIDEO_HEIGHT="${BASH_REMATCH[2]}"
require_integer_between VIDEO_WIDTH 320 7680
require_integer_between VIDEO_HEIGHT 240 4320
require_integer_between FRAMERATE 1 120
require_integer_between CONTROL_PORT 1 65535
require_integer_between RTMP_RETRY_DELAY 1 300
require_bitrate VIDEO_BITRATE
require_bitrate AUDIO_BITRATE

case "${VIDEO_ENCODER,,}" in
  auto|software|nvenc|vaapi) export VIDEO_ENCODER="${VIDEO_ENCODER,,}" ;;
  *) fail "VIDEO_ENCODER must be auto, software, nvenc, or vaapi" ;;
esac

case "${AUDIO_ENABLED,,}" in
  true|1|yes|on) export AUDIO_ENABLED=true ;;
  false|0|no|off) export AUDIO_ENABLED=false ;;
  *) fail "AUDIO_ENABLED must be true or false" ;;
esac

if (( ${#VNC_PASSWORD} < 6 || ${#VNC_PASSWORD} > 8 )); then
  fail "VNC_PASSWORD must contain 6 to 8 characters (the VNC protocol supports at most 8)"
fi

export DISPLAY=:99
export HOME=/home/streamer
export XDG_RUNTIME_DIR=/run/stream
export PULSE_SERVER=unix:/run/stream/pulse/native
export PULSE_SINK=stream

install -d -m 0700 -o streamer -g streamer \
  "$XDG_RUNTIME_DIR" \
  "$HOME/.config/chromium"
install -d -m 0755 /run/dbus
install -d -m 1777 /tmp/.X11-unix

# DRM render nodes use Linux character-device major 226. The matching cgroup
# rule in Compose makes this harmless on hosts without a GPU: the probe fails
# and FFmpeg falls back to libx264.
if [[ ! -e /dev/dri/renderD128 ]]; then
  install -d -m 0755 /dev/dri
  mknod /dev/dri/renderD128 c 226 128 2>/dev/null || true
fi
if [[ -c /dev/dri/renderD128 ]]; then
  chown streamer:streamer /dev/dri/renderD128
  chmod 0600 /dev/dri/renderD128
fi

rm -rf "$XDG_RUNTIME_DIR/pulse"
install -d -m 0700 -o streamer -g streamer "$XDG_RUNTIME_DIR/pulse"

x11vnc -storepasswd "$VNC_PASSWORD" "$XDG_RUNTIME_DIR/vnc.pass" >/dev/null 2>&1
chown streamer:streamer "$XDG_RUNTIME_DIR/vnc.pass"
chmod 0600 "$XDG_RUNTIME_DIR/vnc.pass"

printf 'Starting one %s browser stream at %s fps with audio capture %s.\n' \
  "$RESOLUTION" "$FRAMERATE" "$AUDIO_ENABLED"
printf 'noVNC is available through the configured host binding on container port 6080.\n'

exec /usr/bin/supervisord -c /etc/supervisor/supervisord.conf
