const DEFAULT_KEY_COLUMN = "货号";
const DEFAULT_SYNC_FIELDS = [
  "齐色主附图完成时间",
  "A+完成时间",
  "视频完成时间",
];
const DEFAULT_PLACEHOLDER_VALUES = ["/"];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function cloneRows(rows) {
  return rows.map((row) => row.slice());
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).trim()))];
}

function buildHeaderAliases(keyColumn, columnMapping, customAliases) {
  const merged = { ...customAliases };
  merged[keyColumn] = unique([keyColumn, ...(merged[keyColumn] || [])]);

  for (const [sourceColumn, targetColumn] of Object.entries(columnMapping)) {
    merged[sourceColumn] = unique([sourceColumn, targetColumn, ...(merged[sourceColumn] || [])]);
    merged[targetColumn] = unique([targetColumn, sourceColumn, ...(merged[targetColumn] || [])]);
  }

  return merged;
}

function readText(text) {
  return String(text || "").replace(/^\uFEFF/, "");
}

function detectDelimiter(text) {
  const candidates = [",", "\t", ";"];
  const lines = readText(text)
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

function writeCsv(rows, delimiter = ",") {
  return rows
    .map((row) => row.map((value) => escapeCsvValue(value, delimiter)).join(delimiter))
    .join("\r\n");
}

function normalizeHeader(value) {
  return String(value ?? "").trim();
}

function normalizeKey(value) {
  return String(value ?? "").trim();
}

function ensureRowWidth(row, width) {
  while (row.length < width) {
    row.push("");
  }
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

function getHeaderAliases(rules, header) {
  return rules.headerAliases[header] || [header];
}

function findHeaderRow(rows, requiredHeaders, rules) {
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, 20); rowIndex += 1) {
    const row = rows[rowIndex].map(normalizeHeader);
    const columnIndexByHeader = {};
    let matched = true;

    for (const header of requiredHeaders) {
      const aliases = getHeaderAliases(rules, header).map(normalizeHeader);
      const columnIndex = row.findIndex((cell) => aliases.includes(cell));
      if (columnIndex === -1) {
        matched = false;
        break;
      }
      columnIndexByHeader[header] = columnIndex;
    }

    if (matched) {
      return { rowIndex, columnIndexByHeader };
    }
  }

  throw new Error(`未找到表头，缺少列: ${requiredHeaders.join(", ")}`);
}

function buildHeaderDiagnostics(rows, headerInfo, keyColumn) {
  const headerRow = rows[headerInfo.rowIndex] || [];
  const keyColumnIndex = headerInfo.columnIndexByHeader[keyColumn];

  return {
    headerRowIndex: headerInfo.rowIndex + 1,
    keyColumnIndex,
    keyColumnLetter: excelColumnName(keyColumnIndex),
    keyColumnHeader: headerRow[keyColumnIndex] ?? "",
    headerRowValues: headerRow,
  };
}

function buildRecordIndex(rows, headerInfo, requiredHeaders, keyColumn) {
  const keyColumnIndex = headerInfo.columnIndexByHeader[keyColumn];
  const duplicateKeys = new Set();
  const keyRows = new Map();
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
    if (!keyRows.has(key)) {
      keyRows.set(key, []);
    }
    keyRows.get(key).push(rowIndex + 1);
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

  return {
    index,
    keys: [...index.keys()],
    duplicateKeys: [...duplicateKeys].sort(),
    duplicateKeyRows: [...duplicateKeys]
      .sort()
      .map((key) => ({ key, rows: [...(keyRows.get(key) || [])] })),
    recordCount,
  };
}

function normalizeCompactRules(input = {}) {
  const nestedRules = input.rules || {};
  const keyColumn = String(nestedRules.keyColumn || input.keyColumn || DEFAULT_KEY_COLUMN).trim();
  const fields = unique(
    (
      nestedRules.fields
      || input.fields
      || Object.keys(input.target?.columns || {}).filter((field) => field !== keyColumn)
      || DEFAULT_SYNC_FIELDS
    ).map((value) => String(value || "").trim()),
  );
  const placeholderValues = unique(
    (
      nestedRules.placeholderValues
      || input.placeholderValues
      || DEFAULT_PLACEHOLDER_VALUES
    ).map((value) => String(value || "").trim()),
  );

  return {
    keyColumn,
    fields: fields.length > 0 ? fields : [...DEFAULT_SYNC_FIELDS],
    placeholderValues,
    maxPreview: Number.isFinite(Number(input.maxPreview || nestedRules.maxPreview))
      ? Number(input.maxPreview || nestedRules.maxPreview)
      : 20,
  };
}

