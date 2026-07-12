# One-image deployment for nice-ocr:
# - Next.js web server
# - recognition worker
# - optional local PaddleOCR layout service
#
# Build:
#   docker build -t nice-ocr .

FROM node:22-bookworm-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV NEXT_TELEMETRY_DISABLED=1

RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app

FROM base AS node-deps

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    g++ \
    make \
    python3 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM node-deps AS builder

COPY . .
RUN pnpm db:generate
RUN pnpm build

FROM base AS runtime

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV DATABASE_URL=file:/data/nice-ocr.db
ENV STORAGE_DIR=/data/storage
ENV OCR_LAYOUT_URL=http://127.0.0.1:8077
ENV OCR_LAYOUT_HOST=127.0.0.1
ENV OCR_LAYOUT_PORT=8077
ENV ENABLE_OCR_LAYOUT=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    python3 \
    python3-venv \
    python3-pip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=node-deps /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/src ./src
COPY tools/ocr-layout ./tools/ocr-layout
COPY docker/entrypoint.sh ./docker/entrypoint.sh

RUN python3 -m venv /opt/ocr-layout-venv \
  && /opt/ocr-layout-venv/bin/python -m pip install --no-cache-dir --upgrade pip \
  && /opt/ocr-layout-venv/bin/python -m pip install --no-cache-dir -r /app/tools/ocr-layout/requirements.txt \
  && chmod +x /app/docker/entrypoint.sh

EXPOSE 3000 8077
VOLUME ["/data"]

ENTRYPOINT ["/app/docker/entrypoint.sh"]
