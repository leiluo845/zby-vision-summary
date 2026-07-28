const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const {
  DEFAULT_KEY_COLUMN,
  DEFAULT_SYNC_FIELDS,
  cloneRows,
  detectDelimiter,
  excelColumnName,
  parseCsv,
  writeCsv,
} = require("../sync/core");

function parseCsvFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  return parseCsv(text, detectDelimiter(text));
}

function unique(values) {
  return [...new Set(values.filter((value) => value != null && String(value).trim() !== ""))];
}

function normalizeHeader(value) {
  return String(value ?? "").trim();
}

function normalizeLookupToken(value) {
  return String(value ?? "").trim().toLowerCase();
}

function pickFirstArray(values) {
  return values.find((value) => Array.isArray(value));
}

function pickFirstNonEmptyString(values) {
  return values.find((value) => typeof value === "string" && value.trim() !== "") || "";
}

function getSheetReadRowLimit(sheetInfo) {
  const nonEmptyLastRow = Number(sheetInfo?.nonEmptyRange?.lastRow || 0);
  const rowCount = Number(sheetInfo?.rowCount || 0);
  return Math.max(nonEmptyLastRow || rowCount || 0, 1);
}

function buildColumnRange(columnLetter, rowLimit) {
  return `${columnLetter}1:${columnLetter}${Math.max(1, Number(rowLimit || 1))}`;
}

function buildColumnRangeForRows(columnLetter, startRow, endRow) {
  const safeStart = Math.max(1, Number(startRow || 1));
  const safeEnd = Math.max(safeStart, Number(endRow || safeStart));
  return `${columnLetter}${safeStart}:${columnLetter}${safeEnd}`;
}

function columnNameToIndex(columnLetter) {
  const text = String(columnLetter || "").trim().toUpperCase();
  let value = 0;

  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 65 || code > 90) {
      continue;
    }
    value = (value * 26) + (code - 64);
  }

  return Math.max(0, value - 1);
}

