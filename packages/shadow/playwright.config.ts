import { defineConfig } from '@playwright/test';

// Headless Chromium has no GPU: SwiftShader provides the WebGL 2 the harness needs.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:5190', launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } },
  webServer: { command: 'pnpm harness', url: 'http://localhost:5190/', reuseExistingServer: true, timeout: 60_000 },
});
