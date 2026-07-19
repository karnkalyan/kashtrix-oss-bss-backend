// src/routes/customerRoutes.js
const express = require('express');
const {
  createCustomer,
  provisionCustomer,
  listCustomers,
  getCustomerById,
  updateCustomer,
  deleteCustomer,
  subscribePackage,
  changeUsername,
  changePackage,
  resetMac,
  handleFileUpload,
  getCustomerDocuments,
  downloadDocument,
  deleteDocument,
  uploadCustomerDocuments,
  getCustomerByPhoneNumber,
  getCustomerStatusSummary,
  getCustomerProfile,
  uploadCustomerProfilePhoto,
  changeOwnPortalPassword,
  listOwnReferrals,
  createOwnReferral,
  assertCustomerOwnsSerial,
  updateCustomerDevice,
  updateCustomerProvisioningStatus,
  deleteCustomerDevice,
  getCustomerRadiusAuthLogs,
  bindCustomerRadiusMac,
  changePortalPassword,
  changeConnectionUserPassword,
  reprovisionRadius,
  reprovisionNettv,
  syncNettv,
  reprovisionAccount,
  disconnectRadiusSession,
  listNasDevices,
  listActiveSessions,
  getSessionInfoForUser,
  disconnectLatestSession,
  disconnectAllSessions,
  disconnectBranchSessions,
  disconnectPoolSessions,
  disconnectFilteredCustomerSessions,
  disconnectBySessionId
} = require('../controllers/customer.controller');

const isAuthenticated = require('../middlewares/isAuthenticated');
const checkPermission = require('../middlewares/checkPermission');
const checkAnyPermission = require('../middlewares/checkAnyPermission');
const { ServiceController } = require('../controllers/services.controller');
const ticketController = require('../controllers/ticket.controller');

