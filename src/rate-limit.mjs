// Small bounded in-memory rate limiter for failed authentication attempts
// (H5). Only failed pair/session attempts count; successes reset the sender.
// The table is pruned on every touch and hard-capped, so it cannot grow
// without bound. IP trust: only the direct socket peer is trusted by default.
// X-Forwarded-For is honored ONLY when explicitly enabled AND the direct peer
// is loopback (i.e. a local tunnel/edge connector on this host) — trusting an
// XFF from the open network would let attackers spoof or pollute keys.
export function createRateLimiter({ maxFailures = 20, windowMs = 60000, maxEntries = 1000 } = {}) {
  const hits = new Map();
  function prune(now) {
    for (const [ip, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(ip);
    }
    while (hits.size > maxEntries) {
      const oldest = hits.keys().next();
      if (oldest.done) break;
      hits.delete(oldest.value);
    }
  }
  return {
    check(ip, now = Date.now()) {
      prune(now);
      const entry = hits.get(ip);
      if (entry && entry.count >= maxFailures && now < entry.resetAt) {
        return { limited: true, retryAfterMs: entry.resetAt - now };
      }
      return { limited: false, retryAfterMs: 0 };
    },
    fail(ip, now = Date.now()) {
      prune(now);
      const entry = hits.get(ip);
      if (entry && now < entry.resetAt) {
        entry.count += 1;
      } else {
        hits.set(ip, { count: 1, resetAt: now + windowMs });
      }
      prune(now);
    },
    reset(ip) {
      hits.delete(ip);
    },
    get size() {
      return hits.size;
    },
  };
}

export function isLoopbackAddress(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost';
}

// Resolve the client IP for rate limiting. XFF is trusted only with explicit
// HOME_TRUST_PROXY=1 and a loopback direct peer (local connector setup).
export function clientIp(req, env = process.env) {
  const remote = req.socket?.remoteAddress ?? 'unknown';
  if (env.HOME_TRUST_PROXY === '1' && isLoopbackAddress(remote)) {
    const forwarded = req.headers?.['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      const first = forwarded.split(',')[0].trim();
      if (first) return first.slice(0, 128);
    }
  }
  return String(remote).slice(0, 128);
}

export function resolveRateLimit(env = process.env) {
  const num = (raw, fallback) => {
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) throw new Error(`Invalid rate limit value: ${raw}`);
    return value;
  };
  return {
    maxFailures: num(env.HOME_AUTH_RATE_MAX, 20),
    windowMs: num(env.HOME_AUTH_RATE_WINDOW_MS, 60000),
    maxEntries: num(env.HOME_AUTH_RATE_MAX_IPS, 1000),
  };
}
