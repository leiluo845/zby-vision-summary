const path = require("node:path");
const { FileStore } = require("./file-store");

class CallbackDedupRepo {
  constructor({ dataDir }) {
    this.store = new FileStore(path.join(dataDir, "callback-dedup.json"), { items: [] });
  }

  remember(eventId) {
    if (!eventId) {
      return true;
    }

    let accepted = true;
    this.store.update((state) => {
      if (state.items.some((item) => item.eventId === eventId)) {
        accepted = false;
        return state;
      }

      state.items = [
        { eventId, receivedAt: new Date().toISOString() },
        ...state.items,
      ].slice(0, 500);
      return state;
    });

    return accepted;
  }
}

module.exports = {
  CallbackDedupRepo,
};
