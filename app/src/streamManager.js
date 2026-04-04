'use strict';

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const db = require('./db');

const MAX_STREAMS = parseInt(process.env.MAX_STREAMS || '3', 10);

const RESOLUTIONS = {
  '480p':  { w: 854,  h: 480  },
  '720p':  { w: 1280, h: 720  },
  '1080p': { w: 1920, h: 1080 },
};

// Map<streamId, { slot, xvfb, chromium, ffmpeg, x11vnc, websockify }>
const active = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slotInfo(slot) {
  return {
    display:  `:1${slot}`,
    sinkName: `stream_1${slot}`,
    vncPort:  5900 + slot,
    wsPort:   6900 + slot,
  };
}

function freeSlot() {
  const used = new Set([...active.values()].map(e => e.slot));
  for (let i = 1; i <= MAX_STREAMS; i++) {
    if (!used.has(i)) return i;
  }
  return null;
}

function cleanLockFiles(display) {
  // display looks like ":11" — strip the colon to get "11"
  const num = display.replace(':', '');
  const lock = `/tmp/.X${num}-lock`;
  const sock = `/tmp/.X11-unix/X${num}`;
  for (const p of [lock, sock]) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
  }
}

function spawnProc(cmd, args, extraEnv = {}) {
  const proc = spawn(cmd, args, {
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  proc.stdout.on('data', d => process.stdout.write(`[${cmd}] ${d}`));
  proc.stderr.on('data', d => process.stderr.write(`[${cmd}] ${d}`));
  return proc;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function tryExec(cmd) {
  try {
    execSync(cmd, { shell: true, stdio: 'pipe', timeout: 5000 });
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Start a stream
// ---------------------------------------------------------------------------

async function startStream(stream) {
  if (active.has(stream.id)) throw new Error('Stream already running');

  const slot = freeSlot();
  if (slot === null) throw new Error(`No free display slots (max ${MAX_STREAMS})`);

  const { display, sinkName, vncPort, wsPort } = slotInfo(slot);
  const res = RESOLUTIONS[stream.resolution] || RESOLUTIONS['720p'];
  const { w, h } = res;

  cleanLockFiles(display);

  // Load a dedicated PulseAudio null sink for this stream
  tryExec(`pactl load-module module-null-sink sink_name=${sinkName} sink_properties=device.description=${sinkName}`);

  // 1 — Xvfb
  const xvfb = spawnProc('Xvfb', [
    display, '-screen', '0', `${w}x${h}x24`, '-ac',
  ]);
  await sleep(600);

  // 2 — Chromium
  const chromiumArgs = [
    '--no-sandbox',
    '--test-type',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-zygote',
    '--no-first-run',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-notifications',
    '--disable-features=IsolateOrigins,site-per-process,SharedArrayBuffer',
    '--force-device-scale-factor=1',
    `--window-size=${w},${h}`,
    '--window-position=0,0',
  ];

  if (stream.show_address_bar) {
    // Normal browser window — address bar visible
    chromiumArgs.push(stream.url);
  } else {
    // App mode — no address bar, no tabs
    chromiumArgs.push(`--app=${stream.url}`);
  }

  const chromium = spawnProc('chromium', chromiumArgs, {
    DISPLAY: display,
    PULSE_SINK: sinkName,
    HOME: '/root',
  });
  await sleep(1200);

  // 3 — FFmpeg
  const ac = stream.audio_channels === 1 ? '1' : '2';
  const ffmpeg = spawnProc('ffmpeg', [
    '-loglevel', 'warning',
    // Video: capture Xvfb display
    '-f', 'x11grab',
    '-framerate', '30',
    '-video_size', `${w}x${h}`,
    '-draw_mouse', '0',
    '-i', `${display}.0`,
    // Audio: capture PulseAudio monitor
    // -use_wallclock_as_timestamps: prevents backward DTS from the null sink clock
    // -thread_queue_size: larger buffer reduces dropped/out-of-order audio packets
    '-f', 'pulse',
    '-thread_queue_size', '512',
    '-use_wallclock_as_timestamps', '1',
    '-i', `${sinkName}.monitor`,
    // Video encoding
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-b:v', `${stream.bitrate}k`,
    '-g', '60',
    // Audio encoding — aresample=async=1 smooths out any remaining timestamp jitter
    '-c:a', 'aac',
    '-af', 'aresample=async=1:min_hard_comp=0.100000:first_pts=0',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', ac,
    // Output
    '-f', 'flv',
    stream.rtmp_url,
  ], {
    DISPLAY: display,
    PULSE_SERVER: process.env.PULSE_SERVER || '',
  });

  // 4 — x11vnc
  const x11vnc = spawnProc('x11vnc', [
    '-display', display,
    '-nopw',
    '-listen', 'localhost',
    '-rfbport', String(vncPort),
    '-forever',
    '-shared',
    '-xkb',
    '-noxrecord',
  ]);
  await sleep(500);

  // 5 — websockify (bridges WebSocket → raw VNC)
  const websockify = spawnProc('websockify', [
    `0.0.0.0:${wsPort}`,
    `localhost:${vncPort}`,
  ]);

  const entry = { slot, xvfb, chromium, ffmpeg, x11vnc, websockify };
  active.set(stream.id, entry);
  db.setStatus(stream.id, 'running', slot);

  // If FFmpeg exits unexpectedly, mark the stream as stopped
  ffmpeg.on('exit', (code) => {
    if (active.has(stream.id)) {
      console.warn(`[stream ${stream.id}] FFmpeg exited with code ${code} — marking stopped`);
      stopStream(stream.id).catch(() => {});
    }
  });

  return { slot, display, wsPort };
}

// ---------------------------------------------------------------------------
// Stop a stream
// ---------------------------------------------------------------------------

async function stopStream(streamId) {
  const entry = active.get(streamId);
  if (!entry) return;

  active.delete(streamId);

  const { slot, xvfb, chromium, ffmpeg, x11vnc, websockify } = entry;
  const { sinkName } = slotInfo(slot);

  // Graceful termination
  for (const proc of [ffmpeg, chromium, websockify, x11vnc, xvfb]) {
    try { proc.kill('SIGTERM'); } catch (_) {}
  }

  await sleep(1500);

  // Force kill anything still alive
  for (const proc of [ffmpeg, chromium, websockify, x11vnc, xvfb]) {
    try { proc.kill('SIGKILL'); } catch (_) {}
  }

  // Unload the PulseAudio null sink
  tryExec(
    `pactl unload-module $(pactl list short modules | grep "sink_name=${sinkName}" | awk '{print $1}')`
  );

  db.setStatus(streamId, 'stopped', null);
}

// ---------------------------------------------------------------------------
// Query runtime info (used by REST API to enrich stream objects)
// ---------------------------------------------------------------------------

function getActiveInfo(streamId) {
  const entry = active.get(streamId);
  if (!entry) return null;
  const { wsPort } = slotInfo(entry.slot);
  return { slot: entry.slot, wsPort };
}

module.exports = { startStream, stopStream, getActiveInfo };
