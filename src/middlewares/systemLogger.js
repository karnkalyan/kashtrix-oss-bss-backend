const { logSystem } = require('../utils/systemLogger');

module.exports = (prisma) => (req, res, next) => {
  const startedAt = Date.now();
  let responseError = null;
  const originalJson = res.json.bind(res);

  res.json = (payload) => {
    if (res.statusCode >= 400 && payload && typeof payload === 'object') {
      responseError = payload.error || payload.message || null;
    }
    return originalJson(payload);
  };

  res.on('finish', () => {
    const statusCode = res.statusCode;
    const level = statusCode >= 500 ? 'ERROR' : statusCode >= 400 ? 'WARN' : 'INFO';
    const operation = `${req.method} ${req.route?.path || req.path || '/'}`;
    void logSystem(prisma, {
      ispId: req.ispId,
      userId: req.user?.id,
      level,
      operation,
      message: responseError || `${req.method} ${req.originalUrl} completed with status ${statusCode}`,
      method: req.method,
      path: req.originalUrl,
      statusCode,
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
      userAgent: req.headers['user-agent'],
      durationMs: Date.now() - startedAt,
      details: {
        route: req.route?.path || null,
        params: req.params || {},
        query: req.query || {},
      },
    });
  });

  next();
};
