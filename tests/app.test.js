const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildServices, createServer } = require("../src/app");

function writeTestPlanConfig(filePath, sourcePath, targetPath, options = {}) {
  const plan = {
    plans: [
      {
        planId: "test_plan",
        name: "测试同步",
        enabled: true,
        timezone: "Asia/Shanghai",
        rules: {
          keyColumn: "货号",
          fields: ["齐色主附图完成时间", "A+完成时间", "视频完成时间"],
          allowEmptyOverwrite: Boolean(options.allowEmptyOverwrite),
          placeholderValues: ["/"],
        },
        target: {
          node: "master-node",
          sheet: "Sheet1",
          mockCsvPath: targetPath,
          sheetId: "master-sheet",
          keyColumn: {
            column: "A",
            header: "货号",
          },
          columns: {
            "齐色主附图完成时间": { column: "B", header: "齐色主附图完成时间" },
            "A+完成时间": { column: "C", header: "A+完成时间" },
            "视频完成时间": { column: "D", header: "视频完成时间" },
          },
          writeGuard: {
            nodeId: "master-node",
            sheetId: "master-sheet",
          },
        },
        jobs: [
          {
            id: "job-1",
            label: "分表1",
            source: {
              node: "source-node-1",
              sheet: "分表1",
              mockCsvPath: sourcePath,
            },
            keyColumn: {
              column: "A",
              header: "货号",
            },
            fields: {
              "齐色主附图完成时间": { sourceHeader: "齐色主附图完成时间" },
              "A+完成时间": { sourceHeader: "A+完成时间" },
              "视频完成时间": { sourceHeader: "视频完成时间" },
            },
          },
        ],
        schedule: {
          crons: ["0 12 * * *"],
        },
      },
    ],
  };

  fs.writeFileSync(filePath, JSON.stringify(plan, null, 2), "utf8");
}

async function startTestServer(dataDir, configPath, sourcePath, targetPath) {
  const rootDir = path.resolve(__dirname, "..");
  const env = {
    rootDir,
    host: "127.0.0.1",
    port: 0,
    defaultTimezone: "Asia/Shanghai",
    dataDir,
    syncPlansPath: configPath,
    schedulerEnabled: false,
    provider: "mock",
    apiBaseUrl: "https://api.dingtalk.com",
    appKey: "",
    appSecret: "",
    dwsConfigDir: path.join(rootDir, "..", "dws-config"),
    mockEditableUsers: ["admin"],
    mockSourceCsvPath: sourcePath,
    mockTargetCsvPath: targetPath,
    runHistoryLimit: 20,
  };

  const services = buildServices(env);
  const server = createServer(services);
  await new Promise((resolve) => server.listen(0, env.host, resolve));

  const address = server.address();
  return {
    close: () => new Promise((resolve) => server.close(resolve)),
    baseUrl: `http://${env.host}:${address.port}`,
  };
}

