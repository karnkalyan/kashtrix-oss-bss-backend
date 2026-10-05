const GlobalPaymentService = require('../services/globalPayment.service');

class GlobalPaymentController {
  #prisma = null;

  constructor(prisma) {
    this.#prisma = prisma;
  }

  // ==========================================
  // Stripe Endpoints (Card, GPay, Apple Pay)
  // ==========================================
  async createStripeIntent(req, res) {
    try {
      const ispId = req.ispId || 1;
      const { amount, currency, customerId, invoiceId, customerEmail, description } = req.body;

      if (!amount || Number(amount) <= 0) {
        return res.status(400).json({ success: false, error: 'A valid amount is required' });
      }

      const service = new GlobalPaymentService(ispId, this.#prisma);
      const result = await service.createStripePaymentIntent({
        amount,
        currency,
        customerId: customerId || req.user?.customerId,
        invoiceId,
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
  // PayPal Endpoints
  // ==========================================
  async createPayPalOrder(req, res) {
    try {
      const ispId = req.ispId || 1;
      const { amount, currency, invoiceId, customerId, returnUrl, cancelUrl } = req.body;

      if (!amount || Number(amount) <= 0) {
        return res.status(400).json({ success: false, error: 'A valid amount is required' });
      }

      const service = new GlobalPaymentService(ispId, this.#prisma);
      const result = await service.createPayPalOrder({
        amount,
        currency,
        invoiceId,
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
      const { amount, currency, receipt, notes } = req.body;

      if (!amount || Number(amount) <= 0) {
        return res.status(400).json({ success: false, error: 'A valid amount is required' });
      }

      const service = new GlobalPaymentService(ispId, this.#prisma);
      const result = await service.createRazorpayOrder({ amount, currency, receipt, notes });

      res.json({ success: true, data: result });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  }

  async verifyRazorpayPayment(req, res) {
    try {
      const ispId = req.ispId || 1;
      const { orderId, paymentId, signature, customerId, invoiceId, amount } = req.body;

      const service = new GlobalPaymentService(ispId, this.#prisma);
      const result = await service.verifyRazorpayPayment({
        orderId,
        paymentId,
        signature,
        customerId: customerId || req.user?.customerId,
        invoiceId,
        amount
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
      const { amount, currency, customerId, invoiceId, mobileNumber } = req.body;

      const service = new GlobalPaymentService(ispId, this.#prisma);
      const result = await service.initiateInstaPay({
        amount,
        currency,
        customerId: customerId || req.user?.customerId,
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
      const { transactionRef, customerId, invoiceId, amount } = req.body;

      const service = new GlobalPaymentService(ispId, this.#prisma);
      const result = await service.verifyInstaPay({
        transactionRef,
        customerId: customerId || req.user?.customerId,
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
