const { startServer } = require("./src/app");

if (require.main === module) {
  startServer();
}

module.exports = {
  startServer,
};
