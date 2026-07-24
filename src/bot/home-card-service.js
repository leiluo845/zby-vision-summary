const { formatDateTime, getNextRunDate } = require("../scheduler/cron-utils");

class HomeCardService {
  constructor({ runRepo, now = () => new Date() }) {
    this.runRepo = runRepo;
    this.now = now;
  }

  build(plan) {
    const lastRun = this.runRepo.getLastByPlan(plan.planId);
    const nextRunDate = getNextRunDate(plan.schedule.crons || [], plan.timezone || "Asia/Shanghai", this.now());

    return {
      planId: plan.planId,
      planName: plan.name,
      lastSyncTime: lastRun
        ? formatDateTime(new Date(lastRun.finishedAt || lastRun.startedAt), plan.timezone || "Asia/Shanghai")
        : "暂无记录",
      nextAutoSyncTime: nextRunDate
        ? formatDateTime(nextRunDate, plan.timezone || "Asia/Shanghai")
        : "未配置",
      actions: [
        { action: "manual_sync", label: "手动同步" },
        { action: "recent_runs", label: "最近同步记录" },
      ],
      text: [
        "欢迎使用总表同步机器人",
        `上次同步时间：${lastRun ? formatDateTime(new Date(lastRun.finishedAt || lastRun.startedAt), plan.timezone || "Asia/Shanghai") : "暂无记录"}`,
        `下次自动同步时间：${nextRunDate ? formatDateTime(nextRunDate, plan.timezone || "Asia/Shanghai") : "未配置"}`,
      ].join("\n"),
    };
  }
}

module.exports = {
  HomeCardService,
};
