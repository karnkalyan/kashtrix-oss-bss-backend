const GlobalPaymentService = require('../services/globalPayment.service');

class GlobalPaymentController {
  #prisma = null;

  constructor(prisma) {
    this.#prisma = prisma;
  }

  // ==========================================
  // Stripe Endpoints
  // ==========================================
  async createStripeCheckout(req, res) {
    try {
      const ispId = req.ispId || 1;
      const { amount, currency, customerId, invoiceId, packageId, packageName, customerEmail, successUrl, cancelUrl } = req.body;
      if (!amount || Number(amount) <= 0) {
        return res.status(400).json({ success: false, error: 'A valid amount is required' });
      }
      const service = new GlobalPaymentService(ispId, this.#prisma);
      const result = await service.createStripeCheckoutSession({
        amount,
        currency,
        customerId: customerId || req.user?.customerId,
        invoiceId,
        packageId,
        packageName,
        customerEmail: customerEmail || req.user?.email,
        successUrl,
        cancelUrl
      });
      res.json({ success: true, data: result });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  }

  async verifyStripeCheckout(req, res) {
    try {
      const ispId = req.ispId || 1;
      const { sessionId } = req.body;
      if (!sessionId) {
        return res.status(400).json({ success: false, error: 'Stripe Session ID is required' });
      }
      const service = new GlobalPaymentService(ispId, this.#prisma);
      const result = await service.verifyStripeCheckoutSession(sessionId);
      res.json({ success: true, data: result });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  }

  async createStripeIntent(req, res) {
    try {
      const ispId = req.ispId || 1;
      const { amount, currency, customerId, invoiceId, packageId, customerEmail, description } = req.body;

      if (!amount || Number(amount) <= 0) {
        return res.status(400).json({ success: false, error: 'A valid amount is required' });
      }

      const service = new GlobalPaymentService(ispId, this.#prisma);
      const result = await service.createStripePaymentIntent({
        amount,
        currency,
        customerId: customerId || req.user?.customerId,
        invoiceId,
        packageId,
        customerEmail: customerEmail || req.user?.email,
        description
      });

      res.json({ success: true, data: result });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  }

  async verifyStripePayment(req, res) {
    try {
      const ispId = req.ispId || 1;
      const { paymentIntentId } = req.body;

      if (!paymentIntentId) {
        return res.status(400).json({ success: false, error: 'PaymentIntent ID is required' });
      }

      const service = new GlobalPaymentService(ispId, this.#prisma);
      const result = await service.verifyStripePayment(paymentIntentId);

      res.json({ success: true, data: result });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  }

  // ==========================================
  // PayPal Endpoints (REST v2)
  // ==========================================
  async createPayPalOrder(req, res) {
    try {
      const ispId = req.ispId || 1;
      const { amount, currency, invoiceId, customerId, packageId, returnUrl, cancelUrl } = req.body;

      if (!amount || Number(amount) <= 0) {
        return res.status(400).json({ success: false, error: 'A valid amount is required' });
      }

      const service = new GlobalPaymentService(ispId, this.#prisma);
      const result = await service.createPayPalOrder({
        amount,
        currency,
        invoiceId,
        packageId,
        customerId: customerId || req.user?.customerId,
        returnUrl,
        cancelUrl
      });

      res.json({ success: true, data: result });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  }

  async capturePayPalOrder(req, res) {
    try {
      const ispId = req.ispId || 1;
      const { orderId } = req.body;

      if (!orderId) {
        return res.status(400).json({ success: false, error: 'PayPal Order ID is required' });
      }

      const service = new GlobalPaymentService(ispId, this.#prisma);
      const result = await service.capturePayPalOrder(orderId);

      res.json({ success: true, data: result });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  }

  // ==========================================
  // Razorpay Endpoints
  // ==========================================
  async createRazorpayOrder(req, res) {
    try {
      const ispId = req.ispId || 1;
      const { amount, currency, receipt, notes, customerId, packageId, invoiceId } = req.body;

      if (!amount || Number(amount) <= 0) {
        return res.status(400).json({ success: false, error: 'A valid amount is required' });
      }

      const service = new GlobalPaymentService(ispId, this.#prisma);
      const result = await service.createRazorpayOrder({
        amount,
        currency,
        receipt,
        notes,
        customerId: customerId || req.user?.customerId,
        packageId,
        invoiceId
      });

      res.json({ success: true, data: result });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  }

  async verifyRazorpayPayment(req, res) {
    try {
      const ispId = req.ispId || 1;
      const { orderId, paymentId, signature, customerId, packageId, invoiceId, amount } = req.body;

      const service = new GlobalPaymentService(ispId, this.#prisma);
      const result = await service.verifyRazorpayPayment({
        orderId,
        paymentId,
        signature,
        customerId: customerId || req.user?.customerId,
        packageId,
        invoiceId,
        amount
      });

      res.json({ success: true, data: result });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  }

  // ==========================================
  // Khalti Endpoints (ePayment v2)
  // ==========================================
  async initiateKhaltiPayment(req, res) {
    try {
      const ispId = req.ispId || 1;
      const { amount, customerId, packageId, packageName, returnUrl, websiteUrl, customerName, customerEmail, customerPhone } = req.body;

      if (!amount || Number(amount) <= 0) {
        return res.status(400).json({ success: false, error: 'A valid amount is required' });
      }

      const service = new GlobalPaymentService(ispId, this.#prisma);
      const result = await service.initiateKhaltiPayment({
        amount,
        customerId: customerId || req.user?.customerId,
        packageId,
        packageName,
        returnUrl,
        websiteUrl,
        customerName: customerName || req.user?.name,
        customerEmail: customerEmail || req.user?.email,
        customerPhone: customerPhone || req.user?.phoneNumber
      });

      res.json({ success: true, data: result });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  }

  async verifyKhaltiPayment(req, res) {
    try {
      const ispId = req.ispId || 1;
      const { pidx, customerId, packageId, invoiceId, amount } = req.body;

      if (!pidx) {
        return res.status(400).json({ success: false, error: 'Khalti payment pidx is required' });
      }

      const service = new GlobalPaymentService(ispId, this.#prisma);
      const result = await service.verifyKhaltiPayment({
        pidx,
        customerId: customerId || req.user?.customerId,
        packageId,
        invoiceId,
        amount
      });

      res.json({ success: true, data: result });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  }

  // ==========================================
  // Fonepay Endpoints
  // ==========================================
  async initiateFonepayPayment(req, res) {
    try {
      const ispId = req.ispId || 1;
      const { amount, customerId, packageId, returnUrl, invoiceId } = req.body;

      if (!amount || Number(amount) <= 0) {
        return res.status(400).json({ success: false, error: 'A valid amount is required' });
      }

      const service = new GlobalPaymentService(ispId, this.#prisma);
      const result = await service.initiateFonepayPayment({
        amount,
        customerId: customerId || req.user?.customerId,
        packageId,
        returnUrl,
        invoiceId
      });

      res.json({ success: true, data: result });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  }

  async verifyFonepayPayment(req, res) {
    try {
      const ispId = req.ispId || 1;
      const { PRN, BID, UID, AMT, customerId, packageId, invoiceId } = req.body;

      if (!PRN || !AMT) {
        return res.status(400).json({ success: false, error: 'Fonepay PRN and AMT are required' });
      }

      const service = new GlobalPaymentService(ispId, this.#prisma);
      const result = await service.verifyFonepayPayment({
        PRN,
        BID,
        UID,
        AMT,
        customerId: customerId || req.user?.customerId,
        packageId,
        invoiceId
      });

      res.json({ success: true, data: result });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  }

  // ==========================================
  // InstaPay Endpoints
  // ==========================================
  async initiateInstaPay(req, res) {
    try {
      const ispId = req.ispId || 1;
      const { amount, currency, customerId, packageId, invoiceId, mobileNumber } = req.body;

      const service = new GlobalPaymentService(ispId, this.#prisma);
      const result = await service.initiateInstaPay({
        amount,
        currency,
        customerId: customerId || req.user?.customerId,
        packageId,
        invoiceId,
        mobileNumber
      });

      res.json({ success: true, data: result });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  }

  async verifyInstaPay(req, res) {
    try {
      const ispId = req.ispId || 1;
      const { transactionRef, customerId, packageId, invoiceId, amount } = req.body;

      const service = new GlobalPaymentService(ispId, this.#prisma);
      const result = await service.verifyInstaPay({
        transactionRef,
        customerId: customerId || req.user?.customerId,
        packageId,
        invoiceId,
        amount
      });

      res.json({ success: true, data: result });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  }

  // ==========================================
  // Standardized External Payment / Inquiry API
  // ==========================================
  async customerInquiry(req, res) {
    try {
      const ispId = req.ispId || 1;
      const identifier = req.params.identifier || req.query.identifier || req.body.identifier;

      const service = new GlobalPaymentService(ispId, this.#prisma);
      const result = await service.customerInquiry(identifier);

      if (!result.found) {
        return res.status(404).json({ success: false, ...result });
      }

      res.json({ success: true, data: result });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  }

  async processExternalPayment(req, res) {
    try {
      const ispId = req.ispId || 1;
      const { identifier, amount, paymentMode, transactionReference, remarks } = req.body;

      if (!identifier || !amount) {
        return res.status(400).json({ success: false, error: 'Identifier and amount are required' });
      }

      const service = new GlobalPaymentService(ispId, this.#prisma);
      const result = await service.processExternalPayment({
        identifier,
        amount,
        paymentMode,
        transactionReference,
        remarks
      });

      res.json({ success: true, data: result });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  }

  // ==========================================
  // Gateways List & Configuration
  // ==========================================
  async getEnabledGateways(req, res) {
    try {
      const ispId = req.ispId || 1;
      const service = new GlobalPaymentService(ispId, this.#prisma);
      const gateways = await service.getEnabledGateways();

      res.json({ success: true, data: gateways });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  async getAllGatewaysConfig(req, res) {
    try {
      const ispId = req.ispId || 1;
      const service = new GlobalPaymentService(ispId, this.#prisma);
      const configs = await service.getAllGatewaysConfig(false);

      res.json({ success: true, data: configs });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  async saveAllGatewaysConfig(req, res) {
    try {
      const ispId = req.ispId || 1;
      const service = new GlobalPaymentService(ispId, this.#prisma);
      const result = await service.saveAllGatewaysConfig(req.body);

      res.json(result);
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  }

  async getGatewayConfig(req, res) {
    try {
      const ispId = req.ispId || 1;
      const { gateway } = req.params;
      const service = new GlobalPaymentService(ispId, this.#prisma);
      const config = await service.getGatewayConfig(gateway);

      // Redact sensitive secrets in read response
      const sanitized = { ...config };
      if (sanitized.secretKey) sanitized.secretKey = '••••••••' + sanitized.secretKey.slice(-4);
      if (sanitized.clientSecret) sanitized.clientSecret = '••••••••' + sanitized.clientSecret.slice(-4);
      if (sanitized.keySecret) sanitized.keySecret = '••••••••' + sanitized.keySecret.slice(-4);

      res.json({ success: true, data: sanitized });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  async saveGatewayConfig(req, res) {
    try {
      const ispId = req.ispId || 1;
      const { gateway } = req.params;
      const service = new GlobalPaymentService(ispId, this.#prisma);
      const result = await service.saveGatewayConfig(gateway, req.body);

      res.json(result);
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  }
}

module.exports = GlobalPaymentController;
