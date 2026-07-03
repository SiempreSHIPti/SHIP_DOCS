// src/scripts/runCredentialCron.js
const { runCredentialCronOnce } = require("../jobs/credentialCron");

(async () => {
  const limit = Number(process.argv[2] || 100);
  const out = await runCredentialCronOnce({ limit });
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
})().catch((e) => {
  console.error("❌ Cron falló:", e?.message || e);
  process.exit(1);
});