function buildTargetFieldSpecs(targetColumns, targetFields = Object.keys(targetColumns || {})) {
  return (targetFields || [])
    .map((field, index) => {
      const columnLetter = targetColumns?.[field]?.column;
      if (!columnLetter) {
        return null;
      }

      return {
        field,
        compactIndex: index + 1,
        columnLetter,
        columnIndex: columnNameToIndex(columnLetter),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.columnIndex - right.columnIndex);
}

function getCompactRowFieldValue(row, fieldSpec) {
  if (!Array.isArray(row) || !fieldSpec) {
    return "";
  }

  return row[fieldSpec.compactIndex] ?? "";
}

function extractRangeValues(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  const values = pickFirstArray([
    payload?.values,
    payload?.result?.values,
    payload?.data?.values,
  ]);
  if (values) {
    return values;
  }

  const cells = pickFirstArray([
    payload?.cells,
    payload?.result?.cells,
    payload?.data?.cells,
  ]);
  if (cells) {
    return cells.map((row) => row.map((cell) => {
      if (cell && typeof cell === "object") {
        return cell.value ?? "";
      }
      return cell ?? "";
    }));
  }

  return [];
}

function buildChangedBlockCsv(updatedTargetRows, rowWrites, targetColumns, targetFields) {
  const changedRowIndices = [...new Set((rowWrites || []).map((item) => item.rowIndex))]
    .sort((left, right) => left - right);

  if (changedRowIndices.length === 0) {
    return null;
  }

  const targetFieldSpecs = buildTargetFieldSpecs(targetColumns, targetFields);
  const columnIndices = targetFieldSpecs
    .map((spec) => spec.columnIndex)
    .filter((index) => Number.isFinite(index) && index >= 0);

  if (columnIndices.length === 0) {
    return null;
  }

  const minCol = Math.min(...columnIndices);
  const maxCol = Math.max(...columnIndices);
  const width = maxCol - minCol + 1;
  const firstRowIndex = changedRowIndices[0];
  const lastRowIndex = changedRowIndices[changedRowIndices.length - 1];
  const rows = [];

  for (let rowIndex = firstRowIndex; rowIndex <= lastRowIndex; rowIndex += 1) {
    const compactRow = updatedTargetRows[rowIndex] || [];
    const row = Array.from({ length: width }, () => "");

    for (const fieldSpec of targetFieldSpecs) {
      row[fieldSpec.columnIndex - minCol] = getCompactRowFieldValue(compactRow, fieldSpec);
    }

    rows.push(row);
  }

  if (rows.length === 0) {
    return null;
  }

  const startColumnLetter = excelColumnName(minCol);
  const endColumnLetter = excelColumnName(maxCol);

  return {
    csv: writeCsv(rows, ","),
    startCell: `${startColumnLetter}${firstRowIndex + 1}`,
    range: `${startColumnLetter}${firstRowIndex + 1}:${endColumnLetter}${lastRowIndex + 1}`,
    rowSpan: rows.length,
    columnSpan: width,
    firstRow: firstRowIndex,
    lastRow: lastRowIndex,
    minCol,
    maxCol,
  };
}

function createChangedBlock(updatedTargetRows, rowWrites, targetColumns, targetFields) {
  const block = buildChangedBlockCsv(updatedTargetRows, rowWrites, targetColumns, targetFields);
  if (!block) {
    return null;
  }

  return {
    ...block,
    rowWrites: [...rowWrites],
    changedRowCount: rowWrites.length,
  };
}

function buildChangedBlocks(updatedTargetRows, rowWrites, targetColumns, options = {}, targetFields) {
  const maxChangedRowsPerBlock = Math.max(1, Number(options.maxChangedRowsPerBlock || 30));
  const maxRowSpanPerBlock = Math.max(1, Number(options.maxRowSpanPerBlock || 40));
  const maxGap = Math.max(0, Number(options.maxGap ?? 3));
  const sortedWrites = [...new Map(
    [...(rowWrites || [])]
      .sort((left, right) => left.rowIndex - right.rowIndex)
      .map((item) => [item.rowIndex, item]),
  ).values()];

  if (sortedWrites.length === 0) {
    return [];
  }

  const blocks = [];
  let chunk = [];

  const pushChunk = () => {
    if (chunk.length === 0) {
      return;
    }

    const block = createChangedBlock(updatedTargetRows, chunk, targetColumns, targetFields);
    if (block) {
      blocks.push(block);
    }
    chunk = [];
  };

  for (const rowWrite of sortedWrites) {
    if (chunk.length === 0) {
      chunk.push(rowWrite);
      continue;
    }

    const firstRowIndex = chunk[0].rowIndex;
    const lastRowIndex = chunk[chunk.length - 1].rowIndex;
    const rowGap = rowWrite.rowIndex - lastRowIndex;
    const nextChangedRowCount = chunk.length + 1;
    const nextRowSpan = rowWrite.rowIndex - firstRowIndex + 1;

    if (
      rowGap > maxGap
      || nextChangedRowCount > maxChangedRowsPerBlock
      || nextRowSpan > maxRowSpanPerBlock
    ) {
      pushChunk();
    }

    chunk.push(rowWrite);
  }

  pushChunk();
  return blocks;
}

function splitChangedBlock(updatedTargetRows, block, targetColumns, targetFields) {
  const rowWrites = block?.rowWrites || [];
  if (rowWrites.length <= 1) {
    return [];
  }

  const middle = Math.ceil(rowWrites.length / 2);
  return [
    createChangedBlock(updatedTargetRows, rowWrites.slice(0, middle), targetColumns, targetFields),
    createChangedBlock(updatedTargetRows, rowWrites.slice(middle), targetColumns, targetFields),
  ].filter(Boolean);
}

function isTimeoutError(error) {
  const message = error instanceof Error ? `${error.message}\n${error.stack || ""}` : String(error || "");
  return /HSFTimeOutException|already timeout|Timeout value is : 6000/i.test(message);
}

function isRetriableReadError(error) {
  const message = error instanceof Error ? `${error.message}\n${error.stack || ""}` : String(error || "");
  return isTimeoutError(error) || /model\.operate\.block|empty sheet (csv|range) response/i.test(message);
}

function normalizeColumnValues(values, expectedRowCount) {
  const normalized = Array.isArray(values)
    ? values.map((value) => (value == null ? "" : String(value)))
    : [];

  if (!Number.isFinite(Number(expectedRowCount)) || expectedRowCount <= 0) {
    return normalized;
  }

  const size = Number(expectedRowCount);
  if (normalized.length === size) {
    return normalized;
  }

  if (normalized.length > size) {
    return normalized.slice(0, size);
  }

  return normalized.concat(Array.from({ length: size - normalized.length }, () => ""));
}

function sleepSync(delayMs) {
  const timeout = Math.max(0, Number(delayMs || 0));
  if (timeout <= 0) {
    return;
  }

  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, timeout);
}

function runWithRetry(work, options = {}) {
  const attempts = Math.max(1, Number(options.attempts || 1));
  const baseDelayMs = Math.max(0, Number(options.baseDelayMs || 0));
  const shouldRetry = typeof options.shouldRetry === "function"
    ? options.shouldRetry
    : () => false;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return work(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !shouldRetry(error)) {
        throw error;
      }
      sleepSync(baseDelayMs * attempt);
    }
  }

  throw lastError;
}

function writeSheetRange(node, sheetId, range, values, dwsConfigDir) {
  return execDws(
    [
      "sheet",
      "range",
      "update",
      "--node",
      node,
      "--sheet-id",
      sheetId,
      "--range",
      range,
      "--values",
      JSON.stringify(values),
      "--format",
      "json",
    ],
    dwsConfigDir,
  );
}

