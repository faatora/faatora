import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'scripts/**/*.{test,spec}.{ts,tsx}'],
    // Use threads pool instead of forks. Forks pool is unstable on the
    // Node 24 runtime GitHub Actions now forces for actions targeting
    // Node 20, leading to "Failed to start forks worker" in CI.
    pool: 'threads',
  },
});
