const test = require("node:test");
const assert = require("node:assert/strict");
const { LockService } = require("../src/jobs/lock-service");
const { SyncService, buildConflictDetails } = require("../src/sync/sync-service");

function createPlan() {
  const fields = ["齐色主附图完成时间", "A+完成时间", "视频完成时间"];
  return {
    planId: "progress_plan",
    name: "进度测试",
    enabled: true,
    rules: {
      keyColumn: "货号",
      fields,
      placeholderValues: ["/"],
    },
    target: {
      keyColumn: { column: "A", header: "货号" },
      columns: {
        [fields[0]]: { column: "B", header: fields[0] },
        [fields[1]]: { column: "C", header: fields[1] },
        [fields[2]]: { column: "D", header: fields[2] },
      },
    },
    jobs: [1, 2].map((number) => ({
      id: `job-${number}`,
      label: `分表${number}`,
      keyColumn: { column: "A", header: "货号" },
      fields: {
        [fields[0]]: { column: "B", sourceHeader: fields[0] },
        [fields[1]]: { column: "C", sourceHeader: fields[1] },
        [fields[2]]: { column: "D", sourceHeader: fields[2] },
      },
    })),
  };
}

test("SyncService reports real step progress through reading, aggregation, and writing", async () => {
  const plan = createPlan();
  const headers = ["货号", ...plan.rules.fields];
  const progressStates = [];
  const appendedRuns = [];
  let writeCount = 0;

  const service = new SyncService({
    planRepo: { getPlan: () => plan },
    runRepo: { append: (run) => appendedRuns.push(run) },
    lockService: new LockService(),
    sheetClient: {
      readTarget: async () => ({
        rows: [headers, ["SKU-1", "旧值", "旧值", "旧值"]],
        meta: null,
      }),
      readSource: async () => ({
        rows: [headers, ["SKU-1", "2026-07-01", "", "/"]],
        meta: null,
      }),
      applyChanges: async () => {
        writeCount += 1;
        return { written: true };
      },
    },
    yieldControl: async () => {},
  });

  const run = await service.runManual("progress_plan", {}, {
    dryRun: false,
    onProgress: (state) => progressStates.push(state),
  });

  assert.deepEqual(
    progressStates.map((state) => state.progress),
    [20, 40, 60, 80, 80, 100],
  );
  assert.deepEqual(
    progressStates.map((state) => state.phase),
    [
      "总表读取完成",
      "分表读取完成 1/2",
      "分表读取完成 2/2",
      "数据汇总完成",
      "正在写入总表",
      "同步完成",
    ],
  );
  assert.equal(writeCount, 1);
  assert.equal(run.summary.changedRows, 1);
  assert.equal(run.summary.changedCells, 3);
  assert.equal(appendedRuns.length, 1);
});

test("buildConflictDetails lists every involved sheet once for each conflicted SKU", () => {
  const conflicts = buildConflictDetails([
    {
      key: "SKU-1",
      reasons: [
        {
          type: "conflict",
          sources: [
            { jobId: "job-1", jobLabel: "分表一" },
            { jobId: "job-2", jobLabel: "分表二" },
          ],
        },
        {
          type: "conflict",
          sources: [
            { jobId: "job-2", jobLabel: "分表二" },
            { jobId: "job-3", jobLabel: "分表三" },
          ],
        },
      ],
    },
    {
      key: "SKU-2",
      reasons: [{ type: "missing_in_target" }],
    },
  ]);

  assert.deepEqual(conflicts, [
    {
      key: "SKU-1",
      sources: [
        { jobId: "job-1", jobLabel: "分表一" },
        { jobId: "job-2", jobLabel: "分表二" },
        { jobId: "job-3", jobLabel: "分表三" },
      ],
    },
  ]);
});
