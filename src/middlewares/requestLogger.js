const crypto = require('crypto');

function requestService(pathname) {
  const segments = String(pathname || '/')
    .split('?')[0]
    .split('/')
    .filter(Boolean);
  if (segments[0] === 'api') segments.shift();
  return segments[0] || 'application';
}

// In-memory batch queue to prevent DB connection pool exhaustion
let logQueue = [];
let flushTimer = null;
const MAX_QUEUE_SIZE = 500;
const BATCH_SIZE = 50;
const FLUSH_INTERVAL_MS = 2000;

function flushBatch(prisma) {
  if (logQueue.length === 0) return;
  const items = logQueue.splice(0, BATCH_SIZE);

  prisma.requestLog.createMany({
    data: items,
    skipDuplicates: true
  }).catch(error => {
    // Non-fatal logging error
  });
}

function shouldSkipLogging(path, method) {
  if (method === 'OPTIONS') return true;
  const lower = String(path || '').toLowerCase();
  return (
    lower.startsWith('/uploads') ||
    lower.startsWith('/_next') ||
    lower.includes('/static/') ||
    lower.endsWith('.png') ||
    lower.endsWith('.jpg') ||
    lower.endsWith('.jpeg') ||
    lower.endsWith('.svg') ||
    lower.endsWith('.ico') ||
    lower.endsWith('.map') ||
    lower.endsWith('.css') ||
    lower.endsWith('.js') ||
    lower === '/health' ||
    lower === '/api/health'
  );
}

module.exports = function requestLogger(prisma) {
  if (!flushTimer) {
    flushTimer = setInterval(() => flushBatch(prisma), FLUSH_INTERVAL_MS);
    if (flushTimer.unref) flushTimer.unref();
  }

  return (req, res, next) => {
    const rawPath = req.originalUrl || req.url || '/';
    if (shouldSkipLogging(rawPath, req.method)) {
      return next();
    }

    const startedAt = process.hrtime.bigint();
    req.id = String(req.get('x-request-id') || crypto.randomUUID()).slice(0, 64);
    res.set('x-request-id', req.id);

    res.once('finish', () => {
      const durationMs = Math.max(0, Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6));
      
      if (logQueue.length < MAX_QUEUE_SIZE) {
        logQueue.push({
          requestId: req.id,
          ispId: Number(req.ispId || req.user?.ispId) || null,
          userId: Number(req.user?.id) || null,
          method: String(req.method || 'GET').slice(0, 12),
          path: String(rawPath).split('?')[0].slice(0, 1000),
          service: requestService(rawPath),
          statusCode: res.statusCode,
          durationMs,
          ipAddress: String(req.ip || req.socket?.remoteAddress || '').slice(0, 64) || null,
          userAgent: String(req.get('user-agent') || '').slice(0, 1000) || null,
          success: res.statusCode < 400
        });

        if (logQueue.length >= BATCH_SIZE) {
          setImmediate(() => flushBatch(prisma));
        }
      }
    });

    next();
  };
};
