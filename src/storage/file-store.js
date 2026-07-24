const fs = require("node:fs");
const path = require("node:path");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class FileStore {
  constructor(filePath, defaultValue) {
    this.filePath = filePath;
    this.defaultValue = defaultValue;
  }

  ensureDir() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  read() {
    this.ensureDir();
    if (!fs.existsSync(this.filePath)) {
      return clone(this.defaultValue);
    }

    return JSON.parse(fs.readFileSync(this.filePath, "utf8"));
  }

  write(value) {
    this.ensureDir();
    fs.writeFileSync(this.filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    return value;
  }

  update(mutator) {
    const current = this.read();
    const next = mutator(current) ?? current;
    this.write(next);
    return next;
  }
}

module.exports = {
  FileStore,
};
