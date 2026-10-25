# Cubbie dashboard + Tesseract, as one container. Build context: the cubbie-dashboard folder.
# Stage 1 builds the React app and Tesseract; stage 2 is a slim runtime with Node + Python.
FROM node:24-bookworm AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repo
RUN corepack enable
COPY . .
# Only what the hosted app needs (skips infra/CDK, the Lambda API and the iMessage relay).
RUN pnpm install --frozen-lockfile --filter @cubbie/web... --filter @cubbie/tesseract...
RUN pnpm --filter @cubbie/tesseract build && pnpm --filter @cubbie/web build
# A standalone copy of Tesseract with real (non-symlinked) production node_modules.
RUN pnpm --filter @cubbie/tesseract deploy --prod /out/tesseract \
 && rm -rf /out/tesseract/dist && cp -r services/tesseract/dist /out/tesseract/dist

FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY services/local/requirements.txt services/local/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r services/local/requirements.txt
COPY services/local services/local
COPY --from=build /out/tesseract services/tesseract
COPY --from=build /repo/apps/web/dist apps/web/dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8787
# Port comes from $PORT when the platform sets it (Railway, Render), otherwise 8787.
CMD ["python3", "services/local/server.py", "--host", "0.0.0.0", "--state-dir", "/data"]
