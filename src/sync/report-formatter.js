const { formatDateTime } = require("../scheduler/cron-utils");

function formatFailureReason(reason) {
  if (reason.type === "conflict") {
    const sources = (reason.sources || [])
      .map((item) => `${item.jobLabel} 第 ${item.row} 行 = ${item.value}`)
      .join("；");
    return `${reason.field} 冲突：${sources}`;
  }

  if (reason.type === "duplicate_source_key") {
    return `${reason.jobLabel} 内货号重复，行号：${(reason.rows || []).join("、")}`;
  }

  if (reason.type === "duplicate_target_key") {
    return `总表货号重复，行号：${(reason.rows || []).join("、")}`;
  }

  if (reason.type === "missing_in_target") {
    return `${reason.jobLabel} 提供了该货号，但总表不存在，来源行：${reason.sourceRow}`;
  }

  return reason.message || "未知失败原因";
}

function formatFailedJobSummary(run) {
  const failedJobs = (run.jobs || []).filter((job) => job.status === "failed");
  if (failedJobs.length === 0) {
    return null;
  }

  return [
    "读取失败的分表：",
    ...failedJobs.map((job) => `  - ${job.jobLabel || job.jobId}：${job.errorMessage || "未知错误"}`),
  ].join("\n");
}

function formatRunMessage(run, timeZone) {
  if (!run) {
    return "暂无同步记录。";
  }

  if (run.status === "pending_confirmation") {
    return [
      "分表目标列存在空白单元格，是否仍要同步",
      "请回复：是 / 否",
    ].join("\n");
  }

  if (run.status === "cancelled") {
    return [
      "已终止本次同步流程",
      "原因：检测到分表目标列存在空白单元格，且用户选择不继续同步",
    ].join("\n");
  }

  if (run.status === "aborted_blank_risk") {
    return [
      "定时同步未执行",
      `时间：${formatDateTime(new Date(run.startedAt), timeZone)} ${timeZone}`,
      "原因：分表目标列存在空白单元格",
      "处理：已终止本次自动同步，请人工检查后再手动同步",
    ].join("\n");
  }

  const title = run.triggerType === "scheduled" ? "定时同步完成" : "同步完成";
  const resultText = `${run.summary.successfulJobs}/${run.summary.totalJobs} 个分表读取成功`;
  const durationText = typeof run.durationMs === "number" ? `${Math.round(run.durationMs / 1000)} 秒` : "未知";
  const failedJobSummary = formatFailedJobSummary(run);
  const failurePreview = (run.previewFailures || [])
    .slice(0, 3)
    .map((item) => `货号 ${item.key}：${item.reasons.map(formatFailureReason).join("；")}`)
    .join("\n");

  if (run.status === "failed") {
    const failedLines = [
      "同步失败",
      `计划：${run.planId}`,
    ];
    if (failedJobSummary) {
      failedLines.push(failedJobSummary);
      failedLines.push("提示：请检查以上分表的文档权限和 sheet 名称是否正确。");
    } else {
      failedLines.push(`原因：${run.errorMessage || "未知错误"}`);
    }
    return failedLines.join("\n");
  }

  const lines = [
    title,
    `计划：${run.planId}`,
    `结果：${resultText}`,
  ];
  if (failedJobSummary) {
    lines.push(failedJobSummary);
    lines.push("提示：请检查以上分表的文档权限和 sheet 名称是否正确。");
  }
  lines.push(`失败货号：${run.summary.failedKeys || 0}`);
  lines.push(`影响货号：${run.summary.affectedKeys}`);
  lines.push(`修改单元格：${run.summary.changedCells}`);
  if (run.summary.conflictedKeys) lines.push(`冲突货号：${run.summary.conflictedKeys}`);
  if (failurePreview) lines.push(`失败示例：\n${failurePreview}`);
  lines.push(`耗时：${durationText}`);
  return lines.join("\n");
}

function formatRecentRunsMessage(plan, runs, timeZone) {
  if (!runs.length) {
    return `计划：${plan.planId}\n暂无同步记录。`;
  }

  return [
    `计划：${plan.planId}`,
    ...runs.map((run, index) => (
      `${index + 1}. ${formatDateTime(new Date(run.startedAt), timeZone)} | ${run.status} | 失败货号 ${run.summary.failedKeys || 0} | 改动 ${run.summary.changedCells} 单元格`
    )),
  ].join("\n");
}

function formatBlankRiskMessage(summary) {
  const columnSummary = summary.columns
    .map((item) => `${item.jobLabel} / ${item.column} (${item.count})`)
    .join("；");
  const sampleSummary = summary.samples
    .map((item) => `${item.jobLabel} 第 ${item.row} 行 / 货号 ${item.key} / ${item.column}`)
    .join("；");

  return [
    "分表目标列存在空白单元格，是否仍要同步",
    `风险分表数：${summary.jobCount}`,
    `空白单元格数：${summary.blankCellCount}`,
    columnSummary ? `涉及列：${columnSummary}` : null,
    sampleSummary ? `样例：${sampleSummary}` : null,
    "请回复：是 / 否",
  ].filter(Boolean).join("\n");
}

function formatHelpMessage() {
  return [
    "欢迎使用总表同步机器人",
    "可用指令：",
    "手动同步",
    "最近同步记录",
    "是",
    "否",
  ].join("\n");
}

module.exports = {
  formatBlankRiskMessage,
  formatFailedJobSummary,
  formatHelpMessage,
  formatRecentRunsMessage,
  formatRunMessage,
};
