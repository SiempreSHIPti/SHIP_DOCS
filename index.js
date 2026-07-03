// index.js (entrypoint)
require("dotenv").config();

const { startServer } = require("./src/server");
const PORT = process.env.PORT || 8080;

startServer({ port: PORT })
  .then(() => console.log(`Servidor escuchando en http://localhost:${PORT}`))
  .catch((err) => {
    console.error("❌ Error arrancando servidor:", err?.message || err);
    process.exit(1);
  });
