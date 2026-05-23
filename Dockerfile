# Debian-slim (not alpine) because node-pty's prebuilt binaries are
# linked against glibc, and the postinstall script needs a normal
# coreutils environment to chmod the spawn-helper.
FROM node:22-slim AS base

# Python + build deps for any source-built native modules. Most of the
# tree is pre-built; the few that aren't (rare) need python3/make/g++.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        python3 make g++ ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Install the Claude Code CLI into the image so the terminal can spawn
# it out of the box. Operators who pin a different version should
# rebuild from this Dockerfile with CLAUDE_CODE_VERSION as an --build-arg.
ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

WORKDIR /app

# Production deps only; lock-step with package-lock.json.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js eslint.config.js ./
COPY lib ./lib
COPY static ./static
COPY scripts ./scripts
COPY bin ./bin

# Default host = 0.0.0.0 so the container is reachable from the host;
# the operator MUST set AUTH_TOKEN or rely on the random one printed at
# startup. SECURITY.md documents the trust model.
ENV HOST=0.0.0.0 PORT=8765 LOG_FORMAT=json
EXPOSE 8765

# Use the existing node user (UID 1000) — don't run as root.
USER node

CMD ["node", "server.js"]