module.exports = (prisma) => {
  const router = express.Router();
  const serviceController = new ServiceController(prisma);

  // Attach prisma client to req
  router.use((req, res, next) => {
    req.prisma = prisma;
    next();
  });

  // Apply isAuthenticated globally for customer routes
  router.use(isAuthenticated(prisma));

  router.get('/profile', getCustomerProfile);
  router.post('/profile/photo', handleFileUpload, uploadCustomerProfilePhoto);
  router.put('/profile/password', changeOwnPortalPassword);
  router.get('/profile/referrals', listOwnReferrals);
  router.post('/profile/referrals', createOwnReferral);

  router.get('/profile/genieacs/:serialNumber/deviceinfo', assertCustomerOwnsSerial, (req, res) => {
    res.set('Cache-Control', 'no-store');
    return serviceController.getGenieACSDeviceInfo(req, res);
  });
  router.get('/profile/genieacs/:serialNumber/waninfo', assertCustomerOwnsSerial, (req, res) => {
    res.set('Cache-Control', 'no-store');
    return serviceController.getGenieACSDeviceWanInfo(req, res);
  });
  router.get('/profile/genieacs/:serialNumber/wlaninfo', assertCustomerOwnsSerial, (req, res) => {
    res.set('Cache-Control', 'no-store');
    return serviceController.getGenieACSDeviceWlanInfo(req, res);
  });
  router.get('/profile/genieacs/:serialNumber/laninfo', assertCustomerOwnsSerial, (req, res) => {
    res.set('Cache-Control', 'no-store');
    return serviceController.getGenieACSDeviceLANInfo(req, res);
  });
  router.get('/profile/genieacs/:serialNumber/connected-devices-info', assertCustomerOwnsSerial, (req, res) => {
    res.set('Cache-Control', 'no-store');
    return serviceController.getGenieACSDeviceConnectedDevicesInfo(req, res);
  });
  router.post('/profile/genieacs/:serialNumber/update-wifi', assertCustomerOwnsSerial, (req, res) => {
    return serviceController.updateSpecificSSID(req, res);
  });
  router.post('/profile/genieacs/:serialNumber/ssid-operations', assertCustomerOwnsSerial, (req, res) => {
    return serviceController.enableDisableSSID(req, res);
  });
  router.post('/profile/genieacs/:serialNumber/reboot', assertCustomerOwnsSerial, (req, res) => {
    return serviceController.rebootGenieACSDevice(req, res);
  });
  router.get('/profile/radius/usage', (req, res) => {
    res.set('Cache-Control', 'no-store');
    return serviceController.getCustomerRadiusUsage(req, res);
  });
  router.post('/profile/tickets', ticketController.createTicket);

  // Customer CRUD endpoints
  router.post('/',
    checkPermission('customer_create'),
    handleFileUpload,
    createCustomer
  );

  // New provision endpoint
  router.post('/:id/provision',
    checkPermission('customer_update'),
    provisionCustomer
  );
  router.patch('/:id/provisioning-status', checkPermission('customer_update'), updateCustomerProvisioningStatus);

  router.get('/', checkAnyPermission(['customer_read', 'tasks_read_self', 'tasks_update']), listCustomers);
  router.get('/summary', checkPermission('customer_read'), getCustomerStatusSummary); // New endpoint
  router.post('/by-phone',
    checkPermission('customer_read'),
    getCustomerByPhoneNumber
  );
  // Disconnect & Sessions Features must be declared before /:id.
  router.get('/nas-devices', checkPermission('nas_read'), listNasDevices);
  router.get('/sessions', checkPermission('customer_read'), listActiveSessions);
  router.get('/sessions/:username', checkPermission('customer_read'), getSessionInfoForUser);
  router.post('/disconnect/branch/:branchId/all', checkPermission('customer_update'), disconnectBranchSessions);
  router.post('/disconnect/pool/:poolValue/all', checkPermission('customer_update'), disconnectPoolSessions);
  router.post('/disconnect/filter/customers', checkPermission('customer_update'), disconnectFilteredCustomerSessions);
  router.post('/disconnect/session/:sessionId', checkPermission('customer_update'), disconnectBySessionId);
  router.post('/disconnect/:username/all', checkPermission('customer_update'), disconnectAllSessions);
  router.post('/disconnect/:username', checkPermission('customer_update'), disconnectLatestSession);
  router.get('/:id', checkPermission('customer_read'), getCustomerById);
  router.get('/:id/radius/auth-logs', checkPermission('customer_read'), getCustomerRadiusAuthLogs);
  router.put('/:id/radius/bind-mac', checkPermission('customer_update'), bindCustomerRadiusMac);
  router.put('/:id', checkPermission('customer_update'), updateCustomer);
  router.delete('/:id', checkPermission('customer_delete'), deleteCustomer);
  // Action endpoints
  router.put('/:id/username', checkPermission('customer_update'), changeUsername);
  router.put('/:id/portal-password', checkPermission('customer_update'), changePortalPassword);
  router.put('/:id/connection-users/:connectionUserId/password', checkPermission('customer_update'), changeConnectionUserPassword);
  router.put('/:id/package', checkPermission('customer_update'), changePackage);
  router.put('/:id/mac', checkPermission('customer_update'), resetMac);
  router.post('/:id/reprovision/radius', checkPermission('customer_update'), reprovisionRadius);
  router.post('/:id/reprovision/nettv', checkPermission('customer_update'), reprovisionNettv);
  router.post('/:id/sync/nettv', checkPermission('customer_update'), syncNettv);
  router.post('/:id/reprovision/account', checkPermission('customer_update'), reprovisionAccount);
  router.post('/:id/disconnect-session', checkPermission('customer_update'), disconnectRadiusSession);

  // Device endpoints
  router.put('/:id/devices/:deviceId', checkPermission('customer_update'), updateCustomerDevice);
  router.delete('/:id/devices/:deviceId', checkPermission('customer_update'), deleteCustomerDevice);

  // Package subscription
  router.post('/subscribe', checkPermission('customer_create'), subscribePackage);

  // Document endpoints
  router.get('/:id/documents', checkPermission('customer_read'), getCustomerDocuments);
  router.post('/:id/documents',
    checkPermission('customer_update'),
    handleFileUpload,
    uploadCustomerDocuments
  );
  router.get('/:id/documents/:documentId/download',
    checkPermission('customer_read'),
    downloadDocument
  );
  router.delete('/:id/documents/:documentId',
    checkPermission('customer_delete'),
    deleteDocument
  );

  return router;
};
