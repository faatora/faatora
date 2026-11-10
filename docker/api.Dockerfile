# Pragmatic multi-stage build for the API. Switches to `pnpm deploy --filter`
# for a slimmer image before the EP1 deploy step.
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/api ./apps/api
COPY packages ./packages
RUN pnpm install --no-frozen-lockfile
# Compliance ships as a workspace package that points main/types at dist/,
# so it must be built before the api can resolve @faatora/compliance imports.
RUN pnpm --filter @faatora/compliance build
RUN pnpm --filter @faatora/api build

FROM node:22-slim AS runtime
RUN corepack enable
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/api/package.json ./
COPY --from=build /app/packages/compliance/dist ./node_modules/@faatora/compliance/dist
COPY --from=build /app/packages/compliance/package.json ./node_modules/@faatora/compliance/package.json
COPY --from=build /app/node_modules ./node_modules

# Migrate-task payload: the migration SQL files and a standalone
# node-pg-migrate + pg install under /opt/migrate. This image is
# reused by the "migrate" ECS task definition with a command override,
# and the self-contained /opt/migrate install sidesteps pnpm's
# workspace symlink layout so the API's own node_modules stays
# untouched. The app runtime does not use any of this.
COPY --from=build /app/apps/api/migrations /app/migrations
RUN mkdir -p /opt/migrate && cd /opt/migrate && \
    echo '{"name":"migrate","private":true}' > package.json && \
    npm install --omit=dev --no-audit --no-fund \
        node-pg-migrate@7.7.1 pg@8.13.1

EXPOSE 3000
CMD ["node", "dist/main.js"]
