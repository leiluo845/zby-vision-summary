const { cronMatchesDate, formatDateTime } = require("./cron-utils");

class CronRunner {
  constructor({ planRepo, syncService, logger = console, now = () => new Date() }) {
    this.planRepo = planRepo;
    this.syncService = syncService;
    this.logger = logger;
    this.now = now;
    this.timer = null;
    this.triggeredSlots = new Map();
  }

  start() {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        this.logger.error("Scheduler tick failed:", error);
      });
    }, 30000);

    this.tick().catch((error) => {
      this.logger.error("Initial scheduler tick failed:", error);
    });
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick() {
    const now = this.now();
    const plans = this.planRepo.listEnabledPlans();

    for (const plan of plans) {
      const timeZone = plan.timezone || "Asia/Shanghai";
      const slotKey = `${plan.planId}:${formatDateTime(now, timeZone).slice(0, 16)}`;
      const matches = (plan.schedule.crons || []).some((cron) => cronMatchesDate(cron, timeZone, now));

      if (!matches || this.triggeredSlots.has(slotKey)) {
        continue;
      }

      this.triggeredSlots.set(slotKey, now.toISOString());
      await this.syncService.runScheduled(plan.planId);
    }

    if (this.triggeredSlots.size > 200) {
      const keys = [...this.triggeredSlots.keys()].slice(0, this.triggeredSlots.size - 200);
      for (const key of keys) {
        this.triggeredSlots.delete(key);
      }
    }
  }
}

module.exports = {
  CronRunner,
};
