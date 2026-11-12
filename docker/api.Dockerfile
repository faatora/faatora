# Build the API inside a pnpm workspace, then use `pnpm deploy` to
# materialize a self-contained production node_modules tree.
#
# Why pnpm deploy (and not just COPY /app/node_modules): a pnpm
# workspace install leaves each package's direct dependencies as
# symlinks under apps/api/node_modules/<pkg> pointing into the virtual
# store at /app/node_modules/.pnpm/. The previous version of this
# Dockerfile only copied /app/node_modules to the runtime stage and
# unpacked the API's dist to /app/dist, so Node resolving require()
# from /app/dist/main.js never traversed the API's own node_modules
# and crashed with:
#   Error: Cannot find module '@sentry/node'
# `pnpm deploy --filter @faatora/api --prod /deploy` resolves every
# production dependency (including workspace deps like
# @faatora/compliance) into a single flat /deploy/node_modules, which
# the runtime stage copies verbatim -- no symlink gymnastics.
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
# Copy the lockfile so pnpm can honour pinned versions. Dropping
# --no-frozen-lockfile prevents a drift between host-resolved versions
# and what was tested on the PR.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/api ./apps/api
COPY packages ./packages
RUN pnpm install --frozen-lockfile
# Compliance ships as a workspace package that points main/types at
# dist/, so it must be built before the API can resolve
# @faatora/compliance imports.
RUN pnpm --filter @faatora/compliance build
RUN pnpm --filter @faatora/api build
# Produce a deploy bundle at /deploy with flat node_modules.
RUN pnpm deploy --filter @faatora/api --prod /deploy

FROM node:22-slim AS runtime
RUN corepack enable
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /deploy/dist ./dist
COPY --from=build /deploy/package.json ./
COPY --from=build /deploy/node_modules ./node_modules

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
