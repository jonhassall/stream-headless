FROM node:20-bookworm

# Install system dependencies
# Note: chromium must come from Debian apt — Ubuntu's chromium-browser is a snap stub that fails in Docker
RUN apt-get update && apt-get install -y \
    chromium \
    ffmpeg \
    pulseaudio \
    pulseaudio-utils \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    python3 \
    make \
    g++ \
    intel-media-va-driver \
    i965-va-driver \
    libva-drm2 \
    vainfo \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node.js dependencies
# better-sqlite3 compiles a native addon — build tools above are required
COPY package.json ./
RUN npm install --omit=dev

COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

COPY src/ ./src/

EXPOSE 3000 6901 6902 6903

ENTRYPOINT ["./entrypoint.sh"]
