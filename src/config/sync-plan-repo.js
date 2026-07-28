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

    return { plans };
  }

  listPlans() {
    return clone(this.readConfig().plans);
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
