const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");

const KEY_COLUMN = "货号";
const COLUMN_MAPPING = {
  "齐色主附图完成时间": "齐色主附图完成时间",
  "A+完成时间": "A+完成日期",
  "视频完成时间": "视频完成日期",
};
const HEADER_ALIASES = {
  [KEY_COLUMN]: [KEY_COLUMN],
  "齐色主附图完成时间": ["齐色主附图完成时间", "齐色主附图完成日期"],
  "A+完成时间": ["A+完成时间", "A+完成日期"],
  "A+完成日期": ["A+完成日期", "A+完成时间"],
  "视频完成时间": ["视频完成时间", "视频完成日期"],
  "视频完成日期": ["视频完成日期", "视频完成时间"],
};

function parseArgs(argv) {
  const args = {
    mode: "local",
    dryRun: false,
    allowEmptyOverwrite: false,
    maxPreview: 20,
    outputDir: path.resolve("work"),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case "--mode":
        args.mode = argv[++i];
        break;
      case "--source":
        args.source = argv[++i];
        break;
      case "--target":
        args.target = argv[++i];
        break;
      case "--output":
        args.output = argv[++i];
        break;
      case "--report":
        args.report = argv[++i];
        break;
      case "--output-dir":
        args.outputDir = path.resolve(argv[++i]);
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--allow-empty-overwrite":
        args.allowEmptyOverwrite = true;
        break;
      case "--max-preview":
        args.maxPreview = Number(argv[++i]);
        break;
      case "--source-node":
        args.sourceNode = argv[++i];
        break;
      case "--target-node":
        args.targetNode = argv[++i];
        break;
      case "--source-sheet":
        args.sourceSheet = argv[++i];
        break;
      case "--target-sheet":
        args.targetSheet = argv[++i];
        break;
      case "--dws-config-dir":
        args.dwsConfigDir = argv[++i];
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`未知参数: ${token}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(
    [
      "用法:",
      "  本地 CSV 模式:",
      "    node work/dingtalk-sheet-sync-demo.js --mode local --source <参考表.csv> --target <填入表.csv> [--output <输出.csv>] [--report <报告.json>] [--dry-run] [--allow-empty-overwrite]",
      "",
      "  钉钉在线表格模式:",
      "    node work/dingtalk-sheet-sync-demo.js --mode dws --source-node <参考表链接或node> --target-node <填入表链接或node> --source-sheet <参考表工作表名> --target-sheet <填入表工作表名> [--report <报告.json>] [--dry-run] [--allow-empty-overwrite] [--dws-config-dir <目录>]",
      "",
      "说明:",
      "  - 按“货号”匹配两张表",
      "  - 默认只用参考表中的非空值覆盖填入表",
      "  - 添加 --allow-empty-overwrite 后，参考表空值也会把目标清空",
      "  - 在线表格模式默认用 dws sheet csv-get 读取；若整表匹配为 0，会自动改用 dws sheet find + range update 逐行定位并回写",
    ].join("\n"),
  );
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
}

function detectDelimiter(text) {
  const candidates = [",", "\t", ";"];
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 10);

  let best = ",";
  let bestScore = -1;
  for (const delimiter of candidates) {
    const score = lines.reduce((sum, line) => sum + (line.split(delimiter).length - 1), 0);
    if (score > bestScore) {
      best = delimiter;
      bestScore = score;
    }
  }

  return best;
}

function parseCsv(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === "\"") {
      if (inQuotes && next === "\"") {
        cell += "\"";
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === delimiter) {
      row.push(cell);
      cell = "";
      continue;
    }

    if (!inQuotes && char === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }

  return rows.filter((cells) => cells.some((value) => value !== ""));
}

function escapeCsvValue(value, delimiter) {
  const text = value == null ? "" : String(value);
  if (text.includes("\"") || text.includes("\n") || text.includes("\r") || text.includes(delimiter)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function writeCsv(rows, delimiter) {
  return rows
    .map((row) => row.map((value) => escapeCsvValue(value, delimiter)).join(delimiter))
    .join("\r\n");
}

function normalizeHeader(value) {
  return String(value ?? "").trim();
}

function getHeaderAliases(header) {
  return HEADER_ALIASES[header] || [header];
}

function normalizeKey(value) {
  return String(value ?? "").trim();
}

function normalizeComparable(value) {
  return String(value ?? "").trim();
}

function normalizeKeyForDiagnostics(value) {
  const text = String(value ?? "").normalize("NFKC").trim().toUpperCase();
  if (!text) {
    return "";
  }

  return text
    .replace(/\s+/g, "")
    .replace(/[([][^)\]]*[)\]]/g, "")
    .replace(/[（［【].*[）］】]/g, "")
    .trim();
}

function isBlank(value) {
  return normalizeComparable(value) === "";
}

function sampleList(values, limit) {
  return values.slice(0, Math.max(1, limit));
}

function buildNormalizedKeyMap(keys) {
  const map = new Map();

  for (const rawKey of keys) {
    const normalized = normalizeKeyForDiagnostics(rawKey);
    if (!normalized) {
      continue;
    }

    if (!map.has(normalized)) {
      map.set(normalized, new Set());
    }
    map.get(normalized).add(rawKey);
  }

  return map;
}

function buildTransformedKeySamples(keys, limit) {
  const transformed = [];

  for (const rawKey of keys) {
    const normalized = normalizeKeyForDiagnostics(rawKey);
    if (!normalized || normalized === rawKey) {
      continue;
    }

    transformed.push({ raw: rawKey, normalized });
    if (transformed.length >= limit) {
      break;
    }
  }

  return transformed;
}

function buildKeyDiagnostics(sourceRecords, targetRecords, args) {
  const limit = Math.max(5, Math.min(args.maxPreview || 20, 20));
  const sourceKeys = sourceRecords.keys;
  const targetKeys = targetRecords.keys;
  const sourceNormalizedMap = buildNormalizedKeyMap(sourceKeys);
  const targetNormalizedMap = buildNormalizedKeyMap(targetKeys);
  const exactOverlap = sourceKeys.filter((key) => targetRecords.index.has(key));
  const normalizedOverlap = [...sourceNormalizedMap.keys()].filter((key) => targetNormalizedMap.has(key));
  const normalizedOnlyOverlap = normalizedOverlap.filter((normalized) => {
    const sourceRawKeys = [...sourceNormalizedMap.get(normalized)];
    const targetRawKeys = [...targetNormalizedMap.get(normalized)];
    return !sourceRawKeys.some((sourceRawKey) => targetRawKeys.includes(sourceRawKey));
  });
  const sourceKeySampleRows = [...sourceRecords.index.values()]
    .slice(0, limit)
    .map((record) => ({ row: record.rowIndex + 1, key: record.key }));
  const targetKeySampleRows = [...targetRecords.index.values()]
    .slice(0, limit)
    .map((record) => ({ row: record.rowIndex + 1, key: record.key }));

  return {
    sourceKeySamples: sampleList(sourceKeys, limit),
    targetKeySamples: sampleList(targetKeys, limit),
    sourceKeySampleRows,
    targetKeySampleRows,
    exactOverlapCount: exactOverlap.length,
    exactOverlapSample: sampleList(exactOverlap, limit),
    normalized: {
      overlapCount: normalizedOverlap.length,
      overlapSample: sampleList(normalizedOverlap, limit),
      normalizedOnlyOverlapCount: normalizedOnlyOverlap.length,
      normalizedOnlyOverlapSample: sampleList(normalizedOnlyOverlap, limit).map((normalized) => ({
        normalized,
        source: sampleList([...sourceNormalizedMap.get(normalized)], 3),
        target: sampleList([...targetNormalizedMap.get(normalized)], 3),
      })),
      sourceTransformedSample: buildTransformedKeySamples(sourceKeys, limit),
      targetTransformedSample: buildTransformedKeySamples(targetKeys, limit),
    },
  };
}

function excelColumnName(columnIndex) {
  let value = columnIndex + 1;
  let name = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function findHeaderRow(rows, requiredHeaders) {
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, 20); rowIndex += 1) {
    const row = rows[rowIndex].map(normalizeHeader);
    const columnIndexByHeader = {};
    let matched = true;

    for (const header of requiredHeaders) {
      const aliases = getHeaderAliases(header).map(normalizeHeader);
      const columnIndex = row.findIndex((cell) => aliases.includes(cell));
      if (columnIndex === -1) {
        matched = false;
        break;
      }
      columnIndexByHeader[header] = columnIndex;
    }

    if (!matched) {
      continue;
    }

    return { rowIndex, columnIndexByHeader };
  }

  throw new Error(`未找到表头，缺少列: ${requiredHeaders.join(", ")}`);
}

function ensureRowWidth(row, width) {
  while (row.length < width) {
    row.push("");
  }
}

function buildHeaderDiagnostics(rows, headerInfo) {
  const headerRow = rows[headerInfo.rowIndex] || [];
  const keyColumnIndex = headerInfo.columnIndexByHeader[KEY_COLUMN];

  return {
    headerRowIndex: headerInfo.rowIndex + 1,
    keyColumnIndex,
    keyColumnLetter: excelColumnName(keyColumnIndex),
    keyColumnHeader: headerRow[keyColumnIndex] ?? "",
    headerRowValues: headerRow,
  };
}

function buildRecordIndex(rows, headerInfo, requiredHeaders) {
  const keyColumnIndex = headerInfo.columnIndexByHeader[KEY_COLUMN];
  const duplicateKeys = new Set();
  const index = new Map();
  let recordCount = 0;

  for (let rowIndex = headerInfo.rowIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    ensureRowWidth(row, Math.max(...Object.values(headerInfo.columnIndexByHeader)) + 1);
    const key = normalizeKey(row[keyColumnIndex]);
    if (!key) {
      continue;
    }

    recordCount += 1;
    if (index.has(key)) {
      duplicateKeys.add(key);
      continue;
    }

    const values = {};
    for (const header of requiredHeaders) {
      values[header] = row[headerInfo.columnIndexByHeader[header]] ?? "";
    }

    index.set(key, {
      key,
      rowIndex,
      values,
    });
  }

  for (const key of duplicateKeys) {
    index.delete(key);
  }

  return {
    index,
    keys: [...index.keys()],
    duplicateKeys: [...duplicateKeys].sort(),
    recordCount,
  };
}

function defaultOutputPath(targetPath) {
  const parsed = path.parse(targetPath);
  return path.join(parsed.dir, `${parsed.name}.synced${parsed.ext || ".csv"}`);
}

function buildSyncResult(sourceRows, targetRows, args) {
  const sourceHeaders = [KEY_COLUMN, ...Object.keys(COLUMN_MAPPING)];
  const targetHeaders = [KEY_COLUMN, ...Object.values(COLUMN_MAPPING)];
  const sourceHeaderInfo = findHeaderRow(sourceRows, sourceHeaders);
  const targetHeaderInfo = findHeaderRow(targetRows, targetHeaders);
  const sourceRecords = buildRecordIndex(sourceRows, sourceHeaderInfo, sourceHeaders);
  const targetRecords = buildRecordIndex(targetRows, targetHeaderInfo, targetHeaders);
  const updatedTargetRows = targetRows.map((row) => row.slice());
  const sourceHeaderDiagnostics = buildHeaderDiagnostics(sourceRows, sourceHeaderInfo);
  const targetHeaderDiagnostics = buildHeaderDiagnostics(targetRows, targetHeaderInfo);

  const ambiguousKeys = new Set([...sourceRecords.duplicateKeys, ...targetRecords.duplicateKeys]);
  const missingInTarget = [];
  const missingInSource = [];
  const changes = [];
  const rowChangeMap = new Map();
  const affectedKeys = new Set();
  let matchedKeys = 0;

  for (const [key, sourceRecord] of sourceRecords.index.entries()) {
    if (ambiguousKeys.has(key)) {
      continue;
    }

    const targetRecord = targetRecords.index.get(key);
    if (!targetRecord) {
      missingInTarget.push(key);
      continue;
    }

    matchedKeys += 1;

    for (const [sourceColumn, targetColumn] of Object.entries(COLUMN_MAPPING)) {
      const sourceValue = sourceRecord.values[sourceColumn] ?? "";
      const targetValue = targetRecord.values[targetColumn] ?? "";

      if (!args.allowEmptyOverwrite && isBlank(sourceValue)) {
        continue;
      }

      if (normalizeComparable(sourceValue) === normalizeComparable(targetValue)) {
        continue;
      }

      const targetColumnIndex = targetHeaderInfo.columnIndexByHeader[targetColumn];
      ensureRowWidth(updatedTargetRows[targetRecord.rowIndex], targetColumnIndex + 1);
      updatedTargetRows[targetRecord.rowIndex][targetColumnIndex] = sourceValue;
      affectedKeys.add(key);
      changes.push({
        key,
        column: targetColumn,
        oldValue: targetValue,
        newValue: sourceValue,
        targetRow: targetRecord.rowIndex + 1,
        targetColumnLetter: excelColumnName(targetColumnIndex),
      });
      /*
      changes.push({
        货号: key,
        字段: targetColumn,
        原值: targetValue,
        新值: sourceValue,
        填入表行号: targetRecord.rowIndex + 1,
        列字母: excelColumnName(targetColumnIndex),
      });

      */
      if (!rowChangeMap.has(targetRecord.rowIndex)) {
        rowChangeMap.set(targetRecord.rowIndex, new Set());
      }
      rowChangeMap.get(targetRecord.rowIndex).add(targetColumnIndex);
    }
  }

  for (const key of targetRecords.index.keys()) {
    if (!sourceRecords.index.has(key) && !ambiguousKeys.has(key)) {
      missingInSource.push(key);
    }
  }

  const keyDiagnostics = buildKeyDiagnostics(sourceRecords, targetRecords, args);

  return {
    sourceHeaderInfo,
    targetHeaderInfo,
    sourceRecords,
    targetRecords,
    updatedTargetRows,
    changes,
    rowChangeMap,
    report: {
      dryRun: args.dryRun,
      allowEmptyOverwrite: args.allowEmptyOverwrite,
      headerRows: {
        source: sourceHeaderInfo.rowIndex + 1,
        target: targetHeaderInfo.rowIndex + 1,
      },
      headerDiagnostics: {
        source: sourceHeaderDiagnostics,
        target: targetHeaderDiagnostics,
      },
      stats: {
        sourceRecords: sourceRecords.recordCount,
        targetRecords: targetRecords.recordCount,
        matchedKeys,
        affectedKeys: affectedKeys.size,
        changedCells: changes.length,
        changedRows: rowChangeMap.size,
        missingInTarget: missingInTarget.length,
        missingInSource: missingInSource.length,
        duplicateKeysInSource: sourceRecords.duplicateKeys.length,
        duplicateKeysInTarget: targetRecords.duplicateKeys.length,
      },
      duplicateKeys: {
        source: sourceRecords.duplicateKeys,
        target: targetRecords.duplicateKeys,
      },
      keyDiagnostics,
      missingKeys: {
        inTarget: missingInTarget,
        inSource: missingInSource,
      },
      previewChanges: changes.slice(0, args.maxPreview),
    },
  };
}

function syncLocalTables(args) {
  const sourceText = readText(args.source);
  const targetText = readText(args.target);
  const sourceDelimiter = detectDelimiter(sourceText);
  const targetDelimiter = detectDelimiter(targetText);
  const sourceRows = parseCsv(sourceText, sourceDelimiter);
  const targetRows = parseCsv(targetText, targetDelimiter);
  const result = buildSyncResult(sourceRows, targetRows, args);
  const report = {
    source: path.resolve(args.source),
    target: path.resolve(args.target),
    ...result.report,
  };

  if (!args.dryRun && result.changes.length > 0) {
    const outputPath = path.resolve(args.output || defaultOutputPath(args.target));
    fs.writeFileSync(outputPath, writeCsv(result.updatedTargetRows, targetDelimiter), "utf8");
    report.output = outputPath;
  }

  return report;
}

function execDws(args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  const result = cp.spawnSync("dws", args, {
    env,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }

  const stdout = (result.stdout || "").trim();
  const stderr = (result.stderr || "").trim();

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

function getDwsEnv(args) {
  return args.dwsConfigDir ? { DWS_CONFIG_DIR: args.dwsConfigDir } : {};
}

function pickFirstArray(values) {
  return values.find((value) => Array.isArray(value));
}

function pickFirstNonEmptyString(values) {
  return values.find((value) => typeof value === "string" && value.trim() !== "") || "";
}

function normalizeLookupToken(value) {
  return String(value ?? "").trim().toLowerCase();
}

function getSheetList(node, args) {
  const payload = execDws(["sheet", "list", "--node", node, "--format", "json"], getDwsEnv(args));
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

function resolveSheetId(node, sheetNameOrId, args) {
  const sheets = getSheetList(node, args);
  const expected = normalizeLookupToken(sheetNameOrId);
  const match = sheets.find((item) => {
    const values = [item.sheetId, item.id, item.name, item.title]
      .filter(Boolean)
      .map(normalizeLookupToken);
    return values.includes(expected);
  });

  const fallback = !match && sheets.length === 1 ? sheets[0] : null;
  const resolvedSheet = match || fallback;

  if (!resolvedSheet) {
    throw new Error(`在表格中找不到工作表: ${sheetNameOrId}`);
  }

  return {
    raw: resolvedSheet,
    sheetId: String(resolvedSheet.sheetId || resolvedSheet.id || sheetNameOrId),
    sheetName: String(
      resolvedSheet.name || resolvedSheet.title || resolvedSheet.sheetId || resolvedSheet.id || sheetNameOrId,
    ),
    matchedByFallback: !match && Boolean(fallback),
  };
}

function fetchSheetCsv(node, sheetNameOrId, args) {
  const resolved = resolveSheetId(node, sheetNameOrId, args);
  const payload = execDws(
    ["sheet", "csv-get", "--node", node, "--sheet-id", resolved.sheetId, "--format", "json"],
    getDwsEnv(args),
  );

  const csvText = pickFirstNonEmptyString([
    payload.csv,
    payload.text,
    payload.result?.csv,
    payload.result?.text,
    payload.data?.csv,
    payload.data?.text,
    typeof payload.result === "string" ? payload.result : "",
    typeof payload.data === "string" ? payload.data : "",
  ]);
  if (typeof csvText !== "string" || !csvText.trim()) {
    throw new Error(`读取工作表 CSV 失败: ${JSON.stringify(payload)}`);
  }

  return {
    ...resolved,
    csvText,
  };
}

function stripRowPrefixes(csvText) {
  return csvText
    .split(/\r?\n/)
    .map((line) => line.replace(/^\[row=\d+\]/, ""))
    .join("\n")
    .replace(/^\uFEFF/, "");
}

function getFindMatchedCells(payload) {
  return (
    pickFirstArray([
      payload.matchedCells,
      payload.result?.matchedCells,
      payload.data?.matchedCells,
      payload.cells,
      payload.result?.cells,
      payload.data?.cells,
    ]) || []
  );
}

function parseA1Cell(a1Notation) {
  const match = String(a1Notation ?? "").match(/([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i);
  if (!match) {
    return null;
  }

  return {
    startColumn: match[1].toUpperCase(),
    startRow: Number(match[2]),
    endColumn: (match[3] || match[1]).toUpperCase(),
    endRow: Number(match[4] || match[2]),
  };
}

function readSheetRangeCsv(node, sheetId, range, args) {
  const payload = execDws(
    ["sheet", "csv-get", "--node", node, "--sheet-id", sheetId, "--range", range, "--format", "json"],
    getDwsEnv(args),
  );

  const csvText = pickFirstNonEmptyString([
    payload.csv,
    payload.text,
    payload.result?.csv,
    payload.result?.text,
    payload.data?.csv,
    payload.data?.text,
    typeof payload.result === "string" ? payload.result : "",
    typeof payload.data === "string" ? payload.data : "",
  ]);

  return {
    payload,
    csvText,
  };
}

function readSheetRowSlice(node, sheetId, rowNumber, minCol, maxCol, args) {
  const range = `${excelColumnName(minCol)}${rowNumber}:${excelColumnName(maxCol)}${rowNumber}`;
  const { csvText } = readSheetRangeCsv(node, sheetId, range, args);
  const rows = csvText ? parseCsv(stripRowPrefixes(csvText), ",") : [];
  const row = rows[0] ? rows[0].slice() : [];
  ensureRowWidth(row, maxCol - minCol + 1);
  return row;
}

function buildTextCell(value) {
  return {
    type: "text",
    text: value == null ? "" : String(value),
  };
}

function writeSheetRangeValues(node, sheetId, range, values, args) {
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
    getDwsEnv(args),
  );
}

function findTargetRowsByKey(node, sheetId, key, keyColumnLetter, args) {
  const payload = execDws(
    [
      "sheet",
      "find",
      "--node",
      node,
      "--sheet-id",
      sheetId,
      "--find",
      key,
      "--match-entire-cell",
      "--include-hidden",
      "--format",
      "json",
    ],
    getDwsEnv(args),
  );

  const matches = getFindMatchedCells(payload)
    .map((cell) => ({
      ...cell,
      a1: cell.a1Notation || cell.a1 || cell.range || "",
      parsed: parseA1Cell(cell.a1Notation || cell.a1 || cell.range || ""),
    }))
    .filter((cell) => cell.parsed)
    .filter((cell) => cell.parsed.startColumn === keyColumnLetter);

  return {
    payload,
    matches,
  };
}

function syncDwsSheetsViaFind(source, target, args, syncResult) {
  const sourceRecords = syncResult.sourceRecords;
  const targetHeaderInfo = syncResult.targetHeaderInfo;
  const targetKeyColumnIndex = targetHeaderInfo.columnIndexByHeader[KEY_COLUMN];
  const targetKeyColumnLetter = excelColumnName(targetKeyColumnIndex);
  const targetToSourceColumn = Object.fromEntries(
    Object.entries(COLUMN_MAPPING).map(([sourceColumn, targetColumn]) => [targetColumn, sourceColumn]),
  );
  const mappedTargetColumns = Object.values(COLUMN_MAPPING);
  const targetColumnIndices = Object.fromEntries(
    mappedTargetColumns.map((header) => [header, targetHeaderInfo.columnIndexByHeader[header]]),
  );
  const minCol = Math.min(...Object.values(targetColumnIndices));
  const maxCol = Math.max(...Object.values(targetColumnIndices));
  const targetColumnByIndex = Object.fromEntries(
    Object.entries(targetColumnIndices).map(([header, columnIndex]) => [columnIndex, header]),
  );
  const ambiguousSourceKeys = new Set(sourceRecords.duplicateKeys);
  const changes = [];
  const rowWrites = [];
  const missingInTarget = [];
  const duplicateFindHits = [];
  const matchedKeys = [];
  const locatedRowSamples = [];

  for (const [key, sourceRecord] of sourceRecords.index.entries()) {
    if (ambiguousSourceKeys.has(key)) {
      continue;
    }

    const { matches } = findTargetRowsByKey(args.targetNode, target.sheetId, key, targetKeyColumnLetter, args);
    if (matches.length === 0) {
      missingInTarget.push(key);
      continue;
    }

    if (matches.length > 1) {
      duplicateFindHits.push({
        key,
        matches: matches.map((item) => item.a1),
      });
      continue;
    }

    const matched = matches[0];
    const rowNumber = matched.parsed.startRow;
    matchedKeys.push(key);
    if (locatedRowSamples.length < args.maxPreview) {
      locatedRowSamples.push({
        key,
        a1Notation: matched.a1,
        row: rowNumber,
      });
    }

    const currentRow = readSheetRowSlice(args.targetNode, target.sheetId, rowNumber, minCol, maxCol, args);
    const values = [];
    let rowChanged = false;

    for (let columnIndex = minCol; columnIndex <= maxCol; columnIndex += 1) {
      const targetColumn = targetColumnByIndex[columnIndex];
      if (!targetColumn) {
        values.push({});
        continue;
      }

      const sourceColumn = targetToSourceColumn[targetColumn];
      const sourceValue = sourceRecord.values[sourceColumn] ?? "";
      const currentValue = currentRow[columnIndex - minCol] ?? "";

      if (!args.allowEmptyOverwrite && isBlank(sourceValue)) {
        values.push({});
        continue;
      }

      if (normalizeComparable(sourceValue) === normalizeComparable(currentValue)) {
        values.push({});
        continue;
      }

      rowChanged = true;
      values.push(buildTextCell(sourceValue));
      changes.push({
        key,
        column: targetColumn,
        oldValue: currentValue,
        newValue: sourceValue,
        targetRow: rowNumber,
        targetColumnLetter: excelColumnName(columnIndex),
      });
      /*
      changes.push({
        璐у彿: key,
        瀛楁: targetColumn,
        鍘熷€? currentValue,
        鏂板€? sourceValue,
        濉叆琛ㄨ鍙? rowNumber,
        鍒楀瓧姣? excelColumnName(columnIndex),
      });
    }

      */
    }
    if (rowChanged) {
      rowWrites.push({
        key,
        rowNumber,
        range: `${excelColumnName(minCol)}${rowNumber}:${excelColumnName(maxCol)}${rowNumber}`,
        values: [values],
      });
    }
  }

  return {
    matchedKeys,
    missingInTarget,
    duplicateFindHits,
    changes,
    rowWrites,
    locatedRowSamples,
    keyColumnLetter: targetKeyColumnLetter,
    stats: {
      matchedKeys: matchedKeys.length,
      affectedKeys: new Set(rowWrites.map((item) => item.key)).size,
      changedCells: changes.length,
      changedRows: rowWrites.length,
      missingInTarget: missingInTarget.length,
      duplicateFindHits: duplicateFindHits.length,
    },
  };
}

function buildChangedBlockCsv(syncResult) {
  const changedRowIndices = [...syncResult.rowChangeMap.keys()].sort((a, b) => a - b);
  if (changedRowIndices.length === 0) {
    return null;
  }

  const targetKeyCol = syncResult.targetHeaderInfo.columnIndexByHeader[KEY_COLUMN];
  const mappedTargetCols = Object.values(COLUMN_MAPPING).map(
    (header) => syncResult.targetHeaderInfo.columnIndexByHeader[header],
  );
  const minCol = Math.min(targetKeyCol, ...mappedTargetCols);
  const maxCol = Math.max(targetKeyCol, ...mappedTargetCols);
  const startRow = changedRowIndices[0] + 1;
  const endRow = changedRowIndices[changedRowIndices.length - 1] + 1;
  const range = `${excelColumnName(minCol)}${startRow}:${excelColumnName(maxCol)}${endRow}`;
  const rows = [];

  for (let rowIndex = changedRowIndices[0]; rowIndex <= changedRowIndices[changedRowIndices.length - 1]; rowIndex += 1) {
    const row = syncResult.updatedTargetRows[rowIndex] || [];
    const slice = [];
    for (let col = minCol; col <= maxCol; col += 1) {
      slice.push(row[col] ?? "");
    }
    rows.push(slice);
  }

  return {
    range,
    csv: writeCsv(rows, ","),
    startCell: `${excelColumnName(minCol)}${startRow}`,
    endRow,
    minCol,
    maxCol,
    firstRow: changedRowIndices[0],
    lastRow: changedRowIndices[changedRowIndices.length - 1],
  };
}

function writeSheetCsv(node, sheetId, csvText, startCell, args) {
  const tempFile = path.join(
    args.outputDir,
    `sheet-sync-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`,
  );
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
      getDwsEnv(args),
    );
  } finally {
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
  }
}

function syncDwsSheets(args) {
  assert(args.sourceNode, "在线表格模式缺少 --source-node");
  assert(args.targetNode, "在线表格模式缺少 --target-node");
  assert(args.sourceSheet, "在线表格模式缺少 --source-sheet");
  assert(args.targetSheet, "在线表格模式缺少 --target-sheet");

  const source = fetchSheetCsv(args.sourceNode, args.sourceSheet, args);
  const target = fetchSheetCsv(args.targetNode, args.targetSheet, args);
  const sourceRows = parseCsv(stripRowPrefixes(source.csvText), ",");
  const targetRows = parseCsv(stripRowPrefixes(target.csvText), ",");
  const syncResult = buildSyncResult(sourceRows, targetRows, args);
  const csvGetStats = { ...syncResult.report.stats };
  const csvGetMissingKeys = {
    inTarget: [...syncResult.report.missingKeys.inTarget],
    inSource: [...syncResult.report.missingKeys.inSource],
  };
  let report = {
    mode: "dws",
    source: {
      node: args.sourceNode,
      sheetInput: args.sourceSheet,
      sheetId: source.sheetId,
      sheetName: source.sheetName,
    },
    target: {
      node: args.targetNode,
      sheetInput: args.targetSheet,
      sheetId: target.sheetId,
      sheetName: target.sheetName,
    },
    matchStrategy: "csv-get",
    ...syncResult.report,
  };
  let usedFindFallback = false;
  let fallbackResult = null;

  if (
    syncResult.report.stats.matchedKeys === 0
    && syncResult.report.stats.sourceRecords > 0
    && syncResult.report.stats.targetRecords > 0
  ) {
    fallbackResult = syncDwsSheetsViaFind(source, target, args, syncResult);
    usedFindFallback = true;
    report = {
      ...report,
      matchStrategy: "find-fallback",
      csvGetStats,
      stats: {
        ...csvGetStats,
        ...fallbackResult.stats,
      },
      missingKeys: {
        ...csvGetMissingKeys,
        inTarget: fallbackResult.missingInTarget,
      },
      previewChanges: fallbackResult.changes.slice(0, args.maxPreview),
      findFallback: {
        used: true,
        keyColumn: KEY_COLUMN,
        keyColumnLetter: fallbackResult.keyColumnLetter,
        locatedRowSamples: fallbackResult.locatedRowSamples,
        duplicateFindHits: fallbackResult.duplicateFindHits,
        unreliableFields: ["stats.missingInSource", "missingKeys.inSource"],
      },
    };
  }

  if (usedFindFallback) {
    if (fallbackResult.rowWrites.length > 0) {
      report.writePlan = {
        strategy: "find+range-update",
        rowCount: fallbackResult.rowWrites.length,
        changedCells: fallbackResult.stats.changedCells,
        previewRanges: fallbackResult.rowWrites.slice(0, args.maxPreview).map((item) => ({
          key: item.key,
          rowNumber: item.rowNumber,
          range: item.range,
        })),
      };
    }

    if (!args.dryRun && fallbackResult.rowWrites.length > 0) {
      for (const rowWrite of fallbackResult.rowWrites) {
        writeSheetRangeValues(
          args.targetNode,
          target.sheetId,
          rowWrite.range,
          rowWrite.values,
          args,
        );
      }

      report.writeResult = {
        strategy: "find+range-update",
        updatedRows: fallbackResult.rowWrites.length,
        updatedCells: fallbackResult.stats.changedCells,
      };
    }

    return report;
  }

  const changedBlock = buildChangedBlockCsv(syncResult);

  if (changedBlock) {
    report.writePlan = {
      strategy: "csv-put",
      startCell: changedBlock.startCell,
      range: changedBlock.range,
      rowSpan: changedBlock.lastRow - changedBlock.firstRow + 1,
      columnSpan: changedBlock.maxCol - changedBlock.minCol + 1,
    };
  }

  if (!args.dryRun && changedBlock) {
    const writeResult = writeSheetCsv(
      args.targetNode,
      target.sheetId,
      changedBlock.csv,
      changedBlock.startCell,
      args,
    );
    report.writeResult = writeResult;
  }

  return report;
}

function writeReportIfNeeded(report, args) {
  if (!args.report) {
    return;
  }
  fs.writeFileSync(path.resolve(args.report), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  let report;
  if (args.mode === "local") {
    assert(args.source, "本地模式缺少 --source");
    assert(args.target, "本地模式缺少 --target");
    report = syncLocalTables(args);
  } else if (args.mode === "dws") {
    report = syncDwsSheets(args);
  } else {
    throw new Error(`不支持的模式: ${args.mode}`);
  }

  writeReportIfNeeded(report, args);
  console.log(JSON.stringify(report, null, 2));
}

try {
  main();
} catch (error) {
  console.error(
    JSON.stringify(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exit(1);
}
