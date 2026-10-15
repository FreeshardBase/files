FROM node:22-slim AS build
WORKDIR /src
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-slim AS runtime
LABEL org.opencontainers.image.title="FreeShard Files" org.opencontainers.image.licenses="FSL-1.1-ALv2"
ENV NODE_ENV=production FILES_DATA_DIR=/data FILES_WEB_DIST=/app/web FILES_PORT=3005
WORKDIR /app
# Thumbnail generators (#144): ffmpeg for a video frame, pdftoppm (poppler-utils) for a PDF's first page.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg poppler-utils && rm -rf /var/lib/apt/lists/*
RUN corepack enable && mkdir /data && chown node:node /data
COPY --from=build /src/pnpm-lock.yaml /src/pnpm-workspace.yaml /src/package.json ./
COPY --from=build /src/shared/package.json shared/
COPY --from=build /src/server/package.json server/
RUN pnpm install --frozen-lockfile --prod --filter @files/server... && pnpm store prune
COPY --from=build /src/server/dist server/dist
COPY --from=build /src/server/migrations server/migrations
COPY --from=build /src/web/dist web
# No USER: the server starts as root only to chown a root-owned /data bind mount, then drops to node (uid 1000)
# before anything else runs (server/src/dataDir.ts).
EXPOSE 3005
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+process.env.FILES_PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server/dist/main.js"]
