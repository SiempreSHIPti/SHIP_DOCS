// src/utils/time.js
function nowMX() {
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Mexico_City",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  return fmt.format(new Date()).replace("T", " ");
}
module.exports = { nowMX };
