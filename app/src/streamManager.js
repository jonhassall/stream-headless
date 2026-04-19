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
// Hardware encoder detection (runs once at module load)
// Priority: NVIDIA NVENC → VAAPI (Intel/AMD) → libx264 (CPU)
// ---------------------------------------------------------------------------

function detectHWEncoder() {
  try {
    const encoders = execSync('ffmpeg -hide_banner -encoders 2>&1', {
      timeout: 8000,
      shell: true,
    }).toString();

    // NVIDIA NVENC — requires /dev/nvidia0 and an NVENC-capable ffmpeg build.
    // Enable in docker-compose with the NVIDIA runtime (see docker-compose.yml).
    if (encoders.includes('h264_nvenc') && fs.existsSync('/dev/nvidia0')) {
      console.log('[encoder] NVIDIA NVENC detected — using h264_nvenc');
      return 'nvenc';
    }

    // VAAPI (Intel / AMD) — requires /dev/dri/renderD128.
    // Enable in docker-compose by passing the /dev/dri device (see docker-compose.yml).
    if (encoders.includes('h264_vaapi') && fs.existsSync('/dev/dri/renderD128')) {
      console.log('[encoder] VAAPI device detected — using h264_vaapi');
      return 'vaapi';
    }
  } catch (_) {}

  console.log('[encoder] No GPU encoder available — using libx264 (CPU)');
  return 'cpu';
}

const HW_ENCODER = detectHWEncoder();

