FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        chromium \
        ffmpeg \
        intel-media-va-driver \
        mesa-va-drivers \
        novnc \
        openbox \
        procps \
        pulseaudio \
        pulseaudio-utils \
        supervisor \
        websockify \
        x11-utils \
        x11vnc \
        xvfb \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 1000 --shell /bin/bash streamer \
    && mkdir -p /home/streamer/.config/chromium /run/stream \
    && chown -R streamer:streamer /home/streamer /run/stream

COPY entrypoint.sh /usr/local/bin/stream-entrypoint
COPY scripts/ /usr/local/bin/
COPY supervisord.conf /etc/supervisor/supervisord.conf
COPY pulse.pa /etc/pulse/stream.pa
COPY pulse-client.conf /etc/pulse/client.conf

RUN chmod 0755 \
        /usr/local/bin/stream-entrypoint \
        /usr/local/bin/run-browser \
        /usr/local/bin/run-ffmpeg \
        /usr/local/bin/run-openbox \
        /usr/local/bin/run-pulseaudio \
        /usr/local/bin/run-x11vnc \
        /usr/local/bin/redact-ffmpeg-log \
        /usr/local/bin/stream-healthcheck

EXPOSE 6080

ENTRYPOINT ["/usr/local/bin/stream-entrypoint"]
