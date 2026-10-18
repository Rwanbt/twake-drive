module.exports = {
  testDir: __dirname,
  testMatch: /scribe-lifecycle\.browser\.spec\.cjs$/,
  retries: 0,
  workers: 1,
  timeout: 30_000,
  use: { browserName: "chromium", headless: true },
};
