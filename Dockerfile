# MotionForge Remotion rendering worker
#
# This image runs untrusted user-supplied project code during `npm install`
# (with --ignore-scripts) and Remotion's Chromium-based render. Run the
# resulting container with least privilege:
#
#   docker run --rm \
#     --read-only --tmpfs /tmp:size=2g \
#     --cap-drop=ALL --security-opt=no-new-privileges \
#     --memory=2g --cpus=2 \
#     --network=<restricted-network-or-none-beyond-egress-to-supabase> \
#     --env-file .env \
#     motionforge-remotion-worker
#
# Network: the container needs egress to download the source ZIP (a
# Supabase signed URL) and to upload the rendered output back to
# Supabase Storage. It needs NO inbound access beyond the port this
# service listens on behind your own reverse proxy / auth layer.

FROM node:20-bookworm-slim AS base

# Remotion's renderer drives a headless Chromium; install the system
# libraries Chromium needs (Debian bookworm package names).
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

ENV REMOTION_BROWSER_EXECUTABLE=/usr/bin/chromium

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm install --ignore-scripts && npm run build && npm prune --omit=dev

# Run as the non-root `node` user baked into the base image — never root.
RUN mkdir -p /tmp/motionforge-renders && chown -R node:node /tmp/motionforge-renders /app
USER node

EXPOSE 8787
CMD ["node", "dist/server.js"]