test("web and callback endpoints expose the current plan and recent runs", async () => {
  const rootDir = path.resolve(__dirname, "..");
  const dataDir = fs.mkdtempSync(path.join(rootDir, "runtime", "app-test-"));
  const sourcePath = path.join(dataDir, "source.csv");
  const targetPath = path.join(dataDir, "target.csv");
  const configPath = path.join(dataDir, "sync-plans.json");

  fs.writeFileSync(sourcePath, [
    "货号,齐色主附图完成时间,A+完成时间,视频完成时间",
    "SKU-1,2026-07-01,2026-07-02,2026-07-03",
  ].join("\n"), "utf8");
  fs.writeFileSync(targetPath, [
    "货号,齐色主附图完成时间,A+完成时间,视频完成时间",
    "SKU-1,,,",
  ].join("\n"), "utf8");
  writeTestPlanConfig(configPath, sourcePath, targetPath);

  const server = await startTestServer(dataDir, configPath, sourcePath, targetPath);

  try {
    const health = await fetch(`${server.baseUrl}/healthz`).then((res) => res.json());
    const config = await fetch(`${server.baseUrl}/api/config`).then((res) => res.json());
    const status = await fetch(`${server.baseUrl}/api/status`).then((res) => res.json());
    const home = await fetch(`${server.baseUrl}/api/dingtalk/home-card`).then((res) => res.json());
    const help = await fetch(`${server.baseUrl}/api/dingtalk/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventId: "evt-help",
        senderStaffId: "admin",
        senderNick: "管理员",
        chatId: "chat-1",
        text: "同步帮助",
      }),
    }).then((res) => res.json());
    const recent = await fetch(`${server.baseUrl}/api/dingtalk/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventId: "evt-recent",
        senderStaffId: "admin",
        senderNick: "管理员",
        chatId: "chat-1",
        text: "最近同步记录",
      }),
    }).then((res) => res.json());

    assert.equal(health.ok, true);
    assert.equal(config.ok, true);
    assert.equal(config.config.jobCount, 1);
    assert.equal(config.config.syncJobs[0].keyMapping.sourceColumn, "A");
    assert.equal(config.config.syncJobs[0].keyMapping.targetColumn, "A");
    assert.equal(config.config.syncJobs[0].fieldMappings.length, 3);
    assert.equal(config.config.syncJobs[0].fieldMappings[0].sourceHeader, "齐色主附图完成时间");
    assert.equal(config.config.syncJobs[0].fieldMappings[0].targetColumn, "B");
    assert.equal(status.ok, true);
    assert.equal(status.plan.planId, "test_plan");
    assert.equal(home.ok, true);
    assert.equal(home.card.actions.length, 2);
    assert.equal(help.command, "help");
    assert.match(help.reply.text, /欢迎使用总表同步机器人/);
    assert.equal(recent.command, "recent_runs");
    assert.match(recent.reply.text, /暂无同步记录/);
  } finally {
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("internal sync rereads updated source data on every execute", async () => {
  const rootDir = path.resolve(__dirname, "..");
  const dataDir = fs.mkdtempSync(path.join(rootDir, "runtime", "app-refresh-test-"));
  const sourcePath = path.join(dataDir, "source.csv");
  const targetPath = path.join(dataDir, "target.csv");
  const configPath = path.join(dataDir, "sync-plans.json");

  fs.writeFileSync(sourcePath, [
    "璐у彿,榻愯壊涓婚檮鍥惧畬鎴愭椂闂?A+瀹屾垚鏃堕棿,瑙嗛瀹屾垚鏃堕棿",
    "SKU-1,2026-07-01,,",
  ].join("\n"), "utf8");
  fs.writeFileSync(targetPath, [
    "璐у彿,榻愯壊涓婚檮鍥惧畬鎴愭椂闂?A+瀹屾垚鏃堕棿,瑙嗛瀹屾垚鏃堕棿",
    "SKU-1,old-a,old-b,old-c",
  ].join("\n"), "utf8");
  writeTestPlanConfig(configPath, sourcePath, targetPath);

  const server = await startTestServer(dataDir, configPath, sourcePath, targetPath);

  try {
    const firstRun = await fetch(`${server.baseUrl}/api/internal/sync-plans/test_plan/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ triggerType: "manual", dryRun: false }),
    }).then((res) => res.json());

    assert.equal(firstRun.ok, true);
    assert.equal(firstRun.result.status, "succeeded");
    assert.equal(fs.readFileSync(targetPath, "utf8").includes("SKU-1,2026-07-01,,"), true);

    fs.writeFileSync(sourcePath, [
      "璐у彿,榻愯壊涓婚檮鍥惧畬鎴愭椂闂?A+瀹屾垚鏃堕棿,瑙嗛瀹屾垚鏃堕棿",
      "SKU-1,2026-08-02,owner-A,status-1",
    ].join("\n"), "utf8");

    const secondRun = await fetch(`${server.baseUrl}/api/internal/sync-plans/test_plan/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ triggerType: "manual", dryRun: false }),
    }).then((res) => res.json());

    assert.equal(secondRun.ok, true);
    assert.equal(secondRun.result.status, "succeeded");
    assert.equal(fs.readFileSync(targetPath, "utf8").includes("SKU-1,2026-08-02,owner-A,status-1"), true);
  } finally {
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
