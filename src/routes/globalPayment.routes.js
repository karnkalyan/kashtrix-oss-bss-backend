const express = require('express');
const GlobalPaymentController = require('../controllers/globalPayment.controller');
const isAuthenticated = require('../middlewares/isAuthenticated');
const checkPermission = require('../middlewares/checkPermission');

module.exports = (prisma) => {
  const router = express.Router();
  const controller = new GlobalPaymentController(prisma);

  // Public / external gateway info & inquiry endpoints
  router.get('/gateways', (req, res) => controller.getEnabledGateways(req, res));
  router.get('/inquiry/:identifier', (req, res) => controller.customerInquiry(req, res));
  router.post('/inquiry', (req, res) => controller.customerInquiry(req, res));
  router.post('/process', (req, res) => controller.processExternalPayment(req, res));
  router.post('/recharge', (req, res) => controller.processExternalPayment(req, res));

  // Stripe
  router.post('/stripe/intent', (req, res) => controller.createStripeIntent(req, res));
  router.post('/stripe/verify', (req, res) => controller.verifyStripePayment(req, res));
  router.post('/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => controller.verifyStripePayment(req, res));

  // PayPal
  router.post('/paypal/order', (req, res) => controller.createPayPalOrder(req, res));
  router.post('/paypal/capture', (req, res) => controller.capturePayPalOrder(req, res));

  // Razorpay
  router.post('/razorpay/order', (req, res) => controller.createRazorpayOrder(req, res));
  router.post('/razorpay/verify', (req, res) => controller.verifyRazorpayPayment(req, res));

  // InstaPay
  router.post('/instapay/initiate', (req, res) => controller.initiateInstaPay(req, res));
  router.post('/instapay/verify', (req, res) => controller.verifyInstaPay(req, res));

  // Admin Configuration Endpoints (Authenticated)
  const auth = isAuthenticated(prisma);
  router.get('/config/:gateway', auth, checkPermission('settings_read'), (req, res) => controller.getGatewayConfig(req, res));
  router.post('/config/:gateway', auth, checkPermission('settings_update'), (req, res) => controller.saveGatewayConfig(req, res));

  return router;
};
