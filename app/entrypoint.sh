#!/bin/bash
set -e

export HOME=/root
export XDG_RUNTIME_DIR=/run/user/0

mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

# Start PulseAudio in user mode (not system-wide)
pulseaudio \
  --start \
  --exit-idle-time=-1 \
  --log-target=stderr \
  --daemonize=yes

# Wait for PulseAudio socket to be ready (up to 5 seconds)
for i in $(seq 1 10); do
  if [ -S "$XDG_RUNTIME_DIR/pulse/native" ]; then
    echo "PulseAudio ready."
    break
  fi
  sleep 0.5
done

export PULSE_SERVER="unix:$XDG_RUNTIME_DIR/pulse/native"

# Prevent PulseAudio from suspending sinks when idle.
# Without this, the null sink monitor stops delivering frames to FFmpeg
# after ~5s of no audio playback, causing silent RTMP disconnects.
pactl unload-module module-suspend-on-idle 2>/dev/null || true

exec node src/index.js