function normalizeFieldSpec(field, spec) {
  if (spec == null) {
    return {
      field,
      constant: null,
    };
  }

  if (typeof spec === "string") {
    return {
      field,
      sourceHeader: spec,
      constant: null,
    };
  }

  return {
    field,
    sourceHeader: spec.sourceHeader || spec.header || field,
    constant: spec.constant == null ? null : String(spec.constant),
  };
}

function getJobFieldSpec(job, field) {
  const fields = job.fields || job.fieldMappings || {};
  return normalizeFieldSpec(field, fields[field]);
}

function normalizePlaceholder(value, rules) {
  const text = String(value ?? "").trim();
  return rules.placeholderValues.includes(text) ? text : null;
}

function classifySyncValue(value, rules) {
  const rawValue = value == null ? "" : String(value);
  if (rawValue.trim() === "") {
    return {
      kind: "blank",
      rawValue: "",
      normalized: "",
    };
  }

  const placeholder = normalizePlaceholder(rawValue, rules);
  if (placeholder) {
    return {
      kind: "placeholder",
      rawValue,
      normalized: placeholder,
    };
  }

  return {
    kind: "actual",
    rawValue,
    normalized: rawValue,
  };
}

function normalizeComparableSyncValue(value, rules) {
  const classified = classifySyncValue(value, rules);
  if (classified.kind === "blank") {
    return "";
  }
  return `${classified.kind}:${classified.normalized}`;
}

function addFailureReason(failureMap, key, reason) {
  if (!failureMap.has(key)) {
    failureMap.set(key, []);
  }

  const reasons = failureMap.get(key);
  const signature = JSON.stringify(reason);
  if (!reasons.some((item) => JSON.stringify(item) === signature)) {
    reasons.push(reason);
  }
}

function buildCompactHeaderRows(rows, keyColumn, fields, maxPreview) {
  const requiredHeaders = [keyColumn, ...fields];
  const rules = buildHeaderAliases(keyColumn, Object.fromEntries(fields.map((field) => [field, field])), {});
  return findHeaderRow(rows, requiredHeaders, {
    headerAliases: rules,
  });
}

function buildSourceContribution(job, sourceRecord, field, rules) {
  const fieldSpec = getJobFieldSpec(job, field);
  const rawValue = fieldSpec.constant == null
    ? sourceRecord.values[field] ?? ""
    : fieldSpec.constant;
  const classified = classifySyncValue(rawValue, rules);

  return {
    jobId: job.id,
    jobLabel: job.label,
    field,
    sourceRow: sourceRecord.rowIndex + 1,
    rawValue: classified.rawValue,
    kind: classified.kind,
    normalized: classified.normalized,
    comparable: normalizeComparableSyncValue(rawValue, rules),
  };
}

function summarizeFailureTypes(failures, type) {
  return failures.filter((item) => item.reasons.some((reason) => reason.type === type)).length;
}

function resolveConfiguredTargetColumnLetter(planInput, field, fallbackColumnIndex) {
  return planInput?.target?.columns?.[field]?.column || excelColumnName(fallbackColumnIndex);
}

