const configSummary = document.getElementById("configSummary");
const warningList = document.getElementById("warningList");
const jobList = document.getElementById("jobList");
const resultBox = document.getElementById("resultBox");
const runState = document.getElementById("runState");
const dryRunButton = document.getElementById("dryRunButton");
const syncButton = document.getElementById("syncButton");
const refreshStatusButton = document.getElementById("refreshStatusButton");

function setButtonsBusy(busy) {
  dryRunButton.disabled = busy;
  syncButton.disabled = busy;
  refreshStatusButton.disabled = busy;
}

function setRunState(label) {
  runState.textContent = label;
}

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

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(date);
}

function getUnreadSourceJobs(run) {
  return (run?.jobs || []).filter((job) => job?.status === "failed");
}

function formatUnreadSourceJob(job) {
  const label = job?.jobLabel || job?.jobId || "未命名分表";
  const reason = job?.errorMessage || "未知错误";
  return `${label}：${reason}`;
}

function summarizeJobRun(jobRun) {
  if (!jobRun) {
    return "尚无运行记录。";
  }

  if (jobRun.status === "failed") {
    return `读取失败：${jobRun.errorMessage || "未知错误"}`;
  }

  const sourceRecords = Number(jobRun.stats?.sourceRecords || 0);
  const duplicateKeys = Number(jobRun.stats?.duplicateKeys || 0);
  return `读取 ${sourceRecords} 条，分表内重复货号 ${duplicateKeys} 条。`;
}

