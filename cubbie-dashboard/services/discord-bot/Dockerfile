# Built by CDK (ecr_assets) from the repo root context: docker build -f services/discord-bot/Dockerfile .
FROM public.ecr.aws/docker/library/node:20-slim AS build
WORKDIR /app
COPY services/discord-bot/package.json ./
RUN npm install --omit=optional --no-audit --no-fund
COPY tsconfig.base.json /tsconfig.base.json
COPY services/discord-bot/tsconfig.json ./
RUN sed -i 's#../../tsconfig.base.json#/tsconfig.base.json#' tsconfig.json
COPY services/discord-bot/src ./src
RUN npx tsc -p tsconfig.json && npm prune --omit=dev

FROM public.ecr.aws/docker/library/node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY services/discord-bot/package.json ./
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
