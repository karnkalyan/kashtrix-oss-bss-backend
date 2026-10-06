const express = require('express');
const GlobalPaymentController = require('../controllers/globalPayment.controller');
const isAuthenticated = require('../middlewares/isAuthenticated');
const checkPermission = require('../middlewares/checkPermission');

module.exports = (prisma) => {
  const router = express.Router();
  const controller = new GlobalPaymentController(prisma);
  const auth = isAuthenticated(prisma);

  // Public / external gateway info & customer inquiry endpoints
  router.get('/gateways', (req, res) => controller.getEnabledGateways(req, res));
  router.get('/inquiry/:identifier', (req, res) => controller.customerInquiry(req, res));
  router.post('/inquiry', (req, res) => controller.customerInquiry(req, res));
  router.post('/process', (req, res) => controller.processExternalPayment(req, res));
  router.post('/recharge', (req, res) => controller.processExternalPayment(req, res));

  // Admin Gateway Settings (Full configuration)
  router.get('/gateways/all', auth, checkPermission('settings_read'), (req, res) => controller.getAllGatewaysConfig(req, res));
  router.put('/gateways', auth, checkPermission('settings_update'), (req, res) => controller.saveAllGatewaysConfig(req, res));
  router.post('/gateways', auth, checkPermission('settings_update'), (req, res) => controller.saveAllGatewaysConfig(req, res));

  // 1. Stripe
  router.post('/stripe/checkout', (req, res) => controller.createStripeCheckout(req, res));
  router.post('/stripe/verify-checkout', (req, res) => controller.verifyStripeCheckout(req, res));
  router.post('/stripe/intent', (req, res) => controller.createStripeIntent(req, res));
  router.post('/stripe/create-intent', (req, res) => controller.createStripeIntent(req, res));
  router.post('/stripe/verify', (req, res) => controller.verifyStripePayment(req, res));
  router.post('/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => controller.verifyStripePayment(req, res));

  // 2. PayPal
  router.post('/paypal/order', (req, res) => controller.createPayPalOrder(req, res));
  router.post('/paypal/create-order', (req, res) => controller.createPayPalOrder(req, res));
  router.post('/paypal/capture', (req, res) => controller.capturePayPalOrder(req, res));
  router.post('/paypal/capture-order', (req, res) => controller.capturePayPalOrder(req, res));

  // 3. Razorpay
  router.post('/razorpay/order', (req, res) => controller.createRazorpayOrder(req, res));
  router.post('/razorpay/create-order', (req, res) => controller.createRazorpayOrder(req, res));
  router.post('/razorpay/verify', (req, res) => controller.verifyRazorpayPayment(req, res));

  // 4. Khalti
  router.post('/khalti/initiate', (req, res) => controller.initiateKhaltiPayment(req, res));
  router.post('/khalti/verify', (req, res) => controller.verifyKhaltiPayment(req, res));

  // 5. Fonepay
  router.post('/fonepay/initiate', (req, res) => controller.initiateFonepayPayment(req, res));
  router.post('/fonepay/verify', (req, res) => controller.verifyFonepayPayment(req, res));

  // 6. InstaPay
  router.post('/instapay/initiate', (req, res) => controller.initiateInstaPay(req, res));
  router.post('/instapay/verify', (req, res) => controller.verifyInstaPay(req, res));

  // Per-gateway configuration
  router.get('/config/:gateway', auth, checkPermission('settings_read'), (req, res) => controller.getGatewayConfig(req, res));
  router.post('/config/:gateway', auth, checkPermission('settings_update'), (req, res) => controller.saveGatewayConfig(req, res));
  router.put('/config/:gateway', auth, checkPermission('settings_update'), (req, res) => controller.saveGatewayConfig(req, res));

  return router;
};
