const crypto = require("node:crypto");
const path = require("node:path");
const { FileStore } = require("./file-store");

class ConfirmationRepo {
  constructor({ dataDir }) {
    this.store = new FileStore(path.join(dataDir, "confirmations.json"), { items: [] });
  }

  purgeExpired(now = new Date()) {
    this.store.update((state) => {
      state.items = state.items.map((item) => {
        if (item.status === "pending" && new Date(item.expiresAt).getTime() <= now.getTime()) {
          return {
            ...item,
            status: "expired",
            expiredAt: now.toISOString(),
          };
        }
        return item;
      });
      return state;
    });
  }

  createPending(record) {
    const pending = {
      confirmationId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      status: "pending",
      ...record,
    };

    this.store.update((state) => {
      state.items = [pending, ...state.items];
      return state;
    });

    return pending;
  }

  getPendingByPlanAndUser(planId, userId, now = new Date()) {
    this.purgeExpired(now);
    const state = this.store.read();
    return state.items.find((item) => (
      item.planId === planId
      && item.triggerUserId === userId
      && item.status === "pending"
    )) || null;
  }

  markConfirmed(confirmationId) {
    let confirmed = null;
    this.store.update((state) => {
      state.items = state.items.map((item) => {
        if (item.confirmationId !== confirmationId) {
          return item;
        }
        confirmed = {
          ...item,
          status: "confirmed",
          confirmedAt: new Date().toISOString(),
        };
        return confirmed;
      });
      return state;
    });
    return confirmed;
  }

  markCancelled(confirmationId) {
    let cancelled = null;
    this.store.update((state) => {
      state.items = state.items.map((item) => {
        if (item.confirmationId !== confirmationId) {
          return item;
        }
        cancelled = {
          ...item,
          status: "cancelled",
          cancelledAt: new Date().toISOString(),
        };
        return cancelled;
      });
      return state;
    });
    return cancelled;
  }
}

module.exports = {
  ConfirmationRepo,
};
