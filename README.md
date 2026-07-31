# stream-headless

Run one Chromium window continuously and publish its picture and optional audio
to an RTMP or RTMPS destination. Everything is configured through `.env`.

The container also provides a password-protected noVNC session so the browser
can be controlled remotely. Browser cookies, logins, and site settings are kept
in a Docker volume.

## Requirements

- Docker Engine with Docker Compose v2
- A Linux host or Docker Desktop/Engine through WSL2
- Enough CPU to encode the selected resolution with `libx264`

## Configure

Copy the example configuration:

```bash
cp .env.example .env
```

At minimum, set:

```dotenv
PAGE_URL=https://example.com/
RTMP_URL=rtmp://your-provider.example/app/your-stream-key
VNC_PASSWORD=changeMe
```

`VNC_PASSWORD` must contain 6–8 characters. Classic VNC authentication cannot
use more than the first eight characters, so longer values are rejected rather
than silently weakened.

Available settings:

| Variable | Default | Description |
| --- | --- | --- |
| `PAGE_URL` | required | Web page opened in Chromium; must use HTTP or HTTPS |
| `RTMP_URL` | required | Complete RTMP/RTMPS destination, including stream key |
| `VNC_PASSWORD` | required | 6–8 character password for browser control |
| `RESOLUTION` | `1280x720` | Captured browser size |
| `FRAMERATE` | `30` | Frames per second, from 1–120 |
| `VIDEO_BITRATE` | `3500k` | FFmpeg video bitrate |
| `VIDEO_ENCODER` | `auto` | `auto`, `software`, `nvenc`, or `vaapi` |
| `X264_PRESET` | `veryfast` | Software `libx264` preset; faster presets such as `ultrafast` use less CPU but need more bitrate for equivalent quality |
| `AUDIO_ENABLED` | `true` | Capture webpage audio; when false, send silent AAC |
| `AUDIO_BITRATE` | `128k` | AAC bitrate |
| `CONTROL_BIND` | `0.0.0.0` | Host address on which noVNC is published |
| `CONTROL_PORT` | `6080` | Host port for noVNC |
| `RTMP_RETRY_DELAY` | `5` | Seconds between publishing attempts |
| `BROWSER_RESTART_INTERVAL_SECONDS` | `0` | Restart Chromium after this many seconds; `0` leaves it running indefinitely |

## Run

```bash
docker compose up -d --build
docker compose logs -f stream
```

The stream starts automatically. There is no settings UI or start/stop API.
If the RTMP destination is unavailable, the container keeps the browser alive
and retries publishing indefinitely.

When `BROWSER_RESTART_INTERVAL_SECONDS` is positive, Chromium is deliberately
restarted on that interval to limit browser memory growth. The captured stream
can be briefly interrupted while Chromium starts again.

### Hardware H.264 encoding

`VIDEO_ENCODER=auto` performs short real encoding probes at the configured
resolution. It selects NVIDIA NVENC first, then VAAPI for Intel/AMD hardware,
and otherwise uses CPU-based `libx264`. Merely finding an FFmpeg encoder or
device node is not considered sufficient—the probe must successfully produce
H.264 frames.

Linux DRM/VAAPI devices are supported by the standard Compose file and safely
fall back to software when the host has no compatible encoder.

NVIDIA requires the NVIDIA Container Toolkit because Docker must inject the
matching host driver libraries. Start with the included override:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.nvidia.yml \
  up -d --build
```

The logs report `Selected H.264 encoder: nvenc`, `vaapi`, or `software` without
printing the RTMP destination. To require a particular encoder instead of
falling back, set `VIDEO_ENCODER=nvenc` or `VIDEO_ENCODER=vaapi`; startup remains
unhealthy and logs a clear probe failure if it cannot be used.

Open browser control at:

```text
http://HOST:6080/vnc.html?autoconnect=1&resize=scale
```

Use the password from `VNC_PASSWORD` when noVNC prompts for it.

To stop:

```bash
docker compose down
```

The `browser-data` volume is deliberately retained by `docker compose down`.
This preserves cookies and authenticated sessions. To explicitly discard the
browser profile, stop the stack first and then run:

```bash
docker compose down --volumes
```

## Autoplay and audio

Chromium starts with its autoplay policy disabled, allowing media to play
without a synthetic or manual mouse click. The container does not inject page
scripts or generate mouse input.

When `AUDIO_ENABLED=true`, Chromium outputs into a private PulseAudio sink and
FFmpeg captures that sink. When false, FFmpeg sends a silent stereo AAC track
instead, which is more broadly compatible with streaming services than a
video-only FLV stream.

## Reliability

Supervisor independently monitors Xvfb, PulseAudio, Openbox, Chromium, x11vnc,
noVNC, and the FFmpeg retry loop. Chromium can restart without destroying its
persistent profile or deliberately stopping the RTMP publisher. Hardware
encoder selection is repeated whenever the FFmpeg supervisor process itself is
restarted.

Docker reports the container as healthy only when the display, audio server,
browser, and an active FFmpeg publishing attempt are present. During an RTMP
outage the container may be reported as unhealthy while its internal retry loop
continues working.

Inspect status and logs with:

```bash
docker compose ps
docker compose logs --tail=200 stream
```

## Security

- noVNC is served over plain HTTP. Keep it on a trusted LAN or place it behind
  a TLS reverse proxy with stronger authentication.
- To make noVNC local-only, set `CONTROL_BIND=127.0.0.1` and access it through
  an SSH tunnel.
- The complete RTMP URL is an environment variable and normally contains a
  secret stream key. Protect `.env`, do not commit it, and avoid sharing
  unredacted container inspection output.
- Chromium uses `--no-sandbox` inside the dedicated container. Do not use this
  browser for unrelated general-purpose browsing.
