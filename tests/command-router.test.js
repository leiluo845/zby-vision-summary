const test = require("node:test");
const assert = require("node:assert/strict");
const { routeCommand } = require("../src/bot/command-router");

test("routeCommand recognizes manual sync aliases", () => {
  assert.deepEqual(routeCommand("手动同步"), { intent: "manual_sync", dryRun: false });
  assert.deepEqual(routeCommand("同步表格"), { intent: "manual_sync", dryRun: false });
  assert.deepEqual(routeCommand("预览同步"), { intent: "manual_sync", dryRun: true });
});

test("routeCommand recognizes recent runs and confirmation replies", () => {
  assert.deepEqual(routeCommand("最近同步记录"), { intent: "recent_runs" });
  assert.deepEqual(routeCommand("是"), { intent: "confirm_yes" });
  assert.deepEqual(routeCommand("否"), { intent: "confirm_no" });
});

test("routeCommand falls back to helpable states", () => {
  assert.deepEqual(routeCommand(""), { intent: "home" });
  assert.deepEqual(routeCommand("同步帮助"), { intent: "help" });
  assert.deepEqual(routeCommand("随便写点"), { intent: "unknown", rawText: "随便写点" });
});
