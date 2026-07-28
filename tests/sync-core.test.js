const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildAggregatedSyncResult,
} = require("../src/sync/core");
const {
  DwsSheetClient,
  buildChangedBlockCsv,
  buildChangedBlocks,
  assertWriteTargetAllowed,
  buildColumnRange,
  buildSingleCellWrites,
  buildSingleRowRangeUpdate,
  extractCsvRows,
  getSheetReadRowLimit,
} = require("../src/dingtalk/sheet-client");

function createPlan(overrides = {}) {
  return {
    planId: "test_plan",
    rules: {
      keyColumn: "货号",
      fields: ["齐色主附图完成时间", "A+完成时间", "视频完成时间"],
      placeholderValues: ["/"],
      ...(overrides.rules || {}),
    },
    target: {
      node: "master-node",
      sheet: "Sheet1",
      sheetId: "master-sheet",
      columns: {
        "齐色主附图完成时间": { column: "B", header: "齐色主附图完成时间" },
        "A+完成时间": { column: "C", header: "A+完成时间" },
        "视频完成时间": { column: "D", header: "视频完成时间" },
      },
      writeGuard: {
        nodeId: "master-node",
        sheetId: "master-sheet",
      },
      ...(overrides.target || {}),
    },
    jobs: overrides.jobs || [],
  };
}

test("buildAggregatedSyncResult keeps the first row for duplicate SKUs inside one sheet", () => {
  const plan = createPlan();
  const targetRows = [
    ["货号", "齐色主附图完成时间", "A+完成时间", "视频完成时间"],
    ["SKU-1", "", "", ""],
  ];
  const sourceJobs = [
    {
      job: {
        id: "job-1",
        label: "分表一",
        fields: {},
      },
      rows: [
        ["货号", "齐色主附图完成时间", "A+完成时间", "视频完成时间"],
        ["SKU-1", "2026-07-01", "2026-07-02", ""],
        ["SKU-1", "2026-07-05", "2026-07-06", "2026-07-07"],
      ],
    },
  ];

  const result = buildAggregatedSyncResult(targetRows, sourceJobs, plan, { dryRun: true });

  assert.equal(result.report.stats.failedKeys, 0);
  assert.equal(result.report.stats.changedCells, 2);
  assert.equal(result.rowWrites.length, 1);
  assert.equal(result.rowWrites[0].changes[0].source.sourceRow, 2);
  assert.equal(result.updatedTargetRows[1][1], "2026-07-01");
  assert.equal(result.updatedTargetRows[1][2], "2026-07-02");
  assert.equal(result.updatedTargetRows[1][3], "");
});

test("buildAggregatedSyncResult keeps the first matching sheet when the same SKU exists in multiple sheets and values match", () => {
  const plan = createPlan();
  const targetRows = [
    ["货号", "齐色主附图完成时间", "A+完成时间", "视频完成时间"],
    ["SKU-1", "", "", ""],
  ];
  const sourceJobs = [
    {
      job: {
        id: "job-1",
        label: "分表一",
        fields: {},
      },
      rows: [
        ["货号", "齐色主附图完成时间", "A+完成时间", "视频完成时间"],
        ["SKU-1", "2026-07-01", "", ""],
      ],
    },
    {
      job: {
        id: "job-2",
        label: "分表二",
        fields: {},
      },
      rows: [
        ["货号", "齐色主附图完成时间", "A+完成时间", "视频完成时间"],
        ["SKU-1", "2026-07-01", "", ""],
      ],
    },
  ];

  const result = buildAggregatedSyncResult(targetRows, sourceJobs, plan, { dryRun: true });

  assert.equal(result.report.stats.failedKeys, 0);
  assert.equal(result.report.stats.changedCells, 1);
  assert.equal(result.rowWrites.length, 1);
  assert.equal(result.rowWrites[0].changes[0].source.jobLabel, "分表一");
  assert.equal(result.updatedTargetRows[1][1], "2026-07-01");
  assert.equal(result.updatedTargetRows[1][2], "");
  assert.equal(result.updatedTargetRows[1][3], "");
});

