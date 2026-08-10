const express = require('express');
const createRateLimit = require('../middlewares/rateLimit');
const { authenticateApiToken, requireApiScope } = require('../controllers/apiToken.controller');
const { EXTERNAL_API_ROUTES } = require('../lib/externalApiCatalog');

module.exports = prisma => {
  const router = express.Router();
  router.use(createRateLimit({ windowMs: 60_000, max: 120 }));
  router.use(authenticateApiToken(prisma));

  router.get('/routes', (req, res) => {
    const scopes = new Set(req.apiScopes || []);
    const routes = EXTERNAL_API_ROUTES.filter(route => !route.scope || scopes.has('*') || scopes.has(route.scope));
    res.json({ success: true, data: { version: 'v1', routes } });
  });

  router.get('/me', requireApiScope('profile:read'), (req, res) => res.json({ success: true, data: {
    tokenId: req.apiToken.id,
    name: req.apiToken.name,
    scopes: req.apiScopes,
    ispId: req.ispId,
    branchId: req.branchId,
    resellerId: req.resellerId,
    expiresAt: req.apiToken.expiresAt,
  } }));

  router.get('/customers', requireApiScope('customers:read'), async (req, res, next) => {
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
      const where = {
        ispId: req.ispId,
        isDeleted: false,
        ...(req.branchId ? { branchId: req.branchId } : {}),
        ...(req.resellerId ? { resellerId: req.resellerId } : {}),
        ...(req.query.search ? { OR: [
          { customerUniqueId: { contains: String(req.query.search) } },
          { lead: { firstName: { contains: String(req.query.search) } } },
          { lead: { phoneNumber: { contains: String(req.query.search) } } },
        ] } : {}),
      };
      const [items, total] = await Promise.all([
        prisma.customer.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: 'desc' },
          select: { id: true, customerUniqueId: true, status: true, branchId: true, resellerId: true, createdAt: true,
            lead: { select: { firstName: true, middleName: true, lastName: true, phoneNumber: true, email: true } } } }),
        prisma.customer.count({ where }),
      ]);
      res.json({ success: true, data: items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
    } catch (error) { next(error); }
  });

  router.get('/customers/:id', requireApiScope('customers:read'), async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ success: false, error: 'Customer ID must be a positive integer' });
      const item = await prisma.customer.findFirst({
        where: {
          id, ispId: req.ispId, isDeleted: false,
          ...(req.branchId ? { branchId: req.branchId } : {}),
          ...(req.resellerId ? { resellerId: req.resellerId } : {}),
        },
        select: {
          id: true, customerUniqueId: true, status: true, branchId: true, resellerId: true, createdAt: true,
          lead: { select: { firstName: true, middleName: true, lastName: true, phoneNumber: true, email: true, address: true } },
          subscribedPkg: { select: { id: true, price: true } },
        },
      });
      if (!item) return res.status(404).json({ success: false, error: 'Customer not found' });
      res.json({ success: true, data: item });
    } catch (error) { next(error); }
  });

  router.get('/devices', requireApiScope('devices:read'), async (req, res, next) => {
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
      const where = { ispId: req.ispId, isDeleted: false, ...(req.branchId ? { branchId: req.branchId } : {}), ...(req.resellerId ? { resellerId: req.resellerId } : {}) };
      const [items, total] = await Promise.all([
        prisma.managedDevice.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: 'desc' },
          select: { id: true, uuid: true, name: true, deviceType: true, vendor: true, model: true, status: true, site: true, branchId: true, resellerId: true, lastSeenAt: true } }),
        prisma.managedDevice.count({ where }),
      ]);
      res.json({ success: true, data: items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
    } catch (error) { next(error); }
  });

  router.get('/devices/:id', requireApiScope('devices:read'), async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ success: false, error: 'Device ID must be a positive integer' });
      const item = await prisma.managedDevice.findFirst({
        where: {
          id, ispId: req.ispId, isDeleted: false,
          ...(req.branchId ? { branchId: req.branchId } : {}),
          ...(req.resellerId ? { resellerId: req.resellerId } : {}),
        },
        select: {
          id: true, uuid: true, name: true, deviceType: true, vendor: true, model: true, status: true,
          statusMessage: true, site: true, branchId: true, resellerId: true, lastSeenAt: true, createdAt: true,
        },
      });
      if (!item) return res.status(404).json({ success: false, error: 'Managed device not found' });
      res.json({ success: true, data: item });
    } catch (error) { next(error); }
  });

  return router;
};
