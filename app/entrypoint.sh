#!/bin/bash
set -e

export HOME=/root
export XDG_RUNTIME_DIR=/run/user/0

mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

# Minimal PulseAudio config written directly over the system default.pa so that
# PA uses ONLY these modules regardless of root/user session mode.
# Key omissions vs system default: module-suspend-on-idle, module-udev-detect,
# module-detect, and all hardware/bluetooth/gsettings modules that cause errors
# in a container and can trigger PA to abort on startup.
cat > /etc/pulse/default.pa << 'PULSE_EOF'
load-module module-native-protocol-unix
load-module module-always-sink
PULSE_EOF

# Run PulseAudio in foreground mode inside a keepalive loop so it is
# automatically restarted if it ever exits unexpectedly.
(
  while true; do
    rm -f "$XDG_RUNTIME_DIR/pulse/native" "$XDG_RUNTIME_DIR/pulse/pid" 2>/dev/null
    pulseaudio \
      --exit-idle-time=-1 \
      --log-target=stderr \
      --log-level=warn \
      --daemonize=no || true
    echo '[entrypoint] PulseAudio exited, restarting in 2s...'
    sleep 2
  done
) &

# Wait for PulseAudio socket to be ready (up to 10 seconds)
for i in $(seq 1 20); do
  if [ -S "$XDG_RUNTIME_DIR/pulse/native" ]; then
    echo 'PulseAudio ready.'
    break
  fi
  sleep 0.5
done

export PULSE_SERVER="unix:$XDG_RUNTIME_DIR/pulse/native"

exec node src/index.js