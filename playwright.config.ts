import { defineConfig, devices } from '@playwright/test';

/**
 * The container ships a Chromium build that does not match the version
 * Playwright would download, so tests launch the one that is present and force
 * the SwiftShader backend -- there is no GPU here, and without an explicit
 * backend Chromium falls back to software rasterisation with WebGL disabled.
 */
const CHROMIUM = process.env.CHROMIUM_PATH
  ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    launchOptions: {
      executablePath: CHROMIUM,
      args: [
        '--no-sandbox',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--disable-dev-shm-usage',
        '--force-device-scale-factor=1',
      ],
    },
  },
  projects: [
    {
      name: 'mobile',
      use: {
        ...devices['Pixel 7'],
        // Real Pixel 7 DPR is 2.625; the renderer caps at 2, and the harness
        // matches that so measurements reflect what ships.
        deviceScaleFactor: 2,
        viewport: { width: 412, height: 869 },
        isMobile: true,
        hasTouch: true,
        defaultBrowserType: 'chromium',
      },
    },
  ],
  webServer: {
    command: 'npx vite preview --port 4173 --host 127.0.0.1',
    url: 'http://127.0.0.1:4173',
    // Never reuse a server that is already running: it may be serving an older
    // dist, and a visual-diff suite comparing a new baseline against a stale
    // build reports differences that do not exist in the source.
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
