const fs = require("node:fs");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class SyncPlanRepo {
  constructor({ configPath }) {
    this.configPath = configPath;
  }

  readConfig() {
    const rawText = fs.readFileSync(this.configPath, "utf8");
    const parsed = JSON.parse(rawText);
    const plans = Array.isArray(parsed.plans) ? parsed.plans : [parsed];

    return {
      plans: plans.map((plan) => ({
        manualTrigger: {
          enabled: true,
          permissionMode: "target_editors",
          permissionCacheTtlSeconds: 600,
          blankCellPolicy: {
            manual: "confirm_then_continue",
            scheduled: "abort_and_notify",
            confirmationTimeoutMinutes: 10,
          },
          ...(plan.manualTrigger || {}),
        },
        schedule: {
          crons: ["0 12 * * *", "0 0 * * *"],
          ...(plan.schedule || {}),
        },
        ...plan,
      })),
    };
  }

  listPlans() {
    return clone(this.readConfig().plans);
  }

  listEnabledPlans() {
    return this.listPlans().filter((plan) => plan.enabled !== false);
  }

  getPlan(planId) {
    const match = this.readConfig().plans.find((plan) => plan.planId === planId);
    return match ? clone(match) : null;
  }

  getDefaultPlan() {
    return this.listPlans()[0] || null;
  }
}

module.exports = {
  SyncPlanRepo,
};