test("buildAggregatedSyncResult marks conflicting non-empty dates across sheets as failed", () => {
  const plan = createPlan();
  const targetRows = [
    ["货号", "齐色主附图完成时间", "A+完成时间", "视频完成时间"],
    ["SKU-1", "", "", ""],
  ];
  const sourceJobs = [
    {
      job: {
        id: "job-1",
        label: "分表一",
        fields: {},
      },
      rows: [
        ["货号", "齐色主附图完成时间", "A+完成时间", "视频完成时间"],
        ["SKU-1", "2026-07-01", "", ""],
      ],
    },
    {
      job: {
        id: "job-2",
        label: "分表二",
        fields: {},
      },
      rows: [
        ["货号", "齐色主附图完成时间", "A+完成时间", "视频完成时间"],
        ["SKU-1", "2026-07-09", "", ""],
      ],
    },
    {
      job: {
        id: "job-3",
        label: "分表三",
        fields: {},
      },
      rows: [
        ["货号", "齐色主附图完成时间", "A+完成时间", "视频完成时间"],
        ["SKU-1", "2026-07-01", "", ""],
      ],
    },
  ];

  const result = buildAggregatedSyncResult(targetRows, sourceJobs, plan, { dryRun: true });

  assert.equal(result.report.stats.failedKeys, 1);
  assert.equal(result.report.stats.conflictedKeys, 1);
  assert.equal(result.rowWrites.length, 0);
  assert.equal(result.updatedTargetRows[1][1], "");
  assert.equal(result.failures[0].reasons[0].type, "conflict");
  assert.deepEqual(
    result.failures[0].reasons[0].sources.map((item) => ({ jobLabel: item.jobLabel, row: item.row, value: item.value })),
    [
      { jobLabel: "分表一", row: 2, value: "2026-07-01" },
      { jobLabel: "分表二", row: 2, value: "2026-07-09" },
      { jobLabel: "分表三", row: 2, value: "2026-07-01" },
    ],
  );
});

test("assertWriteTargetAllowed blocks writes outside the master allowlist", () => {
  const plan = createPlan({
    target: {
      node: "branch-node",
      sheetId: "branch-sheet",
      writeGuard: {
        nodeId: "master-node",
        sheetId: "master-sheet",
      },
    },
  });

  assert.throws(
    () => assertWriteTargetAllowed(plan, "branch-sheet"),
    /写入护栏已拦截/,
  );
});

test("sheet column reads use an explicit bounded A1 range", () => {
  assert.equal(getSheetReadRowLimit({ rowCount: 2700, nonEmptyRange: { lastRow: 2680 } }), 2680);
  assert.equal(getSheetReadRowLimit({ rowCount: 0, nonEmptyRange: { lastRow: 2680 } }), 2680);
  assert.equal(buildColumnRange("B", 2700), "B1:B2700");
});

test("buildChangedBlocks splits separated row writes into smaller csv-put blocks", () => {
  const updatedTargetRows = [
    ["璐у彿", "B"],
    ["SKU-1", "2026-07-01"],
    ["SKU-2", "2026-07-02"],
    ["SKU-3", "2026-07-03"],
    ["SKU-4", "2026-07-04"],
  ];
  const rowWrites = [
    { rowIndex: 1 },
    { rowIndex: 3 },
  ];
  const blocks = buildChangedBlocks(updatedTargetRows, rowWrites, {
    fieldA: { column: "B" },
  }, {
    maxChangedRowsPerBlock: 1,
    maxRowSpanPerBlock: 2,
    maxGap: 0,
  });

  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].startCell, "B2");
  assert.equal(blocks[1].startCell, "B4");
});

