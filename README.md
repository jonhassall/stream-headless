# stream-headless

# WARNING: VIBE CODED LOW QUALITY CRAP

Stream headless Chromium windows with audio to RTMP (Twitch, YouTube, etc.) from a Docker container. Includes a web admin panel and in-browser VNC access per stream.

## Requirements

- Docker + Docker Compose

## Setup

**1. Clone and enter the project directory.**

**2. Create your `.env` file:**

```
cp .env.example .env
```

Edit `.env` if you want a different port (default: `8080`).

**3. Set your credentials in `.env`:**

Edit `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `SESSION_SECRET`.

**4. Build and start:**

```bash
docker compose up -d --build
```

**5. Open the panel at `http://your-server-ip:8080`**

Log in with your admin credentials.

## Usage

1. Click **+ New Stream** and fill in:
   - **Web Page URL** — the page to display in the stream
   - **RTMP URL** — your stream destination including stream key
     - Twitch: `rtmp://live.twitch.tv/app/<streamkey>`
     - YouTube: `rtmp://a.rtmp.youtube.com/live2/<streamkey>`
   - Resolution, bitrate, audio channels, address bar toggle

2. Click **▶ Start** to begin streaming.

3. Click **🖥 VNC** on a running stream to open a live view of the browser window in your browser — you can click and interact with the page.

4. Click **⏹ Stop** to end the stream.

## Persistence

Any stream that is running when the container stops will automatically restart the next time the container starts.

## Limits

Up to **3 simultaneous streams** with the default config (one per display slot `:11`, `:12`, `:13`). Each stream runs its own Xvfb display, Chromium, FFmpeg, x11vnc, and websockify process.

## Security notes

- Run behind a reverse proxy with TLS (e.g. Caddy, Nginx, Cloudflare) — the container itself serves plain HTTP.
- Change the default `SESSION_SECRET` and admin credentials before deploying.
- RTMP stream keys are stored in plaintext in the SQLite database at the Docker volume `/data/db.sqlite`. Use per-stream keys, not account passwords.
- `--no-sandbox` is required for Chromium inside Docker (no kernel user namespaces). Do not expose the admin panel publicly without TLS + strong credentials.
