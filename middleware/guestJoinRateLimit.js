const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map();

export function guestJoinRateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || "unknown";
  let bucket = attempts.get(key);

  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    attempts.set(key, bucket);
  }

  if (bucket.count >= MAX_ATTEMPTS) {
    res.set("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
    return res.status(429).json({
      success: false,
      message: "Too many guest join attempts. Please try again later.",
    });
  }

  bucket.count += 1;
  if (attempts.size > 10000) {
    for (const [address, entry] of attempts) {
      if (entry.resetAt <= now) attempts.delete(address);
    }
  }
  return next();
}
