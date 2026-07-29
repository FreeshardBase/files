const db = require('../db');

class TokenBucket {
  constructor(tokensPerSec, capacity) {
    this.tokensPerSec = tokensPerSec;
    this.capacity = capacity !== undefined ? capacity : tokensPerSec;
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
  }

  refill() {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.tokensPerSec);
    this.lastRefill = now;
  }

  async consume(count) {
    this.refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return;
    }
    const needed = count - this.tokens;
    const waitMs = (needed / this.tokensPerSec) * 1000;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    this.refill();
    this.tokens = Math.max(0, this.tokens - count);
  }
}

async function bandwidthThrottler(req, res, next) {
  // Only throttle actual file download/stream endpoints, never static UI assets or metadata APIs (#86)
  if (!req.path.includes('/download') && !req.path.includes('/stream') && !req.path.includes('/raw')) {
    return next();
  }

  const userId = req.session?.userId || req.userId || req.session?.user?.id;
  if (!userId) {
    return next();
  }

  try {
    const settings = await db.getBandwidthSettings(userId);
    if (!settings || !settings.download_limit_kbps || settings.download_limit_kbps <= 0) {
      return next();
    }

    const rateBytes = settings.download_limit_kbps * 1024;
    const bucket = new TokenBucket(rateBytes, Math.min(rateBytes, 1024));

    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);

    let writeQueue = Promise.resolve();

    res.write = function (chunk, encoding, callback) {
      if (!chunk) return origWrite(chunk, encoding, callback);
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
      writeQueue = writeQueue.then(async () => {
        await bucket.consume(buf.length);
        origWrite(chunk, encoding, callback);
      });
      return true;
    };

    res.end = function (chunk, encoding, callback) {
      if (chunk) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
        writeQueue = writeQueue.then(async () => {
          await bucket.consume(buf.length);
          origEnd(chunk, encoding, callback);
        });
      } else {
        writeQueue = writeQueue.then(() => {
          origEnd(chunk, encoding, callback);
        });
      }
    };

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = {
  TokenBucket,
  bandwidthThrottler
};
