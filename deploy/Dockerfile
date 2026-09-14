FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ pkg-config && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm run build:gateway && pnpm run build:frontend
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git make g++ pkg-config python3 ripgrep tmux && rm -rf /var/lib/apt/lists/*
RUN groupadd --system tmuxgo && useradd --system --create-home --gid tmuxgo --shell /usr/sbin/nologin tmuxgo
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=build /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /app/apps/gateway/package.json ./apps/gateway/package.json
COPY --from=build /app/scripts/fix-native-perms.sh ./scripts/fix-native-perms.sh
RUN pnpm install --prod --frozen-lockfile --filter gateway
COPY --from=build /app/apps/gateway/dist ./apps/gateway/dist
COPY --from=build /app/apps/frontend/dist ./apps/frontend/dist
RUN mkdir -p /home/tmuxgo/.tmuxgo /workspace && chown -R tmuxgo:tmuxgo /home/tmuxgo /workspace
ENV NODE_ENV=production
ENV HOME=/home/tmuxgo
ENV PORT=3001
ENV TMUXGO_HOST=0.0.0.0
ENV TMUXGO_FRONTEND_DIST=/app/apps/frontend/dist
USER tmuxgo
EXPOSE 3001
CMD ["node", "apps/gateway/dist/index.js"]