function buildAggregatedSyncResult(targetRowsInput, sourceJobsInput, planInput = {}, options = {}) {
  const rules = normalizeCompactRules({ ...planInput, maxPreview: options.maxPreview ?? planInput.maxPreview });
  const keyColumn = rules.keyColumn;
  const fields = rules.fields;
  const targetRows = cloneRows(targetRowsInput);
  const sourceJobs = sourceJobsInput || [];
  const requiredHeaders = [keyColumn, ...fields];
  const compactAliases = buildHeaderAliases(
    keyColumn,
    Object.fromEntries(fields.map((field) => [field, field])),
    {},
  );
  const compactRules = {
    headerAliases: compactAliases,
  };
  const targetHeaderInfo = findHeaderRow(targetRows, requiredHeaders, compactRules);
  const targetRecords = buildRecordIndex(targetRows, targetHeaderInfo, requiredHeaders, keyColumn);
  const targetHeaderDiagnostics = buildHeaderDiagnostics(targetRows, targetHeaderInfo, keyColumn);
  const updatedTargetRows = cloneRows(targetRows);
  const targetDuplicateKeys = new Set(targetRecords.duplicateKeys);
  const targetRecordByKey = targetRecords.index;
  const targetFieldIndices = Object.fromEntries(
    fields.map((field) => [field, targetHeaderInfo.columnIndexByHeader[field]]),
  );
  const failureMap = new Map();
  const keyStates = new Map();
  const matchedKeys = new Set();
  const sourceJobReports = [];
  let totalSourceRecords = 0;

  for (const duplicate of targetRecords.duplicateKeyRows) {
    addFailureReason(failureMap, duplicate.key, {
      type: "duplicate_target_key",
      message: "总表存在重复货号，已跳过该货号。",
      rows: duplicate.rows,
    });
  }

  for (const sourceJob of sourceJobs) {
    const job = sourceJob.job || sourceJob;

    try {
      const sourceRows = cloneRows(sourceJob.rows || []);
      const sourceHeaderInfo = findHeaderRow(sourceRows, requiredHeaders, compactRules);
      const sourceRecords = buildRecordIndex(sourceRows, sourceHeaderInfo, requiredHeaders, keyColumn);
      totalSourceRecords += sourceRecords.recordCount;

      for (const [key, sourceRecord] of sourceRecords.index.entries()) {
        if (targetDuplicateKeys.has(key)) {
          continue;
        }

        if (!targetRecordByKey.has(key)) {
          addFailureReason(failureMap, key, {
            type: "missing_in_target",
            message: "总表不存在该货号，未新增写入。",
            jobId: job.id,
            jobLabel: job.label,
            sourceRow: sourceRecord.rowIndex + 1,
          });
          continue;
        }

        matchedKeys.add(key);
        let keyState = keyStates.get(key);
        if (!keyState) {
          keyState = {
            fieldStates: new Map(),
          };
          keyStates.set(key, keyState);
        }

        for (const field of fields) {
          const contribution = buildSourceContribution(job, sourceRecord, field, rules);

          let fieldState = keyState.fieldStates.get(field);
          if (!fieldState) {
            fieldState = {
              chosen: null,
              contributions: [],
              contributionsByValue: new Map(),
            };
            keyState.fieldStates.set(field, fieldState);
          }

          if (fieldState.chosen == null) {
            fieldState.chosen = contribution;
          }

          fieldState.contributions.push(contribution);

          if (!fieldState.contributionsByValue.has(contribution.comparable)) {
            fieldState.contributionsByValue.set(contribution.comparable, contribution);
          }
        }
      }

      sourceJobReports.push({
        jobId: job.id,
        jobLabel: job.label,
        status: "succeeded",
        sourceMeta: sourceJob.meta || null,
        stats: {
          sourceRecords: sourceRecords.recordCount,
          duplicateKeys: sourceRecords.duplicateKeys.length,
        },
      });
    } catch (error) {
      sourceJobReports.push({
        jobId: job.id,
        jobLabel: job.label,
        status: "failed",
        sourceMeta: sourceJob.meta || null,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const [key, keyState] of keyStates.entries()) {
    for (const [field, fieldState] of keyState.fieldStates.entries()) {
      if (fieldState.contributionsByValue.size <= 1) {
        continue;
      }

      addFailureReason(failureMap, key, {
        type: "conflict",
        field,
        message: "同一货号在多个分表中提供了不同的值（包括空值），已跳过该货号。",
        sources: fieldState.contributions.map((contribution) => ({
          jobId: contribution.jobId,
          jobLabel: contribution.jobLabel,
          row: contribution.sourceRow,
          value: contribution.rawValue,
        })),
      });
    }
  }

  const changes = [];
  const rowWrites = [];
  const affectedKeys = new Set();

  for (const [key, targetRecord] of targetRecordByKey.entries()) {
    const keyReasons = failureMap.get(key) || [];
    if (keyReasons.length > 0) {
      continue;
    }

    const pendingChanges = [];
    const keyState = keyStates.get(key);
    if (!keyState) {
      continue;
    }

    for (const field of fields) {
      const chosen = keyState.fieldStates.get(field)?.chosen;
      const currentValue = targetRecord?.values[field] ?? "";
      const desiredValue = chosen.rawValue;

      if (normalizeComparableSyncValue(desiredValue, rules) !== normalizeComparableSyncValue(currentValue, rules)) {
        pendingChanges.push({
          key,
          field,
          oldValue: currentValue,
          newValue: desiredValue,
          source: chosen || null,
        });
      }
    }

    if (pendingChanges.length === 0) {
      continue;
    }

    affectedKeys.add(key);
    const afterValues = { ...targetRecord.values };
    for (const change of pendingChanges) {
      const columnIndex = targetFieldIndices[change.field];
      ensureRowWidth(updatedTargetRows[targetRecord.rowIndex], columnIndex + 1);
      updatedTargetRows[targetRecord.rowIndex][columnIndex] = change.newValue;
      afterValues[change.field] = change.newValue;
      changes.push({
        key,
        column: change.field,
        oldValue: change.oldValue,
        newValue: change.newValue,
        targetRow: targetRecord.rowIndex + 1,
        targetColumnLetter: resolveConfiguredTargetColumnLetter(planInput, change.field, columnIndex),
        sourceJobId: change.source?.jobId || null,
        sourceJobLabel: change.source?.jobLabel || null,
        sourceRow: change.source?.sourceRow || null,
      });
    }

    rowWrites.push({
      key,
      rowIndex: targetRecord.rowIndex,
      rowNumber: targetRecord.rowIndex + 1,
      beforeValues: { ...targetRecord.values },
      afterValues,
      changes: pendingChanges.map((item) => ({
        field: item.field,
        oldValue: item.oldValue,
        newValue: item.newValue,
        source: item.source,
      })),
    });
  }

  const failures = [...failureMap.entries()].map(([key, reasons]) => ({
    key,
    reasons,
  }));
  const summary = {
    totalJobs: sourceJobs.length,
    successfulJobs: sourceJobReports.filter((item) => item.status === "succeeded").length,
    failedJobs: sourceJobReports.filter((item) => item.status === "failed").length,
    sourceRecords: totalSourceRecords,
    targetRecords: targetRecords.recordCount,
    matchedKeys: matchedKeys.size,
    affectedKeys: affectedKeys.size,
    changedCells: changes.length,
    changedRows: rowWrites.length,
    failedKeys: failures.length,
    conflictedKeys: summarizeFailureTypes(failures, "conflict"),
    duplicateSourceKeys: 0,
    duplicateTargetKeys: summarizeFailureTypes(failures, "duplicate_target_key"),
    missingInTargetKeys: summarizeFailureTypes(failures, "missing_in_target"),
  };

  return {
    targetHeaderInfo,
    targetRecords,
    updatedTargetRows,
    changes,
    rowWrites: rowWrites.sort((left, right) => left.rowIndex - right.rowIndex),
    failures,
    jobs: sourceJobReports,
    report: {
      dryRun: Boolean(options.dryRun),
      headerRows: {
        target: targetHeaderInfo.rowIndex + 1,
      },
      headerDiagnostics: {
        target: targetHeaderDiagnostics,
      },
      stats: summary,
      duplicateKeys: {
        target: targetRecords.duplicateKeys,
      },
      failures,
      previewFailures: failures.slice(0, rules.maxPreview),
      previewChanges: changes.slice(0, rules.maxPreview),
      jobs: sourceJobReports,
    },
  };
}

module.exports = {
  DEFAULT_KEY_COLUMN,
  DEFAULT_SYNC_FIELDS,
  assert,
  buildAggregatedSyncResult,
  cloneRows,
  detectDelimiter,
  excelColumnName,
  findHeaderRow,
  parseCsv,
  writeCsv,
};
