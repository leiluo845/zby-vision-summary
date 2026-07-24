class LockService {
  constructor() {
    this.activeKeys = new Set();
  }

  async runExclusive(key, fn) {
    if (this.activeKeys.has(key)) {
      throw new Error("已有同步任务运行中，请稍后再试。");
    }

    this.activeKeys.add(key);
    try {
      return await fn();
    } finally {
      this.activeKeys.delete(key);
    }
  }
}

module.exports = {
  LockService,
};
