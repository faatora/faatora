import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { sentryVitePlugin } from '@sentry/vite-plugin';

/**
 * Vite config.
 *
 * The Sentry source-map upload plugin is attached only when the three
 * env vars it needs are set (SENTRY_AUTH_TOKEN + SENTRY_ORG +
 * SENTRY_PROJECT). CI (GitHub Actions) injects these; local `vite
 * build` without them is a no-op and the build still succeeds.
 *
 * `build.sourcemap = true` is required so the plugin has something to
 * upload. It adds ~10% to the build artefact but Vercel does not ship
 * .map files to clients by default.
 */
export default defineConfig(() => {
  const { SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT } = process.env;
  const sentryEnabled = Boolean(SENTRY_AUTH_TOKEN && SENTRY_ORG && SENTRY_PROJECT);

  return {
    plugins: [
      react(),
      ...(sentryEnabled
        ? [
            sentryVitePlugin({
              org: SENTRY_ORG,
              project: SENTRY_PROJECT,
              authToken: SENTRY_AUTH_TOKEN,
              // Hide secret paths from the uploaded source map.
              sourcemaps: { filesToDeleteAfterUpload: ['./dist/**/*.map'] },
            }),
          ]
        : []),
    ],
    build: {
      sourcemap: sentryEnabled,
    },
    server: { port: 5173 },
  };
});
