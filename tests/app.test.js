const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildServices, createServer } = require("../src/app");

const HEADERS = "货号,齐色主附图完成时间,A+完成时间,视频完成时间";

function writeTestPlanConfig(filePath, sourcePath, targetPath) {
  const plan = {
    plans: [
      {
        planId: "test_plan",
        name: "测试同步",
        enabled: true,
        rules: {
          keyColumn: "货号",
          fields: ["齐色主附图完成时间", "A+完成时间", "视频完成时间"],
          placeholderValues: ["/"],
        },
        target: {
          node: "master-node",
          sheet: "Sheet1",
          mockCsvPath: targetPath,
          sheetId: "master-sheet",
          keyColumn: { column: "A", header: "货号" },
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
            keyColumn: { column: "A", header: "货号" },
            fields: {
              "齐色主附图完成时间": { sourceHeader: "齐色主附图完成时间" },
              "A+完成时间": { sourceHeader: "A+完成时间" },
              "视频完成时间": { sourceHeader: "视频完成时间" },
            },
          },
        ],
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
    dataDir,
    syncPlansPath: configPath,
    provider: "mock",
    dwsConfigDir: path.join(rootDir, "..", "dws-config"),
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

test("web endpoints expose the manual sync plan and bot endpoints are absent", async () => {
  const rootDir = path.resolve(__dirname, "..");
  const dataDir = fs.mkdtempSync(path.join(rootDir, "runtime", "app-test-"));
  const sourcePath = path.join(dataDir, "source.csv");
  const targetPath = path.join(dataDir, "target.csv");
  const configPath = path.join(dataDir, "sync-plans.json");

  fs.writeFileSync(sourcePath, `${HEADERS}\nSKU-1,2026-07-01,2026-07-02,2026-07-03`, "utf8");
  fs.writeFileSync(targetPath, `${HEADERS}\nSKU-1,,,`, "utf8");
  writeTestPlanConfig(configPath, sourcePath, targetPath);

  const server = await startTestServer(dataDir, configPath, sourcePath, targetPath);

  try {
    const health = await fetch(`${server.baseUrl}/healthz`).then((res) => res.json());
    const config = await fetch(`${server.baseUrl}/api/config`).then((res) => res.json());
    const status = await fetch(`${server.baseUrl}/api/status`).then((res) => res.json());
    const page = await fetch(`${server.baseUrl}/`).then((res) => res.text());
    const clientScript = await fetch(`${server.baseUrl}/app.js`).then((res) => res.text());
    const botResponse = await fetch(`${server.baseUrl}/api/dingtalk/home-card`);

    assert.equal(health.ok, true);
    assert.equal(config.ok, true);
    assert.equal(config.config.jobCount, 1);
    assert.equal(config.config.syncJobs[0].keyMapping.sourceColumn, "A");
    assert.equal(config.config.syncJobs[0].fieldMappings.length, 3);
    assert.equal(config.config.syncJobs[0].fieldMappings[0].targetColumn, "B");
    assert.equal(status.ok, true);
    assert.equal(status.plan.planId, "test_plan");
    assert.match(page, /视觉页面中心多表同步/);
    assert.match(page, /id="syncButton"/);
    assert.match(page, /id="configDialog"/);
    assert.match(page, /id="conflictDialog"/);
    assert.match(page, /id="failureDialog"/);
    assert.doesNotMatch(page, /预览同步|dryRunButton|测试按钮/);
    assert.match(clientScript, /sheet_08[\s\S]*分表⑦TK上架对接表（新）/);
    assert.match(clientScript, /同步失败分表/);
    assert.match(clientScript, /点击查看失败原因/);
    assert.match(clientScript, /点击查看冲突货号/);
    assert.equal(botResponse.status, 404);
  } finally {
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("status endpoint exposes progress while a manual sync is running", async () => {
  const plan = {
    planId: "progress_plan",
    name: "进度测试",
    enabled: true,
    rules: { keyColumn: "货号", fields: [] },
    target: {
      node: "master-node",
      sheet: "Sheet1",
      keyColumn: { column: "A", header: "货号" },
      columns: {},
    },
    jobs: [],
  };
  let releaseRun;
  let reportReady;
  const runGate = new Promise((resolve) => {
    releaseRun = resolve;
  });
  const progressGate = new Promise((resolve) => {
    reportReady = resolve;
  });
  const completedRun = {
    planId: plan.planId,
    status: "succeeded",
    startedAt: "2026-07-28T01:00:00.000Z",
    finishedAt: "2026-07-28T01:00:01.000Z",
    durationMs: 1000,
    summary: {
      successfulJobs: 0,
      totalJobs: 0,
      changedRows: 0,
      changedCells: 0,
      missingInTargetKeys: 0,
      conflictedKeys: 0,
    },
  };
  const services = {
    env: { provider: "mock" },
    planRepo: {
      getDefaultPlan: () => plan,
      getPlan: () => plan,
    },
    runRepo: { getLastByPlan: () => null },
    syncService: {
      runManual: async (_planId, _trigger, options) => {
        options.onProgress({
          progress: 80,
          phase: "数据汇总完成",
          completedSteps: 4,
          totalSteps: 5,
        });
        reportReady();
        await runGate;
        return completedRun;
      },
    },
  };
  const server = createServer(services);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const syncResponse = fetch(`${baseUrl}/api/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: false }),
    }).then((response) => response.json());

    await progressGate;
    const status = await fetch(`${baseUrl}/api/status`).then((response) => response.json());

    assert.equal(status.currentRun.status, "running");
    assert.equal(status.currentRun.progress, 80);
    assert.equal(status.currentRun.phase, "数据汇总完成");

    releaseRun();
    const result = await syncResponse;
    assert.equal(result.ok, true);
    assert.deepEqual(result.result, completedRun);
  } finally {
    releaseRun();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("each manual web sync rereads the source and copies blank fields", async () => {
  const rootDir = path.resolve(__dirname, "..");
  const dataDir = fs.mkdtempSync(path.join(rootDir, "runtime", "app-refresh-test-"));
  const sourcePath = path.join(dataDir, "source.csv");
  const targetPath = path.join(dataDir, "target.csv");
  const configPath = path.join(dataDir, "sync-plans.json");

  fs.writeFileSync(sourcePath, `${HEADERS}\nSKU-1,2026-07-01,,`, "utf8");
  fs.writeFileSync(targetPath, `${HEADERS}\nSKU-1,old-a,old-b,old-c`, "utf8");
  writeTestPlanConfig(configPath, sourcePath, targetPath);

  const server = await startTestServer(dataDir, configPath, sourcePath, targetPath);

  try {
    const firstRun = await fetch(`${server.baseUrl}/api/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: false }),
    }).then((res) => res.json());

    assert.equal(firstRun.ok, true);
    assert.equal(firstRun.result.status, "succeeded");
    assert.match(fs.readFileSync(targetPath, "utf8"), /SKU-1,2026-07-01,,/);

    fs.writeFileSync(sourcePath, `${HEADERS}\nSKU-1,2026-08-02,owner-A,status-1`, "utf8");

    const secondRun = await fetch(`${server.baseUrl}/api/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: false }),
    }).then((res) => res.json());

    assert.equal(secondRun.ok, true);
    assert.equal(secondRun.result.status, "succeeded");
    assert.match(fs.readFileSync(targetPath, "utf8"), /SKU-1,2026-08-02,owner-A,status-1/);
  } finally {
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
