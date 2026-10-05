async function getSystemLogs(req, res, next) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const where = {
      ...(req.ispId ? { ispId: Number(req.ispId) } : {}),
      ...(req.query.level ? { level: String(req.query.level).toUpperCase() } : {}),
      ...(req.query.operation ? { operation: { contains: String(req.query.operation) } } : {}),
    };

    if (req.query.from || req.query.to) {
      where.timestamp = {
        ...(req.query.from ? { gte: new Date(String(req.query.from)) } : {}),
        ...(req.query.to ? { lte: new Date(String(req.query.to)) } : {}),
      };
    }

    const [data, total] = await Promise.all([
      req.prisma.systemLog.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      req.prisma.systemLog.count({ where }),
    ]);

    return res.json({ data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (error) {
    return next(error);
  }
}

module.exports = { getSystemLogs };
