const express = require('express');
const {
  paymentInquiry,
  processPayment,
  checkStatus,
  listTransactions,
  getPaymentModes
} = require('../controllers/externalPayment.controller');
const { getAccessToken, login } = require('../controllers/externalPaymentAuth.controller');

const isAuthenticated = require('../middlewares/isAuthenticated');
const externalPaymentAuth = require('../middlewares/externalPaymentAuth');
const checkPermission = require('../middlewares/checkPermission');

module.exports = (prisma) => {
  const router = express.Router();

  // Attach prisma client to req
  router.use((req, res, next) => {
    req.prisma = prisma;
    next();
  });

  // --- EXTERNAL PAYMENT PUBLIC API ROUTES ---

  // 1. Authentication
  router.post('/access-token', getAccessToken);
  router.post('/login', login);

  // 2. Customer & Bill Inquiry (supports username e.g. karnkalyan, customerId, phone, email)
  router.get('/inquiry/:request_id', externalPaymentAuth, paymentInquiry);
  router.post('/inquiry', externalPaymentAuth, paymentInquiry);
  router.get('/user/:username', externalPaymentAuth, paymentInquiry);

  // 3. Payment Confirmation & Direct Recharge (push payment with username, duration, payment mode)
  router.post('/payment', externalPaymentAuth, processPayment);
  router.post('/recharge', externalPaymentAuth, processPayment);
  router.post('/push', externalPaymentAuth, processPayment);

  // 4. Status Check / Reconciliation
  router.post('/status', externalPaymentAuth, checkStatus);
  router.get('/status/:transaction_code', externalPaymentAuth, checkStatus);

  // 5. Payment Modes
  router.get('/payment-modes', externalPaymentAuth, getPaymentModes);

  // 6. Transaction Listing (Internal authenticated & permission check)
  router.get('/transactions', isAuthenticated(prisma), checkPermission('services_read'), listTransactions);

  // 7. Test recharge from frontend dashboard
  router.post('/test-recharge', isAuthenticated(prisma), checkPermission('services_manage'), processPayment);

  // 8. Download Official Documentation PDF
  router.get('/documentation/pdf', async (req, res) => {
    try {
      const fs = require('fs');
      const path = require('path');
      const { getRequestBaseUrl } = require('../utils/requestBaseUrl');
      const { generatePdf } = require('../utils/script/generateExternalPaymentPdf');
      const baseUrl = getRequestBaseUrl(req);
      const tmpPdfPath = path.resolve(__dirname, `../../../External_Payment_API_Documentation_${Date.now()}.pdf`);

      await generatePdf(tmpPdfPath, baseUrl);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="External_Payment_API_Documentation.pdf"');
      const stream = fs.createReadStream(tmpPdfPath);
      stream.pipe(res);
      stream.on('finish', () => {
        fs.unlink(tmpPdfPath, () => {});
      });
      stream.on('error', (err) => {
        fs.unlink(tmpPdfPath, () => {});
      });
    } catch (err) {
      console.error('Error serving documentation PDF:', err);
      const fs = require('fs');
      const path = require('path');
      const fallbackPdf = path.resolve(__dirname, '../../../External_Payment_API_Documentation.pdf');
      if (fs.existsSync(fallbackPdf)) {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="External_Payment_API_Documentation.pdf"');
        return fs.createReadStream(fallbackPdf).pipe(res);
      }
      return res.status(500).json({ error: 'Failed to generate documentation PDF: ' + err.message });
    }
  });

  return router;
};