test("buildChangedBlockCsv keeps explicit blank values aligned with target columns", () => {
  const updatedTargetRows = [
    ["货号", "齐色主附图完成时间", "A+完成时间", "视频完成时间"],
    ["SKU-1", "2026-07-01", "", "2026-07-03"],
  ];
  const rowWrites = [{ rowIndex: 1 }];
  const targetColumns = {
    "齐色主附图完成时间": { column: "C" },
    "A+完成时间": { column: "D" },
    "视频完成时间": { column: "E" },
  };

  const block = buildChangedBlockCsv(
    updatedTargetRows,
    rowWrites,
    targetColumns,
    ["齐色主附图完成时间", "A+完成时间", "视频完成时间"],
  );

  assert.equal(block.startCell, "C2");
  assert.equal(block.range, "C2:E2");
  assert.equal(block.csv, "2026-07-01,,2026-07-03");
});

test("single-row timeout fallback narrows writes to the target row and changed fields", () => {
  const rowWrite = {
    rowIndex: 1,
    rowNumber: 2,
    afterValues: {
      fieldA: "2026-07-01",
      fieldB: "",
      fieldC: "2026-07-03",
    },
    changes: [
      { field: "fieldA", newValue: "2026-07-01" },
      { field: "fieldB", newValue: "" },
      { field: "fieldC", newValue: "2026-07-03" },
    ],
  };
  const targetColumns = {
    fieldA: { column: "B" },
    fieldB: { column: "C" },
    fieldC: { column: "D" },
  };

  const rowUpdate = buildSingleRowRangeUpdate(rowWrite, targetColumns, ["fieldA", "fieldB", "fieldC"]);
  const cellWrites = buildSingleCellWrites(rowWrite, targetColumns);

  assert.equal(rowUpdate.range, "B2:D2");
  assert.deepEqual(
    rowUpdate.values,
    [[
      { type: "text", text: "2026-07-01" },
      { type: "text", text: "" },
      { type: "text", text: "2026-07-03" },
    ]],
  );
  assert.deepEqual(
    cellWrites.map((item) => ({ field: item.field, cell: item.startCell, value: item.values[0][0].text })),
    [
      { field: "fieldA", cell: "B2", value: "2026-07-01" },
      { field: "fieldB", cell: "C2", value: "" },
      { field: "fieldC", cell: "D2", value: "2026-07-03" },
    ],
  );
});

test("buildAggregatedSyncResult reports actual configured target column letters", () => {
  const plan = createPlan();
  const targetRows = [
    ["货号", "齐色主附图完成时间", "A+完成时间", "视频完成时间"],
    ["SKU-1", "", "", ""],
  ];
  const sourceJobs = [
    {
      job: {
        id: "job-1",
        label: "分表一",
        fields: {},
      },
      rows: [
        ["货号", "齐色主附图完成时间", "A+完成时间", "视频完成时间"],
        ["SKU-1", "2026-07-01", "2026-07-02", "2026-07-03"],
      ],
    },
  ];

  const result = buildAggregatedSyncResult(targetRows, sourceJobs, plan, { dryRun: true });

  assert.deepEqual(
    result.changes.map((item) => item.targetColumnLetter),
    ["B", "C", "D"],
  );
});

test("buildAggregatedSyncResult copies source values including blanks and leaves absent SKUs unchanged", () => {
  const plan = createPlan();
  const headers = [plan.rules.keyColumn, ...plan.rules.fields];
  const targetRows = [
    headers,
    ["SKU-1", "old-a", "old-b", "old-c"],
    ["SKU-2", "keep-a", "keep-b", "keep-c"],
    ["SKU-3", "stay-a", "stay-b", "stay-c"],
  ];
  const sourceJobs = [
    {
      job: {
        id: "job-1",
        label: "sheet-1",
        fields: {},
      },
      rows: [
        headers,
        ["SKU-1", "1899/12/30", "", "/"],
        ["SKU-2", "", "", ""],
      ],
    },
  ];

  const result = buildAggregatedSyncResult(targetRows, sourceJobs, plan, { dryRun: true });

  assert.equal(result.rowWrites.length, 2);
  assert.equal(result.changes.length, 6);
  assert.deepEqual(result.updatedTargetRows[1], ["SKU-1", "1899/12/30", "", "/"]);
  assert.deepEqual(result.updatedTargetRows[2], ["SKU-2", "", "", ""]);
  assert.deepEqual(result.updatedTargetRows[3], ["SKU-3", "stay-a", "stay-b", "stay-c"]);
});

