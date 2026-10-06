const express = require('express');
const TwilioController = require('../controllers/twilio.controller');
const isAuthenticated = require('../middlewares/isAuthenticated');
const checkPermission = require('../middlewares/checkPermission');

module.exports = (prisma) => {
  const router = express.Router();
  const controller = new TwilioController(prisma);

  const auth = isAuthenticated(prisma);

  router.post('/sms', auth, checkPermission('services_manage'), (req, res) => controller.sendSms(req, res));
  router.post('/call', auth, checkPermission('services_manage'), (req, res) => controller.makeCall(req, res));
  router.post('/otp', (req, res) => controller.sendOtp(req, res));
  router.get('/status', auth, (req, res) => controller.getStatus(req, res));
  router.get('/config', auth, checkPermission('settings_read'), (req, res) => controller.getConfig(req, res));
  router.post('/config', auth, checkPermission('settings_update'), (req, res) => controller.saveConfig(req, res));
  router.put('/config', auth, checkPermission('settings_update'), (req, res) => controller.saveConfig(req, res));

  return router;
};
