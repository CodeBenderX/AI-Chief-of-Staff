FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @aicos/core build && pnpm --filter @aicos/api build && pnpm --filter @aicos/web build \
 && pnpm --filter @aicos/api deploy --prod --legacy /out

FROM node:22-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 STATIC_DIR=/app/web
WORKDIR /app
COPY --from=build /out ./api
COPY --from=build /app/apps/web/dist ./web
USER node
EXPOSE 8787
CMD ["node", "api/dist/server.js"]
