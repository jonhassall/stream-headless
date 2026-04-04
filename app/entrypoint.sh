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

exec node src/index.js
