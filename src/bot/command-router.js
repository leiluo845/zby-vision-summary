function normalizeCommand(text) {
  return String(text || "").trim().replace(/\s+/g, "");
}

function routeCommand(text) {
  const command = normalizeCommand(text);

  if (!command) {
    return { intent: "home" };
  }

  if (["手动同步", "同步表格", "同步"].includes(command)) {
    return { intent: "manual_sync", dryRun: false };
  }

  if (["预览同步", "预览"].includes(command)) {
    return { intent: "manual_sync", dryRun: true };
  }

  if (["最近同步记录", "同步记录", "最近记录"].includes(command)) {
    return { intent: "recent_runs" };
  }

  if (["是", "确认", "继续"].includes(command)) {
    return { intent: "confirm_yes" };
  }

  if (["否", "取消", "终止"].includes(command)) {
    return { intent: "confirm_no" };
  }

  if (["帮助", "同步帮助", "help"].includes(command.toLowerCase())) {
    return { intent: "help" };
  }

  return { intent: "unknown", rawText: String(text || "") };
}

module.exports = {
  normalizeCommand,
  routeCommand,
};
