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
EXPOSE 3000
CMD ["node", "dist/main.js"]
