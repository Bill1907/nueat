FROM oven/bun:1.3.14-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/package.json
COPY apps/mobile/package.json apps/mobile/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/domain/package.json packages/domain/package.json
RUN bun install --frozen-lockfile --production --filter @nueat/api

COPY --chown=bun:bun apps/api apps/api
COPY --chown=bun:bun packages/database packages/database
COPY --chown=bun:bun packages/domain packages/domain

USER bun
EXPOSE 3000
CMD ["bun", "run", "--cwd", "apps/api", "start"]
