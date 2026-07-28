const path = require("node:path");

function readNumber(name, defaultValue) {
  const rawValue = process.env[name];
  if (rawValue == null || rawValue === "") {
    return defaultValue;
  }

  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function loadEnv() {
  const rootDir = path.resolve(__dirname, "..", "..");

  return {
    rootDir,
    host: process.env.HOST || "0.0.0.0",
    port: readNumber("PORT", 3210),
    dataDir: path.resolve(rootDir, process.env.DATA_DIR || "runtime/formal-data"),
    syncPlansPath: path.resolve(rootDir, process.env.SYNC_PLANS_PATH || "src/config/sync-plans.json"),
    provider: process.env.DINGTALK_PROVIDER || "dws",
    dwsConfigDir: path.resolve(rootDir, process.env.DWS_CONFIG_DIR || "..\\dws-config"),
    sheetReadChunkRows: readNumber("SHEET_READ_CHUNK_ROWS", 80),
    sheetReadMinChunkRows: readNumber("SHEET_READ_MIN_CHUNK_ROWS", 1),
    sheetReadRetryCount: readNumber("SHEET_READ_RETRY_COUNT", 3),
    sheetReadRetryDelayMs: readNumber("SHEET_READ_RETRY_DELAY_MS", 200),
    mockSourceCsvPath: path.resolve(rootDir, process.env.MOCK_SOURCE_CSV || "runtime/source-test.csv"),
    mockTargetCsvPath: path.resolve(rootDir, process.env.MOCK_TARGET_CSV || "runtime/target-test.csv"),
    runHistoryLimit: readNumber("RUN_HISTORY_LIMIT", 20),
  };
}

module.exports = {
  loadEnv,
};
