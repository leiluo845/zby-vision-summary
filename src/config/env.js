const path = require("node:path");

function readBoolean(name, defaultValue) {
  const rawValue = process.env[name];
  if (rawValue == null || rawValue === "") {
    return defaultValue;
  }

  const normalized = String(rawValue).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

function readNumber(name, defaultValue) {
  const rawValue = process.env[name];
  if (rawValue == null || rawValue === "") {
    return defaultValue;
  }

  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function readList(name, defaultValue = []) {
  const rawValue = process.env[name];
  if (!rawValue) {
    return defaultValue;
  }

  return String(rawValue)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function loadEnv() {
  const rootDir = path.resolve(__dirname, "..", "..");

  return {
    rootDir,
    host: process.env.HOST || "0.0.0.0",
    port: readNumber("PORT", 3210),
    defaultTimezone: process.env.APP_TIMEZONE || "Asia/Shanghai",
    dataDir: path.resolve(rootDir, process.env.DATA_DIR || "runtime/formal-data"),
    syncPlansPath: path.resolve(rootDir, process.env.SYNC_PLANS_PATH || "src/config/sync-plans.json"),
    schedulerEnabled: readBoolean("SCHEDULER_ENABLED", true),
    provider: process.env.DINGTALK_PROVIDER || "dws",
    apiBaseUrl: process.env.DINGTALK_API_BASE_URL || "https://api.dingtalk.com",
    appKey: process.env.DINGTALK_APP_KEY || "",
    appSecret: process.env.DINGTALK_APP_SECRET || "",
    dwsConfigDir: path.resolve(rootDir, process.env.DWS_CONFIG_DIR || "..\\dws-config"),
    sheetReadChunkRows: readNumber("SHEET_READ_CHUNK_ROWS", 80),
    sheetReadMinChunkRows: readNumber("SHEET_READ_MIN_CHUNK_ROWS", 1),
    sheetReadRetryCount: readNumber("SHEET_READ_RETRY_COUNT", 3),
    sheetReadRetryDelayMs: readNumber("SHEET_READ_RETRY_DELAY_MS", 200),
    mockEditableUsers: readList("MOCK_EDITABLE_USERS", ["admin"]),
    mockSourceCsvPath: path.resolve(rootDir, process.env.MOCK_SOURCE_CSV || "runtime/source-test.csv"),
    mockTargetCsvPath: path.resolve(rootDir, process.env.MOCK_TARGET_CSV || "runtime/target-test.csv"),
    runHistoryLimit: readNumber("RUN_HISTORY_LIMIT", 20),
  };
}

module.exports = {
  loadEnv,
};
