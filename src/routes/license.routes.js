const express = require('express');
const jwt = require('jsonwebtoken');
const isAuthenticated = require('../middlewares/isAuthenticated');
const { secureLicense } = require('../services/license.service');

const ACCESS_SECRET = process.env.ACCESS_SECRET;

function isSystemAdmin(req) {
  const role = String(req.user?.role || '').toLowerCase();
  return role === 'administrator' || role === 'admin';
}

module.exports = (prisma) => {
  const router = express.Router();
  const auth = isAuthenticated(prisma);

  async function getRequestIsp(req) {
    if (!ACCESS_SECRET) return null;
    const token =
      req.cookies?.access_token ||
      (req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7).trim()
        : null);
    if (!token) return null;

    try {
      const payload = jwt.verify(token, ACCESS_SECRET);
      const user = await prisma.user.findUnique({
        where: { id: payload.userId },
        select: {
          isp: {
            select: {
              id: true,
              companyName: true,
              contactPerson: true,
              phoneNumber: true,
              masterEmail: true,
              address: true,
              city: true,
              state: true,
              country: true,
              website: true,
            },
          },
        },
      });
      return user?.isp || null;
    } catch {
      return null;
    }
  }

  async function getPublicIsp() {
    try {
      return await prisma.iSP.findFirst({
        orderBy: { id: 'asc' },
        select: {
          id: true,
          companyName: true,
          contactPerson: true,
          phoneNumber: true,
          masterEmail: true,
          address: true,
          city: true,
          state: true,
          country: true,
          website: true,
        },
      });
    } catch {
      return null;
    }
  }

  // License status check
  router.get('/status', async (req, res, next) => {
    try {
      if (!secureLicense.hwid || !secureLicense.clientId) {
        await Promise.all([
          secureLicense.getHardwareId(),
          secureLicense.getClientId(),
        ]).catch(() => {});
      }
      const status = secureLicense.getPublicStatus();
      const isp = await getRequestIsp(req);
      const publicIsp = isp || (await getPublicIsp());
      res.json({
        ...status,
        isp,
        publicIsp,
      });
    } catch (error) {
      next(error);
    }
  });

  // Hardware ID & Provisioning endpoint
  router.get('/hwid', async (req, res, next) => {
    try {
      const [hardwareId, clientId] = await Promise.all([
        secureLicense.getHardwareId(),
        secureLicense.getClientId(),
      ]);
      const provisioningId = secureLicense.getProvisioningId();
      res.json({
        hwid: hardwareId,
        hardwareId,
        clientId,
        provisioningId,
        tenantId: secureLicense.config.tenantId,
        applicationId: secureLicense.config.applicationId,
      });
    } catch (error) {
      next(error);
    }
  });

  // Provisioning details endpoint
  router.get('/provisioning', async (req, res, next) => {
    try {
      const [hardwareId, clientId] = await Promise.all([
        secureLicense.getHardwareId(),
        secureLicense.getClientId(),
      ]);
      res.json({
        provisioningId: secureLicense.getProvisioningId(),
        hwid: hardwareId,
        clientId,
        tenantId: secureLicense.config.tenantId,
        applicationId: secureLicense.config.applicationId,
        modules: secureLicense.supportedModules,
      });
    } catch (error) {
      next(error);
    }
  });

  // Install / Activate license
  const handleActivation = async (req, res, next) => {
    try {
      if (req.user && !isSystemAdmin(req)) {
        return res.status(403).json({ error: 'Only administrators can activate license.' });
      }
      const token = String(req.body?.token || req.body?.licenseKey || '').trim();
      if (!token) {
        return res.status(400).json({ error: 'License key or JWT token is required' });
      }
      const status = await secureLicense.activate(token);
      res.json(status);
    } catch (error) {
      res.status(400).json({
        error: error.message || 'Failed to activate license',
        status: secureLicense.getPublicStatus(),
      });
    }
  };

  router.post('/activate', auth, handleActivation);
  router.post('/install', auth, handleActivation);

  // Deactivate license
  router.delete('/', auth, async (req, res, next) => {
    try {
      if (!isSystemAdmin(req)) {
        return res.status(403).json({ error: 'Only administrators can delete license.' });
      }
      const status = await secureLicense.deactivate();
      res.json(status);
    } catch (error) {
      next(error);
    }
  });

  // Legacy license generator endpoints - notify migration to centralized license manager
  router.post('/generator-access', auth, (req, res) => {
    res.status(410).json({
      error: 'License generation is now managed through the Centralized Secure License Server (https://license.simulcast.com.np).',
      provisioningUrl: 'https://license.simulcast.com.np',
      provisioningId: secureLicense.getProvisioningId(),
      hwid: secureLicense.hwid,
    });
  });

  router.post('/generate', auth, (req, res) => {
    res.status(410).json({
      error: 'License generation has migrated to the Centralized Secure License Server (https://license.simulcast.com.np).',
      provisioningUrl: 'https://license.simulcast.com.np',
    });
  });

  router.get('/generated', auth, (req, res) => {
    res.json({ licenses: [] });
  });

  return router;
};