function renderJobMappings(job) {
  const mappingItems = [];

  if (job?.keyMapping) {
    mappingItems.push(job.keyMapping);
  }

  for (const item of job?.fieldMappings || []) {
    mappingItems.push(item);
  }

  if (mappingItems.length === 0) {
    return "";
  }

  return `
    <section class="mapping-section">
      <div class="mapping-title">列匹配关系</div>
      <div class="mapping-list">
        ${mappingItems.map((item) => `
          <div class="mapping-row">
            <div class="mapping-field">${escapeHtml(item.label || item.field || "-")}</div>
            <div class="mapping-source">${escapeHtml(item.sourceDisplay || "-")}</div>
            <div class="mapping-arrow">→</div>
            <div class="mapping-target">${escapeHtml(item.targetDisplay || "-")}</div>
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function renderWarnings(config) {
  const planWarnings = (config?.auditWarnings || []).map((text) => ({
    label: "计划告警",
    text,
  }));
  const jobWarnings = (config?.syncJobs || []).flatMap((job) => (job.auditWarnings || []).map((text) => ({
    label: job.label,
    text,
  })));
  const warnings = [...planWarnings, ...jobWarnings];

  if (warnings.length === 0) {
    warningList.innerHTML = `
      <div class="empty-state">
        当前没有额外配置告警。
      </div>
    `;
    return;
  }

  warningList.innerHTML = warnings
    .map((warning) => `
      <article class="job-card">
        <div class="job-title-row">
          <div>
            <h3 class="job-title">${escapeHtml(warning.label)}</h3>
            <p class="job-meta">${escapeHtml(warning.text)}</p>
          </div>
        </div>
      </article>
    `)
    .join("");
}

function renderJobList(statusPayload, config) {
  const jobs = config?.syncJobs || [];
  const lastRunById = new Map((statusPayload?.lastRun?.jobs || []).map((job) => [job.jobId, job]));

  if (jobs.length === 0) {
    jobList.innerHTML = `
      <div class="empty-state">
        暂未配置分表。
      </div>
    `;
    return;
  }

  jobList.innerHTML = jobs
    .map((job) => {
      const lastJob = lastRunById.get(job.id);
      const badgeText = job.allowEmptyOverwrite ? "允许空白覆盖" : "空白不覆盖";
      return `
        <article class="job-card">
          <div class="job-title-row">
            <div>
              <h3 class="job-title">${escapeHtml(job.label)}</h3>
              <p class="job-path">${escapeHtml(job.sourceSheet)} → ${escapeHtml(job.targetSheet)}</p>
            </div>
            <div class="job-badge">${escapeHtml(badgeText)}</div>
          </div>
          <p class="job-meta">${escapeHtml(summarizeJobRun(lastJob))}</p>
          ${renderJobMappings(job)}
        </article>
      `;
    })
    .join("");
}

function renderConfig(statusPayload, configPayload) {
  const config = configPayload?.config;
  const lastRun = statusPayload?.lastRun;
  const cards = [
    ["计划", config?.appName || "-"],
    ["总表", config?.target?.sheet || "-"],
    ["分表数", config?.jobCount ?? "-"],
    ["上次同步", formatDateTime(lastRun?.finishedAt || lastRun?.startedAt)],
    ["失败货号", lastRun?.summary?.failedKeys ?? 0],
    ["改动单元格", lastRun?.summary?.changedCells ?? 0],
  ];

  configSummary.innerHTML = cards
    .map(
      ([label, value]) => `
        <div class="summary-card">
          <div class="summary-label">${escapeHtml(label)}</div>
          <div class="summary-value">${escapeHtml(value)}</div>
        </div>
      `,
    )
    .join("");

  renderWarnings(config);
  renderJobList(statusPayload, config);
}

function formatReason(reason) {
  if (reason.type === "conflict") {
    return `${reason.field} 冲突：${(reason.sources || []).map((item) => `${item.jobLabel} 第 ${item.row} 行 = ${item.value}`).join("；")}`;
  }
  if (reason.type === "duplicate_source_key") {
    return `${reason.jobLabel} 内重复，行号 ${Array.isArray(reason.rows) ? reason.rows.join("、") : ""}`;
  }
  if (reason.type === "duplicate_target_key") {
    return `总表内重复，行号 ${Array.isArray(reason.rows) ? reason.rows.join("、") : ""}`;
  }
  if (reason.type === "missing_in_target") {
    return `${reason.jobLabel} 提供了该货号，但总表不存在，来源行 ${reason.sourceRow}`;
  }
  return reason.message || "未知原因";
}

function formatRunResult(run) {
  if (!run) {
    return "暂无同步记录。";
  }

  const lines = [
    `状态：${run.status}`,
    `开始时间：${formatDateTime(run.startedAt)}`,
    `结束时间：${formatDateTime(run.finishedAt)}`,
    `分表读取成功：${run.summary?.successfulJobs || 0}/${run.summary?.totalJobs || 0}`,
    `失败货号：${run.summary?.failedKeys || 0}`,
    `冲突货号：${run.summary?.conflictedKeys || 0}`,
    `改动货号：${run.summary?.affectedKeys || 0}`,
    `改动单元格：${run.summary?.changedCells || 0}`,
  ];

  const failedJobs = (run.jobs || []).filter((job) => job.status === "failed");
  if (failedJobs.length > 0) {
    lines.push("");
    lines.push("读取失败的分表：");
    failedJobs.slice(0, 5).forEach((job) => {
      lines.push(`- ${job.jobLabel || job.jobId}：${job.errorMessage || "未知错误"}`);
    });
    if (failedJobs.length > 5) {
      lines.push(`  ... 还有 ${failedJobs.length - 5} 个分表`);
    }
  }

  if (run.previewFailures?.length) {
    lines.push("");
    lines.push("失败示例：");
    run.previewFailures.slice(0, 10).forEach((item) => {
      lines.push(`- 货号 ${item.key}`);
      item.reasons.forEach((reason) => {
        lines.push(`  ${formatReason(reason)}`);
      });
    });
  }

  if (run.previewChanges?.length) {
    lines.push("");
    lines.push("改动示例：");
    run.previewChanges.slice(0, 10).forEach((item) => {
      lines.push(`- ${item.key} / ${item.column}: ${item.oldValue || "(空)"} -> ${item.newValue || "(空)"}`);
    });
  }

  return lines.join("\n");
}

function renderResult(payload) {
  const run = payload?.result || payload?.lastRun || payload;
  resultBox.textContent = typeof run === "string" ? run : formatRunResult(run);
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

function updateRunStateFromStatus(statusPayload) {
  const current = statusPayload?.currentRun;
  if (current?.status === "running") {
    setRunState(current.dryRun ? "预览中" : "同步中");
    return;
  }

  setRunState("空闲");
}

async function refreshStatus(options = {}) {
  const renderPayload = options.renderPayload !== false;
  const manageBusy = options.manageBusy !== false;

  if (manageBusy) {
    setButtonsBusy(true);
    setRunState("检查中");
  }

  try {
    const [status, config] = await Promise.all([
      fetchJson("/api/status"),
      fetchJson("/api/config"),
    ]);

    renderConfig(status, config);
    if (renderPayload) {
      renderResult(status.lastRun);
    }
    updateRunStateFromStatus(status);
    return { status, config };
  } catch (error) {
    renderResult(`加载失败：${error.message}`);
    setRunState("空闲");
    throw error;
  } finally {
    if (manageBusy) {
      setButtonsBusy(false);
    }
  }
}

function buildRunAlert(run, dryRun) {
  if (!run) {
    return dryRun ? "预览完成。" : "同步完成。";
  }

  const failedJobs = (run.jobs || []).filter((job) => job.status === "failed");
  if (failedJobs.length > 0) {
    const failedJobMessages = failedJobs.slice(0, 3)
      .map((job) => `\n- ${job.jobLabel || job.jobId}：${job.errorMessage || "未知错误"}`)
      .join("");
    const suffix = failedJobs.length > 3 ? `\n  ... 还有 ${failedJobs.length - 3} 个分表` : "";
    const summary = dryRun ? "预览完成" : "同步完成";
    return `${summary}，但有 ${failedJobs.length} 个分表读取失败：${failedJobMessages}${suffix}`;
  }

  if ((run.summary?.failedKeys || 0) === 0 && (run.summary?.failedJobs || 0) === 0) {
    return dryRun
      ? `预览完成，没有检测到失败货号。预计改动 ${run.summary?.changedCells || 0} 个单元格。`
      : `同步成功，已改动 ${run.summary?.changedCells || 0} 个单元格。`;
  }

  const firstFailure = run.previewFailures?.[0];
  const reasonText = firstFailure
    ? `\n示例：货号 ${firstFailure.key}，${firstFailure.reasons.map(formatReason).join("；")}`
    : "";
  return `${dryRun ? "预览完成" : "同步完成"}，但有 ${run.summary?.failedKeys || 0} 个货号同步失败。${reasonText}`;
}

async function runSync(dryRun) {
  setButtonsBusy(true);
  setRunState(dryRun ? "预览中" : "同步中");

  try {
    const payload = await fetchJson("/api/sync", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ dryRun }),
    });

    renderResult(payload);
    await refreshStatus({
      renderPayload: false,
      manageBusy: false,
    });
    window.alert(buildRunAlert(payload.result, dryRun));
  } catch (error) {
    renderResult(`执行失败：${error.message}`);
    setRunState("空闲");
    window.alert(`执行失败：${error.message}`);
  } finally {
    setButtonsBusy(false);
  }
}

dryRunButton.addEventListener("click", () => {
  runSync(true);
});

syncButton.addEventListener("click", () => {
  const confirmed = window.confirm("本次同步只会写总表，不会修改任何分表。确认继续吗？");
  if (confirmed) {
    runSync(false);
  }
});

refreshStatusButton.addEventListener("click", () => {
  refreshStatus();
});

refreshStatus();