function writeSheetCsv(node, sheetId, csvText, startCell, dwsConfigDir, tempBaseDir) {
  const baseDir = tempBaseDir || process.cwd();
  fs.mkdirSync(baseDir, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(baseDir, "sheet-sync-"));
  const tempFile = path.join(tempDir, `chunk-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`);
  fs.writeFileSync(tempFile, csvText, "utf8");

  try {
    return execDws(
      [
        "sheet",
        "csv-put",
        "--node",
        node,
        "--sheet-id",
        sheetId,
        "--start-cell",
        startCell,
        "--csv",
        `@${tempFile}`,
        "--allow-overwrite",
        "--format",
        "json",
      ],
      dwsConfigDir,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function buildRowChangeColumnSpecs(rowWrite, targetColumns) {
  return (rowWrite?.changes || [])
    .map((change) => {
      const targetColumn = targetColumns?.[change.field]?.column;
      if (!targetColumn) {
        throw new Error(`Missing target column mapping for field: ${change.field}`);
      }

      return {
        change,
        columnLetter: targetColumn,
        columnIndex: columnNameToIndex(targetColumn),
      };
    })
    .sort((left, right) => left.columnIndex - right.columnIndex);
}

function buildSingleRowRangeUpdate(rowWrite, targetColumns, targetFields) {
  const targetFieldSpecs = buildTargetFieldSpecs(targetColumns, targetFields);
  const columnSpecs = buildRowChangeColumnSpecs(rowWrite, targetColumns);
  if (columnSpecs.length === 0) {
    return null;
  }

  const rowIndex = Number(rowWrite?.rowIndex ?? -1);
  const rowNumber = Number(rowWrite?.rowNumber || rowIndex + 1);
  const minCol = columnSpecs[0].columnIndex;
  const maxCol = columnSpecs[columnSpecs.length - 1].columnIndex;
  const startColumnLetter = excelColumnName(minCol);
  const endColumnLetter = excelColumnName(maxCol);
  const values = [[
    ...Array.from({ length: maxCol - minCol + 1 }, (_, offset) => {
      const fieldSpec = targetFieldSpecs.find((item) => item.columnIndex === minCol + offset);
      const value = fieldSpec ? rowWrite?.afterValues?.[fieldSpec.field] ?? "" : "";
      return buildTextCell(value);
    }),
  ]];

  return {
    strategy: "range-update-row",
    startCell: `${startColumnLetter}${rowNumber}`,
    range: `${startColumnLetter}${rowNumber}:${endColumnLetter}${rowNumber}`,
    rowSpan: 1,
    columnSpan: maxCol - minCol + 1,
    rowCount: 1,
    firstRow: rowIndex,
    lastRow: rowIndex,
    values,
  };
}

function buildSingleCellWrites(rowWrite, targetColumns) {
  const rowNumber = Number(rowWrite?.rowNumber || Number(rowWrite?.rowIndex ?? -1) + 1);

  return buildRowChangeColumnSpecs(rowWrite, targetColumns).map(({ change, columnLetter, columnIndex }) => ({
    strategy: "range-update-cell",
    field: change.field,
    startCell: `${columnLetter}${rowNumber}`,
    range: `${columnLetter}${rowNumber}:${columnLetter}${rowNumber}`,
    rowSpan: 1,
    columnSpan: 1,
    rowCount: 1,
    firstRow: Number(rowWrite?.rowIndex ?? rowNumber - 1),
    lastRow: Number(rowWrite?.rowIndex ?? rowNumber - 1),
    columnIndex,
    values: [[buildTextCell(change.newValue)]],
  }));
}

function writeSingleRowChanges(node, sheetId, rowWrite, targetColumns, dwsConfigDir, targetFields) {
  const rowUpdate = buildSingleRowRangeUpdate(rowWrite, targetColumns, targetFields);
  if (!rowUpdate) {
    return [];
  }

  try {
    const writeResult = writeSheetRange(node, sheetId, rowUpdate.range, rowUpdate.values, dwsConfigDir);
    return [{
      ...writeResult,
      strategy: rowUpdate.strategy,
      startCell: rowUpdate.startCell,
      range: rowUpdate.range,
      rowSpan: rowUpdate.rowSpan,
      columnSpan: rowUpdate.columnSpan,
      rowCount: rowUpdate.rowCount,
      firstRow: rowUpdate.firstRow,
      lastRow: rowUpdate.lastRow,
    }];
  } catch (error) {
    if (!isTimeoutError(error)) {
      throw error;
    }
  }

  return buildSingleCellWrites(rowWrite, targetColumns).map((cellWrite) => {
    const writeResult = writeSheetRange(node, sheetId, cellWrite.range, cellWrite.values, dwsConfigDir);
    return {
      ...writeResult,
      strategy: cellWrite.strategy,
      field: cellWrite.field,
      startCell: cellWrite.startCell,
      range: cellWrite.range,
      rowSpan: cellWrite.rowSpan,
      columnSpan: cellWrite.columnSpan,
      rowCount: cellWrite.rowCount,
      firstRow: cellWrite.firstRow,
      lastRow: cellWrite.lastRow,
    };
  });
}

function writeChunkedChangedBlocks(
  node,
  sheetId,
  updatedTargetRows,
  rowWrites,
  targetColumns,
  dwsConfigDir,
  tempBaseDir,
  targetFields,
) {
  const pendingBlocks = buildChangedBlocks(updatedTargetRows, rowWrites, targetColumns, {}, targetFields);
  const results = [];

  while (pendingBlocks.length > 0) {
    const block = pendingBlocks.shift();
    if (!block) {
      continue;
    }

    try {
      const writeResult = writeSheetCsv(node, sheetId, block.csv, block.startCell, dwsConfigDir, tempBaseDir);
      results.push({
        ...writeResult,
        strategy: "csv-put",
        startCell: block.startCell,
        range: block.range,
        rowSpan: block.rowSpan,
        columnSpan: block.columnSpan,
        rowCount: block.changedRowCount,
        firstRow: block.firstRow,
        lastRow: block.lastRow,
      });
    } catch (error) {
      if (isTimeoutError(error) && block.changedRowCount > 1) {
        pendingBlocks.unshift(...splitChangedBlock(updatedTargetRows, block, targetColumns, targetFields));
        continue;
      }

      if (isTimeoutError(error) && block.changedRowCount === 1) {
        const [rowWrite] = block.rowWrites || [];
        if (!rowWrite) {
          throw error;
        }
        results.push(...writeSingleRowChanges(
          node,
          sheetId,
          rowWrite,
          targetColumns,
          dwsConfigDir,
          targetFields,
        ));
        continue;
      }

      throw error;
    }
  }

  return results;
}

function stripRowPrefixes(csvText) {
  return String(csvText || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\[row=\d+\]/, ""))
    .join("\n")
    .replace(/^\uFEFF/, "");
}

function parseCsvLinePreserveBlank(text, delimiter) {
  const rows = parseCsv(`${text}\n`, delimiter);
  return rows[0] || [""];
}

function extractCsvRows(payload) {
  const csvText = pickFirstNonEmptyString([
    payload?.csv,
    payload?.result?.csv,
    payload?.data?.csv,
  ]);

  if (!csvText) {
    return [];
  }

  const rowIndices = pickFirstArray([
    payload?.rowIndices,
    payload?.result?.rowIndices,
    payload?.data?.rowIndices,
  ]) || [];
  const rawLines = String(csvText)
    .replace(/^\uFEFF/, "")
    .split(/\n/)
    .map((line) => line.replace(/\r$/, ""));

  if (rawLines.length === 1 && rawLines[0].trim() === "") {
    return [];
  }

  const sampleLine = rawLines.find((line) => line.replace(/^\[row=\d+\]\s?/, "").trim() !== "") || rawLines[0];
  const delimiter = detectDelimiter(sampleLine.replace(/^\[row=\d+\]\s?/, ""));
  const rows = rawLines.map((line) => parseCsvLinePreserveBlank(
    line.replace(/^\[row=\d+\]\s?/, ""),
    delimiter,
  ));

  if (rowIndices.length > rows.length) {
    rows.push(...Array.from({ length: rowIndices.length - rows.length }, () => [""]));
  }

  return rows;
}

function normalizeNodeId(node) {
  const text = String(node || "").trim();
  if (!text) {
    return "";
  }

  try {
    const url = new URL(text);
    const dentryKey = url.searchParams.get("dentryKey");
    if (dentryKey) {
      return dentryKey;
    }

    const nodeMatch = url.pathname.match(/\/nodes\/([^/?#]+)/i);
    if (nodeMatch) {
      return nodeMatch[1];
    }

    const segments = url.pathname.split("/").filter(Boolean);
    return segments[segments.length - 1] || text;
  } catch {
    return text;
  }
}

function buildTextCell(value) {
  return {
    type: "text",
    text: value == null ? "" : String(value),
  };
}

function getPlanFields(plan) {
  return unique(
    (plan.rules?.fields || Object.keys(plan.target?.columns || {}).filter((field) => field !== DEFAULT_KEY_COLUMN) || DEFAULT_SYNC_FIELDS)
      .map((field) => String(field || "").trim()),
  );
}

function getSourceFieldSpec(job, field) {
  const fields = job.fields || job.fieldMappings || {};
  const rawSpec = fields[field];
  if (rawSpec == null) {
    return {
      field,
      sourceHeader: field,
      constant: null,
      column: null,
    };
  }

  if (typeof rawSpec === "string") {
    return {
      field,
      sourceHeader: rawSpec,
      constant: null,
      column: null,
    };
  }

  return {
    field,
    sourceHeader: rawSpec.sourceHeader || rawSpec.header || field,
    constant: rawSpec.constant == null ? null : String(rawSpec.constant),
    column: rawSpec.column || null,
  };
}

function detectHeaderRowIndex(keyValues, fieldSpecs, keyHeader) {
  for (let rowIndex = 0; rowIndex < Math.min(keyValues.length, 20); rowIndex += 1) {
    if (normalizeHeader(keyValues[rowIndex]) !== normalizeHeader(keyHeader)) {
      continue;
    }

    let matched = true;
    for (const fieldSpec of fieldSpecs) {
      if (fieldSpec.constant != null) {
        continue;
      }

      const rowValues = fieldSpec.values || [];
      if (normalizeHeader(rowValues[rowIndex]) !== normalizeHeader(fieldSpec.sourceHeader || fieldSpec.field)) {
        matched = false;
        break;
      }
    }

    if (matched) {
      return rowIndex;
    }
  }

  const keyOnlyIndex = keyValues
    .slice(0, 20)
    .findIndex((value) => normalizeHeader(value) === normalizeHeader(keyHeader));
  return keyOnlyIndex === -1 ? 0 : keyOnlyIndex;
}

function buildCompactRows(keyValues, fieldSpecs, keyHeader, targetFields) {
  const rowCount = Math.max(
    keyValues.length,
    ...fieldSpecs.map((item) => (item.values || []).length),
  );
  const rows = Array.from({ length: rowCount }, () => [""].concat(targetFields.map(() => "")));
  const headerRowIndex = detectHeaderRowIndex(keyValues, fieldSpecs, keyHeader);

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    rows[rowIndex][0] = keyValues[rowIndex] ?? "";
    fieldSpecs.forEach((fieldSpec, fieldIndex) => {
      rows[rowIndex][fieldIndex + 1] = fieldSpec.constant == null
        ? fieldSpec.values?.[rowIndex] ?? ""
        : "";
    });
  }

  if (rows[headerRowIndex]) {
    rows[headerRowIndex][0] = keyHeader;
    targetFields.forEach((field, fieldIndex) => {
      rows[headerRowIndex][fieldIndex + 1] = field;
    });
  }

  return rows;
}

function buildCompactRowsFromRawRows(rawRows, keyHeader, targetFields) {
  const rows = cloneRows(rawRows);
  const headerRow = rows.find((row) => normalizeHeader(row[0]) === normalizeHeader(keyHeader))
    || rows[0]
    || [keyHeader, ...targetFields];
  if (headerRow) {
    headerRow[0] = keyHeader;
    targetFields.forEach((field, index) => {
      headerRow[index + 1] = field;
    });
  }
  return rows;
}

function execDws(args, dwsConfigDir) {
  const env = dwsConfigDir
    ? { ...process.env, DWS_CONFIG_DIR: dwsConfigDir }
    : process.env;
  const result = cp.spawnSync("dws", args, {
    env,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }

  const stdout = String(result.stdout || "").trim();
  const stderr = String(result.stderr || "").trim();
  if (result.status !== 0) {
    throw new Error(stderr || stdout || `dws 命令失败: ${args.join(" ")}`);
  }

  if (!stdout) {
    return {};
  }

  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`dws 输出不是合法 JSON: ${stdout}`);
  }
}

class MockSheetClient {
  constructor({ env }) {
    this.env = env;
  }

  getTargetPath(plan) {
    return plan.target?.mockCsvPath || this.env.mockTargetCsvPath;
  }

  getSourcePath(job) {
    return job.source?.mockCsvPath || this.env.mockSourceCsvPath;
  }

  async readTarget(plan) {
    const filePath = this.getTargetPath(plan);
    return {
      rows: buildCompactRowsFromRawRows(parseCsvFile(filePath), plan.rules?.keyColumn || DEFAULT_KEY_COLUMN, getPlanFields(plan)),
      meta: {
        provider: "mock",
        node: plan.target.node,
        sheet: plan.target.sheet,
        filePath,
      },
    };
  }

  async readSource(plan, job) {
    const filePath = this.getSourcePath(job);
    return {
      rows: buildCompactRowsFromRawRows(parseCsvFile(filePath), plan.rules?.keyColumn || DEFAULT_KEY_COLUMN, getPlanFields(plan)),
      meta: {
        provider: "mock",
        node: job.source.node,
        sheet: job.source.sheet,
        filePath,
      },
    };
  }

  async applyChanges(plan, aggregatedResult) {
    const filePath = this.getTargetPath(plan);
    fs.writeFileSync(filePath, writeCsv(aggregatedResult.updatedTargetRows), "utf8");
    return {
      provider: "mock",
      planId: plan.planId,
      filePath,
      updatedCells: aggregatedResult.report.stats.changedCells,
      updatedRows: aggregatedResult.report.stats.changedRows,
    };
  }

}

class DwsSheetClient {
  constructor({ env }) {
    this.env = env;
    this.sheetCache = new Map();
    this.sheetInfoCache = new Map();
  }

  get dwsConfigDir() {
    return this.env.dwsConfigDir || "";
  }

  get tempBaseDir() {
    return this.env.tempBaseDir || path.join(this.env.rootDir || process.cwd(), "runtime", "tmp");
  }

  getColumnReadChunkRows() {
    return Math.max(1, Number(this.env.sheetReadChunkRows || 80));
  }

  getMinColumnReadChunkRows() {
    return Math.max(1, Number(this.env.sheetReadMinChunkRows || 1));
  }

  getReadRetryCount() {
    return Math.max(1, Number(this.env.sheetReadRetryCount || 3));
  }

  getReadRetryDelayMs() {
    return Math.max(0, Number(this.env.sheetReadRetryDelayMs || 200));
  }

  runRetriableRead(work) {
    return runWithRetry(work, {
      attempts: this.getReadRetryCount(),
      baseDelayMs: this.getReadRetryDelayMs(),
      shouldRetry: isRetriableReadError,
    });
  }

  listSheets(node) {
    const payload = this.runRetriableRead(() => execDws(
      ["sheet", "list", "--node", node, "--format", "json"],
      this.dwsConfigDir,
    ));
    const result = pickFirstArray([
      payload.result,
      payload.sheets,
      payload.items,
      payload.data?.sheets,
      payload.data?.items,
    ]);
    if (!result) {
      throw new Error(`无法解析工作表列表: ${JSON.stringify(payload)}`);
    }
    return result;
  }

  resolveSheet(node, sheetInput, preferredSheetId = "") {
    const cacheKey = `${node}::${sheetInput || preferredSheetId}`;
    if (this.sheetCache.has(cacheKey)) {
      return this.sheetCache.get(cacheKey);
    }

    const directSheetId = preferredSheetId || sheetInput;
    if (directSheetId) {
      try {
        const payload = this.getSheetInfo(node, directSheetId);
        const resolved = {
          sheetId: String(payload.id || payload.sheetId || directSheetId),
          sheetName: String(payload.name || payload.title || sheetInput || preferredSheetId),
        };
        this.sheetCache.set(cacheKey, resolved);
        return resolved;
      } catch (error) {
        // fallback to listSheets only when direct lookup fails
      }
    }

    const sheets = this.listSheets(node);
    const expected = normalizeLookupToken(preferredSheetId || sheetInput);
    const match = sheets.find((item) => {
      const values = [item.sheetId, item.id, item.name, item.title]
        .filter(Boolean)
        .map(normalizeLookupToken);
      return values.includes(expected);
    });
    const fallback = !match && sheets.length === 1 ? sheets[0] : null;
    const resolved = match || fallback;

    if (!resolved) {
      throw new Error(`在表格中找不到工作表: ${sheetInput || preferredSheetId}`);
    }

    const payload = {
      sheetId: String(resolved.sheetId || resolved.id || preferredSheetId || sheetInput),
      sheetName: String(resolved.name || resolved.title || sheetInput || preferredSheetId),
    };
    this.sheetCache.set(cacheKey, payload);
    return payload;
  }

  getSheetInfo(node, sheetId) {
    const cacheKey = `${node}::${sheetId}`;
    if (this.sheetInfoCache.has(cacheKey)) {
      return this.sheetInfoCache.get(cacheKey);
    }

    const payload = this.runRetriableRead(() => execDws(
      ["sheet", "info", "--node", node, "--sheet-id", sheetId, "--format", "json"],
      this.dwsConfigDir,
    ));
    this.sheetInfoCache.set(cacheKey, payload);
    return payload;
  }

  readColumnValuesViaRange(node, sheetId, range, expectedRowCount) {
    const payload = execDws(
      [
        "sheet",
        "range",
        "read",
        "--node",
        node,
        "--sheet-id",
        sheetId,
        "--range",
        range,
        "--value-render-option",
        "formatted_value",
        "--format",
        "json",
      ],
      this.dwsConfigDir,
    );
    const rows = extractRangeValues(payload);
    if (rows.length === 0) {
      throw new Error(`Empty sheet range response: ${range}`);
    }

    return normalizeColumnValues(
      rows.map((row) => (Array.isArray(row) ? row[0] ?? "" : "")),
      expectedRowCount,
    );
  }

  readColumnValuesViaCsv(node, sheetId, range, expectedRowCount) {
    const payload = execDws(
      [
        "sheet",
        "csv-get",
        "--node",
        node,
        "--sheet-id",
        sheetId,
        "--range",
        range,
        "--value-render-option",
        "formatted_value",
        "--format",
        "json",
      ],
      this.dwsConfigDir,
    );
    const rows = extractCsvRows(payload);
    if (rows.length === 0) {
      throw new Error(`Empty sheet csv response: ${range}`);
    }

    return normalizeColumnValues(
      rows.map((row) => (Array.isArray(row) ? row[0] ?? "" : "")),
      expectedRowCount,
    );
  }

  readColumnValuesSegment(node, sheetId, columnLetter, startRow, endRow) {
    const range = buildColumnRangeForRows(columnLetter, startRow, endRow);
    const rowCount = Math.max(1, endRow - startRow + 1);
    let lastError = null;

    try {
      return this.runRetriableRead(() => this.readColumnValuesViaCsv(node, sheetId, range, rowCount));
    } catch (error) {
      lastError = error;
    }

    try {
      return this.runRetriableRead(() => this.readColumnValuesViaRange(node, sheetId, range, rowCount));
    } catch (error) {
      lastError = error;
    }

    if (rowCount > this.getMinColumnReadChunkRows() && isRetriableReadError(lastError)) {
      const middle = Math.floor((startRow + endRow) / 2);
      if (middle >= endRow) {
        throw lastError;
      }

      return [
        ...this.readColumnValuesSegment(node, sheetId, columnLetter, startRow, middle),
        ...this.readColumnValuesSegment(node, sheetId, columnLetter, middle + 1, endRow),
      ];
    }

    throw lastError || new Error(`读取列 ${columnLetter} 失败: ${range}`);
  }

  readColumnValues(node, sheetId, columnLetter) {
    const sheetInfo = this.getSheetInfo(node, sheetId);
    const range = buildColumnRange(columnLetter, getSheetReadRowLimit(sheetInfo));
    const payload = execDws(
      [
        "sheet",
        "range",
        "read",
        "--node",
        node,
        "--sheet-id",
        sheetId,
        "--range",
        range,
        "--value-render-option",
        "formatted_value",
        "--format",
        "json",
      ],
      this.dwsConfigDir,
    );
    const rows = extractRangeValues(payload);
    if (rows.length === 0) {
      throw new Error(`读取列 ${columnLetter} 失败: ${JSON.stringify(payload)}`);
    }

    return rows.map((row) => (Array.isArray(row) ? row[0] ?? "" : ""));
  }

  readColumnValuesWithFallback(node, sheetId, columnLetter) {
    const sheetInfo = this.getSheetInfo(node, sheetId);
    const range = buildColumnRange(columnLetter, getSheetReadRowLimit(sheetInfo));
    const rangePayload = execDws(
      [
        "sheet",
        "range",
        "read",
        "--node",
        node,
        "--sheet-id",
        sheetId,
        "--range",
        range,
        "--value-render-option",
        "formatted_value",
        "--format",
        "json",
      ],
      this.dwsConfigDir,
    );
    const rangeRows = extractRangeValues(rangePayload);
    if (rangeRows.length > 0) {
      return rangeRows.map((row) => (Array.isArray(row) ? row[0] ?? "" : ""));
    }

    const csvPayload = execDws(
      [
        "sheet",
        "csv-get",
        "--node",
        node,
        "--sheet-id",
        sheetId,
        "--range",
        range,
        "--format",
        "json",
      ],
      this.dwsConfigDir,
    );
    const csvRows = extractCsvRows(csvPayload);
    if (csvRows.length === 0) {
      throw new Error(`读取列 ${columnLetter} 失败: ${JSON.stringify(rangePayload)}`);
    }

    return csvRows.map((row) => (Array.isArray(row) ? row[0] ?? "" : ""));
  }

  readColumnValues(node, sheetId, columnLetter) {
    return this.readColumnValuesWithFallback(node, sheetId, columnLetter);
  }

  readColumnValuesWithFallback(node, sheetId, columnLetter) {
    const sheetInfo = this.getSheetInfo(node, sheetId);
    const rowLimit = getSheetReadRowLimit(sheetInfo);
    const chunkRows = this.getColumnReadChunkRows();
    const values = [];

    for (let startRow = 1; startRow <= rowLimit; startRow += chunkRows) {
      const endRow = Math.min(rowLimit, startRow + chunkRows - 1);
      values.push(...this.readColumnValuesSegment(node, sheetId, columnLetter, startRow, endRow));
    }

    return values;
  }

  buildTargetCompactRows(plan, resolvedSheet) {
    const targetFields = getPlanFields(plan);
    const keyHeader = plan.rules?.keyColumn || DEFAULT_KEY_COLUMN;
    const keyColumn = plan.target.keyColumn?.column;
    const keyValues = this.readColumnValuesWithFallback(plan.target.node, resolvedSheet.sheetId, keyColumn);
    const fieldSpecs = targetFields.map((field) => {
      const targetColumn = plan.target.columns?.[field];
      return {
        field,
        sourceHeader: targetColumn?.header || field,
        values: this.readColumnValuesWithFallback(plan.target.node, resolvedSheet.sheetId, targetColumn.column),
      };
    });

    return buildCompactRows(keyValues, fieldSpecs, keyHeader, targetFields);
  }

  buildSourceCompactRows(plan, job, resolvedSheet) {
    const targetFields = getPlanFields(plan);
    const keyHeader = plan.rules?.keyColumn || DEFAULT_KEY_COLUMN;
    const keyColumn = job.keyColumn?.column;
    const keyValues = this.readColumnValuesWithFallback(job.source.node, resolvedSheet.sheetId, keyColumn);
    const fieldSpecs = targetFields.map((field) => {
      const sourceField = getSourceFieldSpec(job, field);
      return {
        field,
        sourceHeader: sourceField.sourceHeader || field,
        constant: sourceField.constant,
        values: sourceField.constant == null
          ? this.readColumnValuesWithFallback(job.source.node, resolvedSheet.sheetId, sourceField.column)
          : [],
      };
    });

    return buildCompactRows(keyValues, fieldSpecs, keyHeader, targetFields);
  }

  async readTarget(plan) {
    const resolvedSheet = this.resolveSheet(plan.target.node, plan.target.sheet, plan.target.sheetId);
    return {
      rows: this.buildTargetCompactRows(plan, resolvedSheet),
      meta: {
        provider: "dws",
        node: plan.target.node,
        nodeId: normalizeNodeId(plan.target.node),
        sheet: plan.target.sheet,
        sheetId: resolvedSheet.sheetId,
        sheetName: resolvedSheet.sheetName,
      },
    };
  }

  async readSource(plan, job) {
    const resolvedSheet = this.resolveSheet(job.source.node, job.source.sheet, job.source.sheetId);
    return {
      rows: this.buildSourceCompactRows(plan, job, resolvedSheet),
      meta: {
        provider: "dws",
        node: job.source.node,
        nodeId: normalizeNodeId(job.source.node),
        sheet: job.source.sheet,
        sheetId: resolvedSheet.sheetId,
        sheetName: resolvedSheet.sheetName,
      },
    };
  }

  assertWriteTargetAllowed(plan, resolvedSheetId) {
    const guard = plan.target?.writeGuard || {};
    const targetNodeId = normalizeNodeId(plan.target?.node);
    const expectedNodeId = guard.nodeId || targetNodeId;
    const expectedSheetId = guard.sheetId || plan.target?.sheetId || resolvedSheetId;

    if (expectedNodeId && targetNodeId !== expectedNodeId) {
      throw new Error("写入护栏已拦截：当前目标节点不在允许写入的总表名单内。");
    }

    if (expectedSheetId && resolvedSheetId !== expectedSheetId) {
      throw new Error("写入护栏已拦截：当前目标工作表不在允许写入的总表名单内。");
    }
  }

  writeCell(node, sheetId, cell, value) {
    return execDws(
      [
        "sheet",
        "range",
        "update",
        "--node",
        node,
        "--sheet-id",
        sheetId,
        "--range",
        cell,
        "--values",
        JSON.stringify([[buildTextCell(value)]]),
        "--format",
        "json",
      ],
      this.dwsConfigDir,
    );
  }

  async applyChanges(plan, aggregatedResult) {
    const resolvedSheet = this.resolveSheet(plan.target.node, plan.target.sheet, plan.target.sheetId);
    this.assertWriteTargetAllowed(plan, resolvedSheet.sheetId);

    const changedRows = aggregatedResult.rowWrites || [];
    if (changedRows.length === 0) {
      return {
        provider: "dws",
        targetNodeId: normalizeNodeId(plan.target.node),
        targetSheetId: resolvedSheet.sheetId,
        updatedCells: 0,
        updatedRows: 0,
      };
    }

    const targetColumns = plan.target?.columns || {};
    const targetFields = getPlanFields(plan);
    const writeResults = writeChunkedChangedBlocks(
      plan.target.node,
      resolvedSheet.sheetId,
      aggregatedResult.updatedTargetRows || [],
      changedRows,
      targetColumns,
      this.dwsConfigDir,
      this.tempBaseDir,
      targetFields,
    );

    if (writeResults.length === 0) {
      return {
        provider: "dws",
        targetNodeId: normalizeNodeId(plan.target.node),
        targetSheetId: resolvedSheet.sheetId,
        updatedCells: 0,
        updatedRows: 0,
      };
    }

    return {
      provider: "dws",
      targetNodeId: normalizeNodeId(plan.target.node),
      targetSheetId: resolvedSheet.sheetId,
      updatedCells: aggregatedResult.report.stats.changedCells,
      updatedRows: aggregatedResult.report.stats.changedRows,
      writeOperations: writeResults.length,
      writeResult: writeResults[writeResults.length - 1] || null,
      writeResults,
      writePlan: {
        strategy: unique(writeResults.map((item) => item.strategy)).length === 1
          ? unique(writeResults.map((item) => item.strategy))[0]
          : "mixed",
        strategies: unique(writeResults.map((item) => item.strategy)),
        blockCount: writeResults.length,
        blocks: writeResults.map((item) => ({
          strategy: item.strategy,
          startCell: item.startCell,
          range: item.range,
          rowSpan: item.rowSpan,
          columnSpan: item.columnSpan,
          rowCount: item.rowCount,
        })),
      },
    };
  }

}

function assertWriteTargetAllowed(plan, resolvedSheetId = plan.target?.sheetId) {
  const client = new DwsSheetClient({ env: {} });
  return client.assertWriteTargetAllowed(plan, resolvedSheetId);
}

function createSheetClient({ env }) {
  if (env.provider === "mock") {
    return new MockSheetClient({ env });
  }

  return new DwsSheetClient({ env });
}

module.exports = {
  DwsSheetClient,
  MockSheetClient,
  assertWriteTargetAllowed,
  buildChangedBlockCsv,
  buildChangedBlocks,
  buildColumnRange,
  buildSingleCellWrites,
  buildSingleRowRangeUpdate,
  createSheetClient,
  extractCsvRows,
  getSheetReadRowLimit,
  normalizeNodeId,
};
