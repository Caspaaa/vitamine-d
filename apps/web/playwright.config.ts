import { defineConfig, devices } from '@playwright/test';

const PORT = 3000;

// Headless Chromium has no GPU: SwiftShader provides WebGL 2, which is all the shadow renderer needs.
const softwareGl = { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] };

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}`, locale: 'en-BE', timezoneId: 'Europe/Brussels', trace: 'retain-on-failure' },
  projects: [
    { name: 'android-chromium', use: { ...devices['Pixel 7'], launchOptions: softwareGl } },
    { name: 'ios-webkit', use: { ...devices['iPhone 15'] } },
  ],
  webServer: {
    command: 'pnpm dev --port 3000',
    url: `http://localhost:${PORT}/en/`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
