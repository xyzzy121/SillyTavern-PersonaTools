import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './tests',
    testMatch: '*.spec.js',
    globalSetup: './tests/setup.mjs',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: 0,
    workers: 2,
    timeout: 20_000,
    expect: { timeout: 5_000 },
    reporter: 'list',
    use: {
        baseURL: 'http://127.0.0.1:4179',
        browserName: 'chromium',
        viewport: { width: 1200, height: 900 },
        trace: 'retain-on-failure',
    },
});