function buildVideoEncodeArgs(stream, fps) {
  const { bitrate } = stream;
  const bufsize = bitrate * 2;

  if (HW_ENCODER === 'nvenc') {
    return [
      '-c:v', 'h264_nvenc',
      '-preset', 'p4',       // balanced quality/speed (p1=fastest … p7=slowest)
      '-tune', 'ull',        // ultra-low-latency
      '-rc', 'cbr',
      '-b:v', `${bitrate}k`,
      '-maxrate', `${bitrate}k`,
      '-bufsize', `${bufsize}k`,
      '-g', String(fps),
    ];
  }

  if (HW_ENCODER === 'vaapi') {
    // Frames are uploaded to GPU via the hwupload filter; -vaapi_device is
    // injected into the global FFmpeg args (before inputs) in startStream().
    return [
      '-c:v', 'h264_vaapi',
      '-b:v', `${bitrate}k`,
      '-maxrate', `${bitrate}k`,
      '-bufsize', `${bufsize}k`,
      '-g', String(fps),
    ];
  }

  // CPU fallback — libx264
  return [
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-b:v', `${bitrate}k`,
    '-maxrate', `${bitrate}k`,
    '-bufsize', `${bufsize}k`,
    '-x264-params', 'nal-hrd=cbr:force-cfr=1',
    '-g', String(fps),
  ];
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

  // Load a dedicated PulseAudio null sink for this stream and keep it active.
  // suspend-sink 0 prevents module-suspend-on-idle from suspending it even if
  // the web page has no audio — a suspended monitor delivers no frames to FFmpeg.
  tryExec(`pactl load-module module-null-sink sink_name=${sinkName} sink_properties=device.description=${sinkName}`);
  tryExec(`pactl suspend-sink ${sinkName} 0`);

  // 1 — Xvfb
  const xvfb = spawnProc('Xvfb', [
    display, '-screen', '0', `${w}x${h}x24`, '-ac',
  ]);
  await sleep(600);

  // 2 — Chromium
  // IMPORTANT: call the real binary directly, NOT /usr/bin/chromium.
  // The Debian wrapper sources /etc/chromium.d/* which injects --enable-gpu-rasterization
  // (among others). That flag turns on GPU compositing in a container with no GPU,
  // causing the GPU process to crash on any real page load.
  const chromiumBin = '/usr/lib/chromium/chromium';
  const chromiumArgs = [
    '--no-sandbox',
    '--test-type',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-gpu-rasterization',  // counteracts /etc/chromium.d/default-flags injection
    '--disable-software-rasterizer',
    '--in-process-gpu',             // no separate GPU process that can crash
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
    '--disable-sync',
    '--disable-extensions',
    '--disable-default-apps',
    '--no-default-browser-check',
    '--disable-component-update',
    '--metrics-recording-only',
    '--safebrowsing-disable-auto-update',
  ];

  if (stream.show_address_bar) {
    chromiumArgs.push(stream.url);
  } else {
    chromiumArgs.push(`--app=${stream.url}`);
  }

  const chromium = spawnProc(chromiumBin, chromiumArgs, {
    DISPLAY: display,
    PULSE_SINK: sinkName,
    HOME: '/root',
    DBUS_SESSION_BUS_ADDRESS: `unix:path=/tmp/no-dbus-${slot}`,
  });
  await sleep(1200);

  // 3 — FFmpeg (with auto-restart on unexpected exit)
  const ac = stream.audio_channels === 1 ? '1' : '2';
  const fps = stream.framerate || 30;
  const ffmpegArgs = [
    '-loglevel', 'warning',
    // VAAPI global device must appear before the first input
    ...(HW_ENCODER === 'vaapi' ? ['-vaapi_device', '/dev/dri/renderD128'] : []),
    // Video: capture Xvfb display
    '-f', 'x11grab',
    '-framerate', String(fps),
    '-thread_queue_size', '512',
    '-video_size', `${w}x${h}`,
    '-draw_mouse', '0',
    '-i', `${display}.0`,
    // Audio: capture PulseAudio monitor
    '-f', 'pulse',
    '-thread_queue_size', '512',
    '-use_wallclock_as_timestamps', '1',
    '-i', `${sinkName}.monitor`,
    // Upload frames to GPU memory before VAAPI encoding
    ...(HW_ENCODER === 'vaapi' ? ['-vf', 'format=nv12,hwupload'] : []),
    // Video encoding (codec chosen at startup based on GPU availability)
    ...buildVideoEncodeArgs(stream, fps),
    // Audio encoding
    '-c:a', 'aac',
    '-af', 'aresample=async=1:min_hard_comp=0.100000:first_pts=0',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', ac,
    // Output
    '-f', 'flv',
    stream.rtmp_url,
  ];
  const ffmpegEnv = { DISPLAY: display, PULSE_SERVER: process.env.PULSE_SERVER || '' };

  const MAX_FFMPEG_RESTARTS = 5;
  let ffmpegRestarts = 0;

  function spawnFFmpeg() {
    const proc = spawnProc('ffmpeg', ffmpegArgs, ffmpegEnv);
    proc.on('exit', (code) => {
      const entry = active.get(stream.id);
      if (!entry) return; // Intentionally stopped — do nothing

      console.warn(`[stream ${stream.id}] FFmpeg exited with code ${code} (restart ${ffmpegRestarts + 1}/${MAX_FFMPEG_RESTARTS})`);

      if (ffmpegRestarts >= MAX_FFMPEG_RESTARTS) {
        console.error(`[stream ${stream.id}] FFmpeg hit max restarts — stopping stream`);
        stopStream(stream.id).catch(() => {});
        return;
      }

      ffmpegRestarts++;
      setTimeout(() => {
        if (!active.has(stream.id)) return; // Stopped during the delay
        entry.ffmpeg = spawnFFmpeg();
      }, 3000);
    });
    return proc;
  }

  const ffmpeg = spawnFFmpeg();

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

  const entry = { slot, startedAt: Date.now(), xvfb, chromium, ffmpeg, x11vnc, websockify };
  active.set(stream.id, entry);
  db.setStatus(stream.id, 'running', slot);

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
  return { slot: entry.slot, wsPort, startedAt: entry.startedAt };
}

module.exports = { startStream, stopStream, getActiveInfo };