test("buildAggregatedSyncResult treats blank and non-blank values across sheets as a conflict", () => {
  const plan = createPlan();
  const headers = [plan.rules.keyColumn, ...plan.rules.fields];
  const targetRows = [headers, ["SKU-1", "old-a", "old-b", "old-c"]];
  const sourceJobs = [
    {
      job: { id: "job-1", label: "sheet-1", fields: {} },
      rows: [headers, ["SKU-1", "", "same", "same"]],
    },
    {
      job: { id: "job-2", label: "sheet-2", fields: {} },
      rows: [headers, ["SKU-1", "2026-07-01", "same", "same"]],
    },
  ];

  const result = buildAggregatedSyncResult(targetRows, sourceJobs, plan, { dryRun: true });

  assert.equal(result.report.stats.conflictedKeys, 1);
  assert.equal(result.rowWrites.length, 0);
  assert.deepEqual(result.updatedTargetRows[1], ["SKU-1", "old-a", "old-b", "old-c"]);
});

test("extractCsvRows preserves blank rows from csv-get payloads", () => {
  const rows = extractCsvRows({
    csv: "[row=1] A\n[row=2] \n[row=3] C",
    rowIndices: [1, 2, 3],
  });

  assert.deepEqual(rows, [["A"], [""], ["C"]]);
});

test("DwsSheetClient reads only the non-empty row range and shrinks timed out chunks", () => {
  const client = new DwsSheetClient({
    env: {
      sheetReadChunkRows: 4,
      sheetReadMinChunkRows: 1,
      sheetReadRetryCount: 1,
      sheetReadRetryDelayMs: 0,
    },
  });
  const csvCalls = [];
  const rangeCalls = [];

  client.getSheetInfo = () => ({
    rowCount: 10,
    nonEmptyRange: { lastRow: 4 },
  });
  client.readColumnValuesViaCsv = (_node, _sheetId, range) => {
    csvCalls.push(range);
    if (range === "B1:B4") {
      throw new Error("HSFTimeOutException-HSF-0002 Timeout value is : 6000");
    }

    return {
      "B1:B2": ["SKU", "A"],
      "B3:B4": ["B", ""],
    }[range];
  };
  client.readColumnValuesViaRange = (_node, _sheetId, range) => {
    rangeCalls.push(range);
    if (range === "B1:B4") {
      throw new Error(`Empty sheet range response: ${range}`);
    }

    throw new Error(`unexpected range fallback: ${range}`);
  };

  const values = client.readColumnValues("node-1", "sheet-1", "B");

  assert.deepEqual(values, ["SKU", "A", "B", ""]);
  assert.deepEqual(csvCalls, ["B1:B4", "B1:B2", "B3:B4"]);
  assert.deepEqual(rangeCalls, ["B1:B4"]);
});

test("DwsSheetClient retries transient read timeouts before splitting or failing", () => {
  const client = new DwsSheetClient({
    env: {
      sheetReadChunkRows: 4,
      sheetReadMinChunkRows: 1,
      sheetReadRetryCount: 2,
      sheetReadRetryDelayMs: 0,
    },
  });
  const csvCalls = [];
  const rangeCalls = [];

  client.getSheetInfo = () => ({
    rowCount: 10,
    nonEmptyRange: { lastRow: 2 },
  });
  client.readColumnValuesViaCsv = (_node, _sheetId, range) => {
    csvCalls.push(range);
    if (csvCalls.length === 1) {
      throw new Error("HSFTimeOutException-HSF-0002 Timeout value is : 6000");
    }

    return ["SKU", "A"];
  };
  client.readColumnValuesViaRange = (_node, _sheetId, range) => {
    rangeCalls.push(range);
    throw new Error(`unexpected range fallback: ${range}`);
  };

  const values = client.readColumnValues("node-1", "sheet-1", "B");

  assert.deepEqual(values, ["SKU", "A"]);
  assert.deepEqual(csvCalls, ["B1:B2", "B1:B2"]);
  assert.deepEqual(rangeCalls, []);
});
