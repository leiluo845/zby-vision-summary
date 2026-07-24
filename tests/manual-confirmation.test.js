const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildServices, createServer } = require("../src/app");

function writeTestPlanConfig(filePath, sourcePath, targetPath) {
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
          allowEmptyOverwrite: true,
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
      },
    ],
  };

  fs.writeFileSync(filePath, JSON.stringify(plan, null, 2), "utf8");
}

async function postJson(baseUrl, pathname, payload) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.json();
}

test("manual sync enters blank confirmation flow and continues after yes", async () => {
  const rootDir = path.resolve(__dirname, "..");
  const dataDir = fs.mkdtempSync(path.join(rootDir, "runtime", "confirm-test-"));
  const sourcePath = path.join(dataDir, "source.csv");
  const targetPath = path.join(dataDir, "target.csv");
  const configPath = path.join(dataDir, "sync-plans.json");

  fs.writeFileSync(sourcePath, [
    "货号,齐色主附图完成时间,A+完成时间,视频完成时间",
    "SKU-1,2026-07-01,2026-07-02,",
    "SKU-2,,2026-07-03,2026-07-04",
  ].join("\n"), "utf8");
  fs.writeFileSync(targetPath, [
    "货号,齐色主附图完成时间,A+完成时间,视频完成时间",
    "SKU-1,,old-a,old-v",
    "SKU-2,keep,,",
  ].join("\n"), "utf8");
  writeTestPlanConfig(configPath, sourcePath, targetPath);

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
  const baseUrl = `http://${env.host}:${address.port}`;

  try {
    const firstReply = await postJson(baseUrl, "/api/dingtalk/callback", {
      eventId: "evt-manual",
      senderStaffId: "admin",
      senderNick: "管理员",
      chatId: "chat-1",
      text: "手动同步",
    });
    const secondReply = await postJson(baseUrl, "/api/dingtalk/callback", {
      eventId: "evt-confirm",
      senderStaffId: "admin",
      senderNick: "管理员",
      chatId: "chat-1",
      text: "是",
    });

    assert.equal(firstReply.command, "manual_sync");
    assert.equal(firstReply.result.status, "pending_confirmation");
    assert.match(firstReply.reply.text, /是否仍要同步/);
    assert.equal(secondReply.command, "confirm_yes");
    assert.equal(secondReply.result.status, "succeeded");
    assert.match(secondReply.reply.text, /同步完成|定时同步完成/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
