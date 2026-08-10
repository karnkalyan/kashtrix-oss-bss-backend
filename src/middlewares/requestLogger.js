const crypto = require('crypto');

function requestService(pathname) {
  const segments = String(pathname || '/')
    .split('?')[0]
    .split('/')
    .filter(Boolean);
  if (segments[0] === 'api') segments.shift();
  return segments[0] || 'application';
}

module.exports = function requestLogger(prisma) {
  return (req, res, next) => {
    const startedAt = process.hrtime.bigint();
    req.id = String(req.get('x-request-id') || crypto.randomUUID()).slice(0, 64);
    res.set('x-request-id', req.id);

    res.once('finish', () => {
      const durationMs = Math.max(0, Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6));
      setImmediate(() => {
        prisma.requestLog.create({
          data: {
            requestId: req.id,
            ispId: Number(req.ispId || req.user?.ispId) || null,
            userId: Number(req.user?.id) || null,
            method: String(req.method || 'GET').slice(0, 12),
            path: String(req.originalUrl || req.url || '/').split('?')[0].slice(0, 1000),
            service: requestService(req.originalUrl || req.url),
            statusCode: res.statusCode,
            durationMs,
            ipAddress: String(req.ip || req.socket?.remoteAddress || '').slice(0, 64) || null,
            userAgent: String(req.get('user-agent') || '').slice(0, 4000) || null,
            success: res.statusCode < 400
          }
        }).catch(error => console.error('[REQUEST LOG]', error.message));
      });
    });

    next();
  };
};
