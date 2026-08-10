// src/routes/tr069device.routes.js
const express = require('express');
const isAuthenticated = require('../middlewares/isAuthenticated');
const checkPermission = require('../middlewares/checkPermission');
const {
  syncDevices,
  syncDevice,
  listDevices,
  setProviderSecret,
  verifyProviderSecret,
  getRadiusCredentialsBySerial,
  getDeviceBySerial,
  refreshDeviceOptics,
  linkLead,
  unlinkLead,
  deleteDevice
} = require('../controllers/tr069device.controller');

module.exports = (prisma) => {
  const router = express.Router();

  // Attach prisma client to req
  router.use((req, res, next) => { req.prisma = prisma; next(); });

  // Require authentication for all tr069 device endpoints
  router.use(isAuthenticated(prisma));

  router.post('/provider-access/configure', checkPermission('settings_update'), setProviderSecret);
  router.post('/provider-access/verify', checkPermission('services_read'), verifyProviderSecret);

  // Sync from GenieACS to local DB
  router.post(
    '/sync',
    checkPermission('services_manage'),
    syncDevices
  );

  router.post(
    '/:serialNumber/sync',
    checkPermission('services_manage'),
    syncDevice
  );

  // List all local devices
  router.get(
    '/',
    checkPermission('services_read'),
    listDevices
  );

  router.get(
    '/:serialNumber/radius-credentials',
    checkPermission('services_manage'),
    getRadiusCredentialsBySerial
  );

  router.post(
    '/:serialNumber/refresh-optics',
    checkPermission('services_manage'),
    refreshDeviceOptics
  );

  // Get device by serial number
  router.get(
    '/:serialNumber',
    checkPermission('services_read'),
    getDeviceBySerial
  );

  // Link lead to device
  router.post(
    '/:serialNumber/link-lead',
    checkPermission('services_manage'),
    linkLead
  );

  // Unlink lead from device
  router.post(
    '/:serialNumber/unlink-lead',
    checkPermission('services_manage'),
    unlinkLead
  );

  // Delete device from local TR069 list
  router.delete(
    '/:serialNumber',
    checkPermission('services_manage'),
    deleteDevice
  );

  return router;
};
