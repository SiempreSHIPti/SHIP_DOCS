// src/middleware/security.js
function securityHeaders(_req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(self), geolocation=(), microphone=()");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  next();
}

function rateLimit({ windowMs = 60_000, max = 120, keyPrefix = "global" } = {}) {
  const bucket = new Map();

  return (req, res, next) => {
    const now = Date.now();
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
    const key = `${keyPrefix}:${ip}`;
    const current = bucket.get(key);

    if (!current || current.resetAt <= now) {
      bucket.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    current.count += 1;

    if (current.count > max) {
      res.setHeader("Retry-After", Math.ceil((current.resetAt - now) / 1000));
      return res.status(429).json({ ok: false, error: "Demasiadas solicitudes. Intenta nuevamente más tarde." });
    }

    next();
  };
}

module.exports = { securityHeaders, rateLimit };
