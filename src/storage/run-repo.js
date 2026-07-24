const path = require("node:path");
const { FileStore } = require("./file-store");

class RunRepo {
  constructor({ dataDir, limit = 20 }) {
    this.store = new FileStore(path.join(dataDir, "runs.json"), { items: [] });
    this.limit = limit;
  }

  append(run) {
    this.store.update((state) => {
      state.items = [run, ...state.items].slice(0, this.limit);
      return state;
    });
    return run;
  }

  getLastByPlan(planId) {
    const state = this.store.read();
    return state.items.find((item) => item.planId === planId) || null;
  }

  listRecentByPlan(planId, limit = 5) {
    const state = this.store.read();
    return state.items.filter((item) => item.planId === planId).slice(0, limit);
  }
}

module.exports = {
  RunRepo,
};
