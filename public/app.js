const syncButton = document.getElementById("syncButton");
const configButton = document.getElementById("configButton");
const configDialog = document.getElementById("configDialog");
const closeConfigButton = document.getElementById("closeConfigButton");
const configContent = document.getElementById("configContent");
const resultBox = document.getElementById("resultBox");
const progressBar = document.getElementById("progressBar");
const conflictDialog = document.getElementById("conflictDialog");
const closeConflictButton = document.getElementById("closeConflictButton");
const conflictContent = document.getElementById("conflictContent");
const failureDialog = document.getElementById("failureDialog");
const closeFailureButton = document.getElementById("closeFailureButton");
const failureContent = document.getElementById("failureContent");

let statusTimer = null;
let statusRequestPending = false;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDateTime(value) {
  if (!value) {
    return "暂无";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "暂无";
  }

  const parts = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZone: "Asia/Shanghai",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.round(Number(durationMs || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes} 分 ${seconds} 秒`;
}

function getSourceDisplayLabel(job) {
  const jobId = job?.id || job?.jobId;
  if (jobId === "sheet_08") {
    return "分表⑦TK上架对接表（新）";
  }
  return job?.label || job?.jobLabel || jobId || "-";
}

function getConflictDetails(run) {
  const rawConflicts = Array.isArray(run?.conflicts)
    ? run.conflicts
    : (run?.failures || []).flatMap((failure) => {
      const reasons = (failure.reasons || []).filter((reason) => reason.type === "conflict");
      return reasons.length > 0
        ? [{ key: failure.key, sources: reasons.flatMap((reason) => reason.sources || []) }]
        : [];
    });

  return rawConflicts.map((conflict) => {
    const sourcesByJob = new Map();
    for (const source of conflict.sources || []) {
      const sourceObject = typeof source === "string" ? { jobLabel: source } : source;
      const sourceKey = sourceObject.jobId || sourceObject.jobLabel;
      if (sourceKey && !sourcesByJob.has(sourceKey)) {
        sourcesByJob.set(sourceKey, sourceObject);
      }
    }
    return {
      key: String(conflict.key || "-"),
      sources: [...sourcesByJob.values()],
    };
  });
}

function getFailedJobDetails(run) {
  return (run?.jobs || [])
    .filter((job) => job.status === "failed")
    .map((job) => ({
      label: getSourceDisplayLabel(job),
      errorMessage: String(job.errorMessage || "未返回具体失败原因"),
    }));
}

function appendStatusLine(text, className = "") {
  const line = document.createElement("div");
  line.className = `status-line ${className}`.trim();
  line.textContent = text;
  resultBox.append(line);
  return line;
}

function renderConflictDetails(conflicts) {
  conflictContent.replaceChildren();
  if (conflicts.length === 0) {
    const emptyMessage = document.createElement("p");
    emptyMessage.className = "empty-message";
    emptyMessage.textContent = "暂无冲突货号。";
    conflictContent.append(emptyMessage);
    return;
  }

  const table = document.createElement("table");
  table.className = "details-table";
  const tableHead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (const heading of ["冲突货号", "所在分表"]) {
    const header = document.createElement("th");
    header.scope = "col";
    header.textContent = heading;
    headerRow.append(header);
  }
  tableHead.append(headerRow);

  const tableBody = document.createElement("tbody");
  for (const conflict of conflicts) {
    const row = document.createElement("tr");
    const keyCell = document.createElement("td");
    const sheetsCell = document.createElement("td");
    keyCell.textContent = conflict.key;
    sheetsCell.textContent = conflict.sources.map(getSourceDisplayLabel).join("、") || "未知分表";
    row.append(keyCell, sheetsCell);
    tableBody.append(row);
  }
  table.append(tableHead, tableBody);
  conflictContent.append(table);
}

function renderFailedJobDetails(failedJobs) {
  failureContent.replaceChildren();
  if (failedJobs.length === 0) {
    const emptyMessage = document.createElement("p");
    emptyMessage.className = "empty-message";
    emptyMessage.textContent = "暂无同步失败分表。";
    failureContent.append(emptyMessage);
    return;
  }

  const table = document.createElement("table");
  table.className = "details-table failure-table";
  const tableHead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (const heading of ["失败分表", "失败原因"]) {
    const header = document.createElement("th");
    header.scope = "col";
    header.textContent = heading;
    headerRow.append(header);
  }
  tableHead.append(headerRow);

  const tableBody = document.createElement("tbody");
  for (const failedJob of failedJobs) {
    const row = document.createElement("tr");
    const labelCell = document.createElement("td");
    const errorCell = document.createElement("td");
    labelCell.textContent = failedJob.label;
    errorCell.textContent = failedJob.errorMessage;
    row.append(labelCell, errorCell);
    tableBody.append(row);
  }
  table.append(tableHead, tableBody);
  failureContent.append(table);
}

function renderRun(run) {
  resultBox.replaceChildren();
  if (!run) {
    appendStatusLine("暂无同步记录。");
    resultBox.setAttribute("aria-busy", "false");
    progressBar.hidden = true;
    renderConflictDetails([]);
    renderFailedJobDetails([]);
    return;
  }

  const summary = run.summary || {};
  const failedJobs = getFailedJobDetails(run);
  const conflicts = getConflictDetails(run);

  appendStatusLine(`同步时间：${formatDateTime(run.finishedAt || run.startedAt)}；`);
  appendStatusLine(`${summary.successfulJobs ?? 0}/${summary.totalJobs ?? 10} 张分表同步成功；`);
  const failureLine = appendStatusLine(
    `同步失败分表：${failedJobs.map((job) => job.label).join("、") || "无"}；`,
    "details-summary-line",
  );
  if (failedJobs.length > 0) {
    const failureDetailsButton = document.createElement("button");
    failureDetailsButton.className = "details-button";
    failureDetailsButton.type = "button";
    failureDetailsButton.textContent = "点击查看失败原因";
    failureDetailsButton.setAttribute("aria-haspopup", "dialog");
    failureDetailsButton.addEventListener("click", () => failureDialog.showModal());
    failureLine.append(failureDetailsButton);
  }
  appendStatusLine(`更新总表 ${summary.changedRows ?? 0} 行；`);
  appendStatusLine(`更新 ${summary.changedCells ?? 0} 个单元格；`);
  appendStatusLine(`${summary.missingInTargetKeys ?? 0} 个分表货号在总表中不存在，按规则未新增；`);
  const conflictLine = appendStatusLine(`${summary.conflictedKeys ?? conflicts.length} 个冲突货号；`, "details-summary-line");
  if (conflicts.length > 0) {
    const detailsButton = document.createElement("button");
    detailsButton.className = "details-button";
    detailsButton.type = "button";
    detailsButton.textContent = "点击查看冲突货号";
    detailsButton.setAttribute("aria-haspopup", "dialog");
    detailsButton.addEventListener("click", () => conflictDialog.showModal());
    conflictLine.append(detailsButton);
  }
  appendStatusLine(`耗时约 ${formatDuration(run.durationMs)}；`);
  renderConflictDetails(conflicts);
  renderFailedJobDetails(failedJobs);
  resultBox.setAttribute("aria-busy", "false");
  progressBar.hidden = true;
}

function renderProgress(currentRun) {
  const progress = Math.min(100, Math.max(0, Number(currentRun?.progress || 0)));
  resultBox.textContent = `同步中...\n已完成 ${progress}%`;
  resultBox.setAttribute("aria-busy", "true");
  progressBar.value = progress;
  progressBar.hidden = false;
  renderConflictDetails([]);
  renderFailedJobDetails([]);
}

function renderConfig(config) {
  const jobs = config?.syncJobs || [];
  const firstJob = jobs[0] || {};
  const mappings = [firstJob.keyMapping, ...(firstJob.fieldMappings || [])].filter(Boolean);

  configContent.innerHTML = `
    <section class="dialog-section">
      <h3>同步配置</h3>
      <dl class="config-list">
        <div><dt>计划</dt><dd>${escapeHtml(config?.appName || "-")}</dd></div>
        <div><dt>总表</dt><dd>${escapeHtml(config?.target?.sheet || "-")}</dd></div>
        <div><dt>分表数量</dt><dd>${escapeHtml(config?.jobCount ?? jobs.length)} 张</dd></div>
      </dl>
    </section>

    <section class="dialog-section">
      <h3>字段映射</h3>
      <div class="mapping-table" role="table" aria-label="字段映射">
        ${mappings.map((mapping) => `
          <div class="mapping-row" role="row">
            <span class="mapping-name" role="cell">${escapeHtml(mapping.label || mapping.field)}</span>
            <span role="cell"><span class="mapping-mobile-label">分表：</span>${escapeHtml(mapping.sourceDisplay || "-")}</span>
            <span class="mapping-arrow" aria-hidden="true">&rarr;</span>
            <span role="cell"><span class="mapping-mobile-label">总表：</span>${escapeHtml(mapping.targetDisplay || "-")}</span>
          </div>
        `).join("")}
      </div>
    </section>

    <section class="dialog-section">
      <h3>分表</h3>
      <ol class="source-list">
        ${jobs.map((job) => `
          <li><strong>${escapeHtml(getSourceDisplayLabel(job))}</strong><span>${escapeHtml(job.sourceSheet || "-")}</span></li>
        `).join("")}
      </ol>
    </section>

    <section class="dialog-section">
      <h3>同步规则</h3>
      <ol class="rule-list">
        <li>仅在用户点击“同步”并确认后执行，不自动同步。</li>
        <li>分表只读；系统只写入配置中的固定总表。</li>
        <li>分表货号的三个时间字段按原值同步，空白值也会覆盖总表。</li>
        <li>货号未出现在任何分表中时，总表原值保持不变。</li>
        <li>分表货号在总表中不存在时，记录数量但不新增总表行。</li>
        <li>同一货号跨分表字段值不同（包括空白与非空）时，按冲突跳过整个货号。</li>
        <li>同一分表内货号重复时取第一行；总表货号重复时跳过该货号。</li>
        <li>单张分表读取失败时，其他成功读取的分表仍允许写入。</li>
        <li>写入前校验固定总表节点和 Sheet ID，护栏不匹配时停止写入。</li>
      </ol>
    </section>
  `;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `请求失败：${response.status}`);
  }
  return payload;
}

function setSyncBusy(busy) {
  syncButton.disabled = busy;
}

function stopStatusPolling() {
  if (statusTimer) {
    window.clearInterval(statusTimer);
    statusTimer = null;
  }
}

async function refreshStatus() {
  const payload = await fetchJson("/api/status");
  renderConfig(payload.plan);

  if (payload.currentRun?.status === "running") {
    setSyncBusy(true);
    renderProgress(payload.currentRun);
    startStatusPolling();
  } else {
    setSyncBusy(false);
    renderRun(payload.lastRun);
    stopStatusPolling();
  }

  return payload;
}

async function pollStatus() {
  if (statusRequestPending) {
    return;
  }

  statusRequestPending = true;
  try {
    await refreshStatus();
  } catch (error) {
    stopStatusPolling();
    setSyncBusy(false);
    resultBox.textContent = `状态读取失败：${error.message}`;
    resultBox.setAttribute("aria-busy", "false");
    progressBar.hidden = true;
  } finally {
    statusRequestPending = false;
  }
}

function startStatusPolling() {
  if (!statusTimer) {
    statusTimer = window.setInterval(pollStatus, 500);
  }
}

async function runSync() {
  const confirmed = window.confirm("本次同步会读取 10 张分表并写入固定总表，分表不会被修改。确认继续吗？");
  if (!confirmed) {
    return;
  }

  setSyncBusy(true);
  renderProgress({ progress: 0 });
  startStatusPolling();

  try {
    const payload = await fetchJson("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: false }),
    });
    stopStatusPolling();
    renderRun(payload.result);
  } catch (error) {
    stopStatusPolling();
    resultBox.textContent = `同步失败；\n${error.message}；`;
    resultBox.setAttribute("aria-busy", "false");
    progressBar.hidden = true;
  } finally {
    setSyncBusy(false);
  }
}

syncButton.addEventListener("click", runSync);

configButton.addEventListener("click", () => {
  configDialog.showModal();
});

closeConfigButton.addEventListener("click", () => {
  configDialog.close();
});

configDialog.addEventListener("click", (event) => {
  if (event.target === configDialog) {
    configDialog.close();
  }
});

closeConflictButton.addEventListener("click", () => {
  conflictDialog.close();
});

conflictDialog.addEventListener("click", (event) => {
  if (event.target === conflictDialog) {
    conflictDialog.close();
  }
});

closeFailureButton.addEventListener("click", () => {
  failureDialog.close();
});

failureDialog.addEventListener("click", (event) => {
  if (event.target === failureDialog) {
    failureDialog.close();
  }
});

refreshStatus().catch((error) => {
  setSyncBusy(false);
  configContent.textContent = `配置读取失败：${error.message}`;
  resultBox.textContent = `最近一次同步情况读取失败：${error.message}`;
});
