const express = require('express');
const {
  listOlts,
  getOltById,
  createOlt,
  updateOlt,
  deleteOlt,
  getOltStats,
  getOltPortsStatus,
  updateOltStatus,
  getVendors,
  getModelsByVendor,
  getOntsForOlt,
  getActiveSessions,
  syncOntsFromOlt,           // Keep old one for backward compatibility
  syncOntsBasicFromOlt,      // New: Sync basic ONT info
  syncOntDetailsFromOlt,     // New: Sync specific ONT details
  syncAllOntDetailsFromOlt,  // New: Sync all ONT details (bulk)
  testSshConnection,
  getOltSystemInfo,
  getGponPortInfo,
  executeBatchCommands,
  rebootOlt,
  getOltVlans,
  createOltVlan,
  updateOltVlan,
  deleteOltVlan,
  getOltProfiles,
  createOltProfile,
  updateOltProfile,
  deleteOltProfile,
  getAvailablePorts,
  getOltLoadFiles,
  createOltLoadFile,
  deleteOltLoadFile,
  findFSPByMac,
  linkCustomerDeviceToOLT
} = require('../controllers/olt.controller');

const isAuthenticated = require('../middlewares/isAuthenticated');
const checkPermission = require('../middlewares/checkPermission');
const checkAnyPermission = require('../middlewares/checkAnyPermission');

function requireAdministrator(req, res, next) {
  const role = String(req.user?.role || '').toLowerCase();
  if (!['administrator', 'admin', 'isp_admin', 'super admin', 'super_admin'].includes(role) || req.user?.resellerId) {
    return res.status(403).json({ error: 'Only an ISP administrator can add OLTs' });
  }
  next();
}

module.exports = (prisma) => {
  const router = express.Router();

  // Middleware to inject prisma into request
  router.use((req, res, next) => {
    req.prisma = prisma;
    next();
  });

  // Apply authentication middleware
  router.use(isAuthenticated(prisma));
  router.param('id', async (req, res, next, rawId) => {
    try {
      if (!req.user?.resellerId) return next();
      const olt = await prisma.oLT.findFirst({
        where: {
          id: Number(rawId),
          ispId: Number(req.ispId),
          resellerId: Number(req.user.resellerId),
          isDeleted: false
        },
        select: { id: true }
      });
      if (!olt) return res.status(404).json({ error: 'OLT not found' });
      next();
    } catch (error) {
      next(error);
    }
  });
  router.put('/:id/status', checkPermission('olt_update'), updateOltStatus);

  // OLT Management Routes
  router.get('/', listOlts);
  router.get('/stats', getOltStats);
  router.get('/vendors', getVendors);
  router.get('/vendors/:vendor/models', getModelsByVendor);
  router.get('/active-sessions', getActiveSessions);

  router.post('/', requireAdministrator, checkPermission('olt_update'), createOlt);
  router.get('/:id', getOltById);
  router.put('/:id', checkPermission('olt_update'), updateOlt);
  router.delete('/:id', checkPermission('olt_update'), deleteOlt);

  // OLT Status and Ports
  router.put('/:id/status', checkPermission('olt_update'), updateOltStatus);
  router.get('/:id/ports', getOltPortsStatus);

  // OLT ONT Management
  router.get('/:id/onts', checkPermission('olt_read'), getOntsForOlt);

  // ONT Sync Routes - Updated with separate endpoints
  router.post('/:id/onts/sync', checkPermission('olt_update'), syncOntsFromOlt); // Legacy endpoint
  router.post('/:id/onts/sync-basic', checkPermission('olt_update'), syncOntsBasicFromOlt); // New: Sync basic ONT info
  router.post('/:id/onts/:ontId/sync-details', checkPermission('olt_update'), syncOntDetailsFromOlt); // New: Sync specific ONT details
  router.post('/:id/onts/sync-all-details', checkPermission('olt_update'), syncAllOntDetailsFromOlt); // New: Sync all ONT details (bulk)

  // OLT SSH/Connection Testing
  router.post('/:id/test-ssh', checkPermission('olt_read'), testSshConnection);

  // OLT System Info and Sessions
  router.get('/:id/system-info', checkPermission('olt_read'), getOltSystemInfo);
  router.get('/:id/gpon-port/:port', checkPermission('olt_read'), getGponPortInfo);
  router.post('/:id/execute-batch', checkPermission('olt_update'), executeBatchCommands);
  router.post('/:id/reboot', checkPermission('olt_update'), rebootOlt);


  router.get('/:id/vlans', checkPermission('olt_read'), getOltVlans);
  router.post('/:id/vlans', checkPermission('olt_update'), createOltVlan);
  router.put('/:id/vlans/:vlanId', checkPermission('olt_update'), updateOltVlan);
  router.delete('/:id/vlans/:vlanId', checkPermission('olt_update'), deleteOltVlan);

  // Profile Management Routes
  router.get('/:id/profiles', checkPermission('olt_read'), getOltProfiles);
  router.post('/:id/profiles', checkPermission('olt_update'), createOltProfile);
  router.put('/:id/profiles/:profileId', checkPermission('olt_update'), updateOltProfile);
  router.delete('/:id/profiles/:profileId', checkPermission('olt_update'), deleteOltProfile);

  router.get('/:id/load-files', checkPermission('olt_read'), getOltLoadFiles);
  router.post('/:id/load-files', checkPermission('olt_update'), createOltLoadFile);
  router.delete('/:id/load-files/:fileId', checkPermission('olt_update'), deleteOltLoadFile);

  // Get available ports for VLAN/Profile assignment
  router.get('/:id/available-ports', checkPermission('olt_read'), getAvailablePorts);

  // Find F/S/P from MAC address
  router.post('/:id/find-fsp-by-mac', checkAnyPermission(['olt_mac_lookup', 'olt_read']), findFSPByMac);
  router.post('/:id/link-customer-device', checkAnyPermission(['olt_customer_link', 'olt_update']), linkCustomerDeviceToOLT);

  return router;
};
