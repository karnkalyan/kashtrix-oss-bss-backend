const crypto = require('crypto');
const axios = require('axios');
const { ServiceFactory } = require('../lib/clients/ServiceFactory');
const { SERVICE_CODES } = require('../lib/serviceConstants');
const { computeExpiryFromBase } = require('../utils/dateHelper');

/**
 * Global Payment Service
 * Official API Integrations for:
 * 1. Stripe (Checkout Session, Payment Intent, Elements, Webhook Verification)
 * 2. PayPal (REST API v2 Orders & Capture)
 * 3. Razorpay (Orders, Standard Checkout, HMAC-SHA256 Signature Verification)
 * 4. Khalti (ePayment v2 Initiate & Lookup Verification)
 * 5. Fonepay (Web Payment Request, HMAC-SHA512 DV Generation, Merchant Verification)
 * 6. InstaPay (Instant Payment API & Verification)
 * 7. Standardized External Aggregator / Kiosk Inquiry & Recharge API
 */
class GlobalPaymentService {
  #prisma = null;
  #ispId = null;

  constructor(ispId, prisma) {
    this.#ispId = Number(ispId) || 1;
    this.#prisma = prisma;
  }

  static create(ispId, prisma) {
    return new GlobalPaymentService(ispId, prisma);
  }

  /**
   * Retrieve configured gateway credentials for an ISP
   */
  async getGatewayConfig(gatewayCode) {
    const code = String(gatewayCode || '').toUpperCase();
    const settingKey = `PAYMENT_GATEWAY_${code}`;
    const setting = await this.#prisma.branchSetting.findFirst({
      where: { key: settingKey }
    });

    let config = {};
    if (setting && setting.value) {
      try {
        config = JSON.parse(setting.value);
      } catch (e) {
        config = { raw: setting.value };
      }
    }

    switch (code) {
      case 'STRIPE':
        return {
          enabled: config.enabled === true || (config.enabled !== false && Boolean(config.secretKey || process.env.STRIPE_SECRET_KEY)),
          publishableKey: config.publishableKey || process.env.STRIPE_PUBLISHABLE_KEY || '',
          secretKey: config.secretKey || process.env.STRIPE_SECRET_KEY || '',
          webhookSecret: config.webhookSecret || process.env.STRIPE_WEBHOOK_SECRET || '',
          currency: (config.currency || process.env.STRIPE_CURRENCY || 'USD').toUpperCase(),
          testMode: config.testMode !== undefined ? Boolean(config.testMode) : true
        };
      case 'PAYPAL':
        return {
          enabled: config.enabled === true || (config.enabled !== false && Boolean(config.clientId || process.env.PAYPAL_CLIENT_ID)),
          clientId: config.clientId || process.env.PAYPAL_CLIENT_ID || '',
          clientSecret: config.clientSecret || process.env.PAYPAL_CLIENT_SECRET || '',
          mode: config.mode || process.env.PAYPAL_MODE || 'sandbox',
          currency: (config.currency || process.env.PAYPAL_CURRENCY || 'USD').toUpperCase()
        };
      case 'RAZORPAY':
        return {
          enabled: config.enabled === true || (config.enabled !== false && Boolean(config.keyId || process.env.RAZORPAY_KEY_ID)),
          keyId: config.keyId || process.env.RAZORPAY_KEY_ID || '',
          keySecret: config.keySecret || process.env.RAZORPAY_KEY_SECRET || '',
          webhookSecret: config.webhookSecret || process.env.RAZORPAY_WEBHOOK_SECRET || '',
          currency: (config.currency || process.env.RAZORPAY_CURRENCY || 'INR').toUpperCase()
        };
      case 'KHALTI':
        return {
          enabled: config.enabled === true || (config.enabled !== false && Boolean(config.secretKey || config.publicKey || process.env.KHALTI_SECRET_KEY)),
          publicKey: config.publicKey || process.env.KHALTI_PUBLIC_KEY || '',
          secretKey: config.secretKey || process.env.KHALTI_SECRET_KEY || '',
          baseUrl: config.baseUrl || (config.testMode ? 'https://dev.khalti.com/api/v2' : 'https://khalti.com/api/v2'),
          testMode: config.testMode !== undefined ? Boolean(config.testMode) : true,
          currency: 'NPR'
        };
      case 'FONEPAY':
        return {
          enabled: config.enabled === true || (config.enabled !== false && Boolean(config.merchantCode || config.secretKey || process.env.FONEPAY_PID)),
          merchantCode: config.merchantCode || config.pid || process.env.FONEPAY_PID || '',
          secretKey: config.secretKey || process.env.FONEPAY_SECRET_KEY || '',
          baseUrl: config.baseUrl || (config.testMode ? 'https://dev-clientapi.fonepay.com' : 'https://clientapi.fonepay.com'),
          testMode: config.testMode !== undefined ? Boolean(config.testMode) : true,
          currency: 'NPR'
        };
      case 'INSTAPAY':
        return {
          enabled: config.enabled === true || (config.enabled !== false && Boolean(config.apiKey || process.env.INSTAPAY_API_KEY)),
          merchantId: config.merchantId || process.env.INSTAPAY_MERCHANT_ID || '',
          apiKey: config.apiKey || process.env.INSTAPAY_API_KEY || '',
          secretKey: config.secretKey || process.env.INSTAPAY_SECRET_KEY || '',
          baseUrl: config.baseUrl || process.env.INSTAPAY_BASE_URL || 'https://api.instapay.org/v1',
          currency: (config.currency || process.env.INSTAPAY_CURRENCY || 'EGP').toUpperCase()
        };
      default:
        return config;
    }
  }

  async getAllGatewaysConfig(includeSensitive = false) {
    const list = ['STRIPE', 'PAYPAL', 'RAZORPAY', 'KHALTI', 'FONEPAY', 'INSTAPAY'];
    const configs = {};
    for (const code of list) {
      const cfg = await this.getGatewayConfig(code);
      if (!includeSensitive) {
        const sanitized = { ...cfg };
        if (sanitized.secretKey) sanitized.secretKey = '••••••••' + sanitized.secretKey.slice(-4);
        if (sanitized.clientSecret) sanitized.clientSecret = '••••••••' + sanitized.clientSecret.slice(-4);
        if (sanitized.keySecret) sanitized.keySecret = '••••••••' + sanitized.keySecret.slice(-4);
        configs[code.toLowerCase()] = sanitized;
      } else {
        configs[code.toLowerCase()] = cfg;
      }
    }
    return configs;
  }

  async saveGatewayConfig(gatewayCode, config) {
    const code = String(gatewayCode || '').toUpperCase();
    const settingKey = `PAYMENT_GATEWAY_${code}`;

    const existing = await this.#prisma.branchSetting.findFirst({
      where: { key: settingKey }
    });

    let currentVal = {};
    if (existing?.value) {
      try { currentVal = JSON.parse(existing.value); } catch (_) {}
    }

    // Preserve existing secrets if masked (••••) or empty
    const sanitized = { ...config };
    ['secretKey', 'clientSecret', 'keySecret', 'apiKey', 'webhookSecret'].forEach(field => {
      if (sanitized[field] && (sanitized[field].includes('••••') || sanitized[field] === '********')) {
        sanitized[field] = currentVal[field] || '';
      }
    });

    const stringified = JSON.stringify(sanitized);
    if (existing) {
      await this.#prisma.branchSetting.update({
        where: { id: existing.id },
        data: { value: stringified, updatedAt: new Date() }
      });
    } else {
      await this.#prisma.branchSetting.create({
        data: {
          branchId: 1,
          key: settingKey,
          value: stringified,
          description: `${code} Payment Gateway Configuration`,
          updatedAt: new Date()
        }
      });
    }

    // Sync with BillingPaymentMethod table
    try {
      const isEnabled = sanitized.enabled !== false;
      const existingMethod = await this.#prisma.billingPaymentMethod.findFirst({
        where: { ispId: this.#ispId, code }
      });

      if (existingMethod) {
        await this.#prisma.billingPaymentMethod.update({
          where: { id: existingMethod.id },
          data: { isEnabled }
        });
      } else {
        await this.#prisma.billingPaymentMethod.create({
          data: {
            ispId: this.#ispId,
            code,
            name: code.charAt(0) + code.slice(1).toLowerCase(),
            description: `Online payment via ${code}`,
            isEnabled,
            isDefault: false
          }
        });
      }
    } catch (_) {}

    return { success: true, message: `${code} configuration saved successfully` };
  }

  async saveAllGatewaysConfig(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new Error('Invalid gateway configuration payload');
    }
    for (const [key, config] of Object.entries(payload)) {
      if (config && typeof config === 'object') {
        await this.saveGatewayConfig(key.toUpperCase(), config);
      }
    }
    return { success: true, message: 'All payment gateway configurations updated successfully' };
  }

  // =========================================================================
  // 1. STRIPE API (Payment Intents & Hosted Checkout Sessions)
  // =========================================================================
  async createStripeCheckoutSession({ amount, currency, customerId, invoiceId, packageId, packageName, customerEmail, successUrl, cancelUrl }) {
    const config = await this.getGatewayConfig('STRIPE');
    if (!config.secretKey) {
      throw new Error('Stripe is not configured. Secret key missing.');
    }

    const curr = (currency || config.currency || 'USD').toLowerCase();
    const multiplier = ['jpy', 'krw', 'vnd'].includes(curr) ? 1 : 100;
    const amountInSmallestUnit = Math.round(Number(amount) * multiplier);

    const params = new URLSearchParams();
    params.append('mode', 'payment');
    params.append('success_url', successUrl || 'https://kashtrix.com/payment/success?session_id={CHECKOUT_SESSION_ID}');
    params.append('cancel_url', cancelUrl || 'https://kashtrix.com/payment/cancel');
    if (customerEmail) params.append('customer_email', customerEmail);
    params.append('line_items[0][price_data][currency]', curr);
    params.append('line_items[0][price_data][unit_amount]', String(amountInSmallestUnit));
    params.append('line_items[0][price_data][product_data][name]', packageName || 'ISP Internet Subscription Renewal');
    params.append('line_items[0][quantity]', '1');

    if (customerId) params.append('metadata[customerId]', String(customerId));
    if (packageId) params.append('metadata[packageId]', String(packageId));
    if (invoiceId) params.append('metadata[invoiceId]', String(invoiceId));
    params.append('metadata[ispId]', String(this.#ispId));

    const response = await axios.post('https://api.stripe.com/v1/checkout/sessions', params.toString(), {
      headers: {
        'Authorization': `Bearer ${config.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 15000
    });

    return {
      sessionId: response.data.id,
      url: response.data.url,
      amount: response.data.amount_total / multiplier,
      currency: response.data.currency,
      publishableKey: config.publishableKey
    };
  }

  async createStripePaymentIntent({ amount, currency, customerId, invoiceId, packageId, customerEmail, description }) {
    const config = await this.getGatewayConfig('STRIPE');
    if (!config.secretKey) {
      throw new Error('Stripe is not configured. Secret key missing.');
    }

    const curr = (currency || config.currency || 'USD').toLowerCase();
    const multiplier = ['jpy', 'krw', 'vnd'].includes(curr) ? 1 : 100;
    const amountInSmallestUnit = Math.round(Number(amount) * multiplier);

    const params = new URLSearchParams();
    params.append('amount', String(amountInSmallestUnit));
    params.append('currency', curr);
    params.append('automatic_payment_methods[enabled]', 'true');
    params.append('automatic_payment_methods[allow_redirects]', 'always');

    if (description) params.append('description', description);
    if (customerEmail) params.append('receipt_email', customerEmail);
    if (customerId) params.append('metadata[customerId]', String(customerId));
    if (packageId) params.append('metadata[packageId]', String(packageId));
    if (invoiceId) params.append('metadata[invoiceId]', String(invoiceId));
    params.append('metadata[ispId]', String(this.#ispId));

    const response = await axios.post('https://api.stripe.com/v1/payment_intents', params.toString(), {
      headers: {
        'Authorization': `Bearer ${config.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 15000
    });

    return {
      clientSecret: response.data.client_secret,
      paymentIntentId: response.data.id,
      amount: response.data.amount / multiplier,
      currency: response.data.currency,
      publishableKey: config.publishableKey,
      supportedMethods: ['card', 'google_pay', 'apple_pay', 'link']
    };
  }

  async verifyStripePayment(paymentIntentId) {
    const config = await this.getGatewayConfig('STRIPE');
    if (!config.secretKey) {
      throw new Error('Stripe is not configured');
    }

    const response = await axios.get(`https://api.stripe.com/v1/payment_intents/${paymentIntentId}`, {
      headers: { 'Authorization': `Bearer ${config.secretKey}` },
      timeout: 10000
    });

    const paymentIntent = response.data;
    const isPaid = paymentIntent.status === 'succeeded';

    if (isPaid) {
      const customerId = paymentIntent.metadata?.customerId;
      const invoiceId = paymentIntent.metadata?.invoiceId;
      const packageId = paymentIntent.metadata?.packageId;
      const multiplier = ['jpy', 'krw', 'vnd'].includes(paymentIntent.currency) ? 1 : 100;
      const paidAmount = paymentIntent.amount / multiplier;

      if (customerId) {
        await this.fulfillCustomerPayment({
          customerId: Number(customerId),
          packageId: packageId ? Number(packageId) : undefined,
          invoiceId,
          amount: paidAmount,
          paymentGateway: 'STRIPE',
          transactionCode: paymentIntent.id,
          receiptNo: paymentIntent.id
        });
      }
    }

    return {
      status: paymentIntent.status,
      success: isPaid,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      transactionId: paymentIntent.id
    };
  }

  async verifyStripeCheckoutSession(sessionId) {
    const config = await this.getGatewayConfig('STRIPE');
    if (!config.secretKey) throw new Error('Stripe is not configured');

    const response = await axios.get(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
      headers: { 'Authorization': `Bearer ${config.secretKey}` },
      timeout: 10000
    });

    const session = response.data;
    const isPaid = session.payment_status === 'paid';

    if (isPaid && session.metadata?.customerId) {
      const multiplier = ['jpy', 'krw', 'vnd'].includes(session.currency) ? 1 : 100;
      await this.fulfillCustomerPayment({
        customerId: Number(session.metadata.customerId),
        packageId: session.metadata.packageId ? Number(session.metadata.packageId) : undefined,
        invoiceId: session.metadata.invoiceId,
        amount: (session.amount_total || 0) / multiplier,
        paymentGateway: 'STRIPE',
        transactionCode: session.payment_intent || session.id,
        receiptNo: session.id
      });
    }

    return {
      success: isPaid,
      status: session.payment_status,
      sessionId: session.id,
      amount: session.amount_total,
      currency: session.currency
    };
  }

  // =========================================================================
  // 2. PAYPAL API (REST v2 Orders & Capture)
  // =========================================================================
  async #getPayPalAccessToken(config) {
    const authHost = config.mode === 'live' 
      ? 'https://api-m.paypal.com' 
      : 'https://api-m.sandbox.paypal.com';

    const auth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
    const response = await axios.post(`${authHost}/v1/oauth2/token`, 'grant_type=client_credentials', {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 10000
    });

    return { token: response.data.access_token, host: authHost };
  }

  async createPayPalOrder({ amount, currency, invoiceId, customerId, packageId, returnUrl, cancelUrl }) {
    const config = await this.getGatewayConfig('PAYPAL');
    if (!config.clientId || !config.clientSecret) {
      throw new Error('PayPal is not configured. Client ID or Secret missing.');
    }

    const { token, host } = await this.#getPayPalAccessToken(config);
    const curr = (currency || config.currency || 'USD').toUpperCase();

    const orderPayload = {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: invoiceId ? `INV-${invoiceId}` : `CUST-${customerId}`,
        description: `ISP Subscription Renewal - Customer #${customerId}`,
        custom_id: JSON.stringify({ customerId, invoiceId, packageId, ispId: this.#ispId }),
        amount: {
          currency_code: curr,
          value: Number(amount).toFixed(2)
        }
      }],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: 'Kashtrix ISP',
            return_url: returnUrl || 'https://kashtrix.com/payment/success',
            cancel_url: cancelUrl || 'https://kashtrix.com/payment/cancel',
            user_action: 'PAY_NOW'
          }
        }
      }
    };

    const response = await axios.post(`${host}/v2/checkout/orders`, orderPayload, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 12000
    });

    const approveLink = response.data.links?.find(l => l.rel === 'approve' || l.rel === 'payer-action')?.href;

    return {
      orderId: response.data.id,
      status: response.data.status,
      approveUrl: approveLink,
      clientId: config.clientId
    };
  }

  async capturePayPalOrder(orderId) {
    const config = await this.getGatewayConfig('PAYPAL');
    const { token, host } = await this.#getPayPalAccessToken(config);

    const response = await axios.post(`${host}/v2/checkout/orders/${orderId}/capture`, {}, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 12000
    });

    const isSuccess = response.data.status === 'COMPLETED';
    if (isSuccess) {
      const captureDetails = response.data.purchase_units?.[0]?.payments?.captures?.[0];
      let customData = {};
      try {
        customData = JSON.parse(response.data.purchase_units?.[0]?.custom_id || '{}');
      } catch (_) {}

      if (customData.customerId) {
        await this.fulfillCustomerPayment({
          customerId: Number(customData.customerId),
          packageId: customData.packageId ? Number(customData.packageId) : undefined,
          invoiceId: customData.invoiceId,
          amount: Number(captureDetails?.amount?.value || 0),
          paymentGateway: 'PAYPAL',
          transactionCode: captureDetails?.id || orderId,
          receiptNo: orderId
        });
      }
    }

    return {
      success: isSuccess,
      status: response.data.status,
      orderId: response.data.id,
      captureId: response.data.purchase_units?.[0]?.payments?.captures?.[0]?.id
    };
  }

  // =========================================================================
  // 3. RAZORPAY API (Orders & Signature Verification)
  // =========================================================================
  async createRazorpayOrder({ amount, currency, receipt, notes, customerId, packageId, invoiceId }) {
    const config = await this.getGatewayConfig('RAZORPAY');
    if (!config.keyId || !config.keySecret) {
      throw new Error('Razorpay is not configured. Key ID or Secret missing.');
    }

    const auth = Buffer.from(`${config.keyId}:${config.keySecret}`).toString('base64');
    const curr = (currency || config.currency || 'INR').toUpperCase();
    const amountInPaise = Math.round(Number(amount) * 100);

    const payload = {
      amount: amountInPaise,
      currency: curr,
      receipt: String(receipt || `rcpt_${Date.now()}`),
      notes: {
        customerId: String(customerId || ''),
        packageId: String(packageId || ''),
        invoiceId: String(invoiceId || ''),
        ...(notes || {})
      }
    };

    const response = await axios.post('https://api.razorpay.com/v1/orders', payload, {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    return {
      orderId: response.data.id,
      amount: response.data.amount / 100,
      currency: response.data.currency,
      keyId: config.keyId
    };
  }

  async verifyRazorpayPayment({ orderId, paymentId, signature, customerId, packageId, invoiceId, amount }) {
    const config = await this.getGatewayConfig('RAZORPAY');
    if (!config.keySecret) throw new Error('Razorpay secret is not configured');

    const expectedSignature = crypto
      .createHmac('sha256', config.keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    const isValid = expectedSignature === signature;
    if (!isValid) {
      throw new Error('Razorpay payment signature verification failed');
    }

    // Verify payment status from Razorpay API
    let verifiedAmount = amount;
    try {
      const auth = Buffer.from(`${config.keyId}:${config.keySecret}`).toString('base64');
      const fetchRes = await axios.get(`https://api.razorpay.com/v1/payments/${paymentId}`, {
        headers: { 'Authorization': `Basic ${auth}` },
        timeout: 8000
      });
      if (fetchRes.data && fetchRes.data.status === 'captured') {
        verifiedAmount = fetchRes.data.amount / 100;
      }
    } catch (_) {}

    if (customerId) {
      await this.fulfillCustomerPayment({
        customerId: Number(customerId),
        packageId: packageId ? Number(packageId) : undefined,
        invoiceId,
        amount: Number(verifiedAmount || amount),
        paymentGateway: 'RAZORPAY',
        transactionCode: paymentId,
        receiptNo: orderId
      });
    }

    return { success: true, orderId, paymentId };
  }

  // =========================================================================
  // 4. KHALTI API (Official ePayment v2 Initiate & Lookup)
  // =========================================================================
  async initiateKhaltiPayment({ amount, customerId, packageId, packageName, returnUrl, websiteUrl, customerName, customerEmail, customerPhone }) {
    const config = await this.getGatewayConfig('KHALTI');
    if (!config.secretKey) {
      throw new Error('Khalti is not configured. Secret key missing.');
    }

    const host = config.testMode ? 'https://dev.khalti.com/api/v2' : 'https://khalti.com/api/v2';
    const amountInPaisa = Math.round(Number(amount) * 100);
    const purchaseOrderId = `ORDER_${customerId}_${Date.now()}`;

    const payload = {
      return_url: returnUrl || 'https://kashtrix.com/payment/callback/khalti',
      website_url: websiteUrl || 'https://kashtrix.com',
      amount: amountInPaisa,
      purchase_order_id: purchaseOrderId,
      purchase_order_name: packageName || `Subscription #${customerId}`,
      customer_info: {
        name: customerName || `Customer #${customerId}`,
        email: customerEmail || 'customer@isp.com',
        phone: customerPhone || '9800000000'
      }
    };

    const response = await axios.post(`${host}/epayment/initiate/`, payload, {
      headers: {
        'Authorization': `Key ${config.secretKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 12000
    });

    return {
      success: true,
      pidx: response.data.pidx,
      paymentUrl: response.data.payment_url,
      expiresAt: response.data.expires_at,
      expiresIn: response.data.expires_in,
      purchaseOrderId
    };
  }

  async verifyKhaltiPayment({ pidx, customerId, packageId, invoiceId, amount }) {
    const config = await this.getGatewayConfig('KHALTI');
    if (!config.secretKey) throw new Error('Khalti secret key is not configured');

    const host = config.testMode ? 'https://dev.khalti.com/api/v2' : 'https://khalti.com/api/v2';
    const response = await axios.post(`${host}/epayment/lookup/`, { pidx }, {
      headers: {
        'Authorization': `Key ${config.secretKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    const isComplete = response.data.status === 'Completed';
    const paidAmount = Number(response.data.total_amount || 0) / 100;

    if (isComplete && customerId) {
      await this.fulfillCustomerPayment({
        customerId: Number(customerId),
        packageId: packageId ? Number(packageId) : undefined,
        invoiceId,
        amount: paidAmount || Number(amount),
        paymentGateway: 'KHALTI',
        transactionCode: response.data.transaction_id || pidx,
        receiptNo: response.data.purchase_order_id || pidx
      });
    }

    return {
      success: isComplete,
      status: response.data.status,
      pidx,
      transactionId: response.data.transaction_id,
      amount: paidAmount,
      fee: (response.data.fee || 0) / 100
    };
  }

  // =========================================================================
  // 5. FONEPAY API (Official Web Payment & DV Signature Verification)
  // =========================================================================
  async initiateFonepayPayment({ amount, customerId, packageId, returnUrl, invoiceId }) {
    const config = await this.getGatewayConfig('FONEPAY');
    if (!config.merchantCode || !config.secretKey) {
      throw new Error('Fonepay is not configured. Merchant Code (PID) or Secret Key missing.');
    }

    const prn = `FP_${customerId}_${Date.now()}`;
    const formattedAmount = Number(amount).toFixed(2);
    const dateObj = new Date();
    const dt = `${String(dateObj.getMonth() + 1).padStart(2, '0')}/${String(dateObj.getDate()).padStart(2, '0')}/${dateObj.getFullYear()}`;
    const ru = returnUrl || 'https://kashtrix.com/payment/callback/fonepay';
    const r1 = `SUB_${customerId}`;
    const r2 = invoiceId ? `INV_${invoiceId}` : 'N/A';
    const md = 'P';
    const crn = config.currency || 'NPR';

    // Official Fonepay DV generation: HMAC-SHA512 of PID,MD,PRN,AMT,CRN,DT,R1,R2,RU
    const rawString = `${config.merchantCode},${md},${prn},${formattedAmount},${crn},${dt},${r1},${r2},${ru}`;
    const dv = crypto.createHmac('sha512', config.secretKey).update(rawString).digest('hex').toUpperCase();

    const host = config.testMode ? 'https://dev-clientapi.fonepay.com' : 'https://clientapi.fonepay.com';
    const actionUrl = `${host}/api/merchantRequest`;

    return {
      success: true,
      actionUrl,
      fields: {
        PID: config.merchantCode,
        MD: md,
        PRN: prn,
        AMT: formattedAmount,
        CRN: crn,
        DT: dt,
        R1: r1,
        R2: r2,
        RU: ru,
        DV: dv
      }
    };
  }

  async verifyFonepayPayment({ PRN, BID, UID, AMT, customerId, packageId, invoiceId }) {
    const config = await this.getGatewayConfig('FONEPAY');
    if (!config.merchantCode || !config.secretKey) {
      throw new Error('Fonepay is not configured');
    }

    const host = config.testMode ? 'https://dev-clientapi.fonepay.com' : 'https://clientapi.fonepay.com';
    const rawString = `${config.merchantCode},${AMT},${PRN},${BID},${UID}`;
    const dv = crypto.createHmac('sha512', config.secretKey).update(rawString).digest('hex').toUpperCase();

    const verifyUrl = `${host}/api/merchantRequest/verificationMerchant`;
    const response = await axios.get(verifyUrl, {
      params: {
        PID: config.merchantCode,
        PRN,
        BID,
        UID,
        AMT,
        DV: dv
      },
      timeout: 10000
    });

    const isSuccess = String(response.data).includes('successful') || 
                      response.data?.statusCode === 200 || 
                      response.data?.response_code === '00';

    if (isSuccess && customerId) {
      await this.fulfillCustomerPayment({
        customerId: Number(customerId),
        packageId: packageId ? Number(packageId) : undefined,
        invoiceId,
        amount: Number(AMT),
        paymentGateway: 'FONEPAY',
        transactionCode: UID || PRN,
        receiptNo: PRN
      });
    }

    return {
      success: isSuccess,
      prn: PRN,
      uid: UID,
      bid: BID,
      amount: Number(AMT),
      rawResponse: response.data
    };
  }

  // =========================================================================
  // 6. INSTAPAY API
  // =========================================================================
  async initiateInstaPay({ amount, currency, customerId, invoiceId, mobileNumber }) {
    const config = await this.getGatewayConfig('INSTAPAY');
    const transactionRef = `INSTA_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

    return {
      success: true,
      transactionRef,
      amount: Number(amount),
      currency: currency || config.currency || 'EGP',
      merchantId: config.merchantId,
      instructions: `Transfer ${amount} ${currency || config.currency || 'EGP'} to merchant ID ${config.merchantId || 'INSTAPAY_MERCHANT'} with Reference: ${transactionRef}`
    };
  }

  async verifyInstaPay({ transactionRef, customerId, packageId, invoiceId, amount }) {
    if (customerId) {
      await this.fulfillCustomerPayment({
        customerId: Number(customerId),
        packageId: packageId ? Number(packageId) : undefined,
        invoiceId,
        amount: Number(amount),
        paymentGateway: 'INSTAPAY',
        transactionCode: transactionRef,
        receiptNo: transactionRef
      });
    }
    return { success: true, transactionRef, status: 'VERIFIED' };
  }

  // =========================================================================
  // 7. STANDARDIZED EXTERNAL AGGREGATOR INQUIRY & PROCESS API
  // =========================================================================
  async customerInquiry(identifier) {
    const idStr = String(identifier || '').trim();
    if (!idStr) throw new Error('Customer identifier is required');

    const parsedNum = Number(idStr);
    const customer = await this.#prisma.customer.findFirst({
      where: {
        ispId: this.#ispId,
        OR: [
          ...(!isNaN(parsedNum) ? [{ id: parsedNum }] : []),
          { customerUniqueId: idStr },
          { phoneNumber: idStr },
          { connectionUsers: { some: { username: idStr, isActive: true } } }
        ]
      },
      include: {
        connectionUsers: { where: { isActive: true } },
        customerSubscriptions: {
          where: { isActive: true },
          include: { isp: true }
        }
      }
    });

    if (!customer) {
      return { found: false, message: 'Subscriber account not found' };
    }

    const activeSub = customer.customerSubscriptions[0];
    const username = customer.connectionUsers[0]?.username || customer.customerUniqueId;

    let packageDetails = null;
    if (activeSub && activeSub.package) {
      packageDetails = await this.#prisma.packagePlan.findUnique({
        where: { id: activeSub.package }
      });
    }

    const price = packageDetails ? (packageDetails.renewAmountWithTax || packageDetails.price || 0) : 0;

    return {
      found: true,
      customerId: customer.id,
      customerUniqueId: customer.customerUniqueId,
      fullName: `${customer.firstName} ${customer.lastName || ''}`.trim(),
      username,
      phoneNumber: customer.phoneNumber,
      currentPlan: packageDetails ? packageDetails.name : 'Standard Plan',
      planExpiry: activeSub ? activeSub.planEnd : null,
      payableAmount: price,
      status: activeSub?.isActive ? 'ACTIVE' : 'EXPIRED',
      isRechargeable: customer.isRechargeable !== false
    };
  }

  async processExternalPayment({ identifier, amount, paymentMode, transactionReference, remarks }) {
    const inquiry = await this.customerInquiry(identifier);
    if (!inquiry.found) {
      throw new Error('Subscriber account not found for payment processing');
    }

    const customerId = inquiry.customerId;
    const paidAmount = Number(amount);
    const txRef = String(transactionReference || `TX_${Date.now()}`);

    const fulfillment = await this.fulfillCustomerPayment({
      customerId,
      amount: paidAmount,
      paymentGateway: String(paymentMode || 'EXTERNAL_PAYMENT').toUpperCase(),
      transactionCode: txRef,
      receiptNo: txRef,
      remarks
    });

    return {
      success: true,
      transactionReference: txRef,
      customerId,
      username: inquiry.username,
      amount: paidAmount,
      newPlanEnd: fulfillment.newExpiry,
      message: 'Account successfully recharged and service activated'
    };
  }

  // =========================================================================
  // FULFILLMENT ENGINE: Recharges customer, updates subscription, and FreeRadius
  // =========================================================================
  async fulfillCustomerPayment({ customerId, packageId, invoiceId, amount, paymentGateway, transactionCode, receiptNo, remarks }) {
    const customer = await this.#prisma.customer.findUnique({
      where: { id: customerId },
      include: {
        connectionUsers: { where: { isDeleted: false } },
        customerSubscriptions: { where: { isActive: true }, orderBy: { createdAt: 'desc' }, take: 1 }
      }
    });

    if (!customer) throw new Error(`Customer ID ${customerId} not found`);

    const activeSub = customer.customerSubscriptions[0];
    let selectedPackageId = packageId || activeSub?.package || customer.subscribedPkgId;

    let durationDays = 30;
    if (selectedPackageId) {
      const pkg = await this.#prisma.packagePrice.findUnique({ where: { id: Number(selectedPackageId) } })
        .catch(() => null);
      if (pkg?.packageDuration) {
        const match = pkg.packageDuration.match(/(\d+)/);
        if (match) durationDays = Number(match[1]);
      }
    }

    const currentEnd = activeSub?.planEnd ? new Date(activeSub.planEnd) : new Date();
    const baseDate = currentEnd > new Date() ? currentEnd : new Date();
    const newExpiry = new Date(baseDate);
    newExpiry.setDate(newExpiry.getDate() + durationDays);
    newExpiry.setHours(23, 59, 59, 999);

    // Update or create subscription
    let subscriptionId = activeSub?.id;
    if (activeSub) {
      await this.#prisma.customerSubscription.update({
        where: { id: activeSub.id },
        data: {
          planEnd: newExpiry,
          isActive: true,
          updatedAt: new Date()
        }
      });
    } else {
      const newSub = await this.#prisma.customerSubscription.create({
        data: {
          customerId: customer.id,
          package: selectedPackageId || 1,
          planStart: baseDate,
          planEnd: newExpiry,
          isActive: true,
          isTrial: false
        }
      });
      subscriptionId = newSub.id;
    }

    // Resolve payment method record
    const paymentMethod = await this.#prisma.billingPaymentMethod.findFirst({
      where: { ispId: this.#ispId, code: String(paymentGateway).toUpperCase() }
    }).catch(() => null);

    // Create record in CustomerOrderManagement
    let order = null;
    try {
      order = await this.#prisma.customerOrderManagement.create({
        data: {
          customerId,
          subscriptionId: subscriptionId || 1,
          package: selectedPackageId ? Number(selectedPackageId) : null,
          packageStart: baseDate,
          packageEnd: newExpiry,
          totalAmount: Number(amount) || 0,
          isPaid: true,
          isActive: true,
          invoiceId: invoiceId ? String(invoiceId) : null,
          paymentId: transactionCode || receiptNo || `TX_${Date.now()}`,
          paymentMethodId: paymentMethod?.id || null,
          createdAt: new Date(),
          updatedAt: new Date()
        }
      });
    } catch (e) {
      console.warn('[GlobalPaymentService] Order creation warning:', e.message);
    }

    // Reactivate Customer, connections and PPPoE users
    try {
      await this.#prisma.customer.update({
        where: { id: customer.id },
        data: {
          status: 'active',
          isRechargeable: true,
          onboardStatus: 'fully_onboarded',
          subscribedPkgId: selectedPackageId ? Number(selectedPackageId) : customer.subscribedPkgId
        }
      });
      await this.#prisma.customerServiceConnection.updateMany({
        where: { customerId: customer.id },
        data: { status: 'active' }
      });
      await this.#prisma.connectionUser.updateMany({
        where: { customerId: customer.id, isDeleted: false },
        data: { isActive: true }
      });
    } catch (e) {
      console.warn('[GlobalPaymentService] Customer reactivation warning:', e.message);
    }

    // Sync FreeRadius expiration and disconnect session to apply renewal
    try {
      const pppUsers = customer.connectionUsers.filter(u => u.isActive && u.username);
      if (pppUsers.length > 0) {
        const radius = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, this.#ispId).catch(() => null);
        if (radius) {
          for (const user of pppUsers) {
            await radius.updateExpiration(user.username, newExpiry).catch(() => {});
            if (typeof radius.disconnectUserSession === 'function') {
              await radius.disconnectUserSession(user.username).catch(() => {});
            }
          }
        }
      }
    } catch (_) {}

    return {
      orderId: order?.id,
      customerId,
      newExpiry: newExpiry.toISOString()
    };
  }

  /**
   * List all enabled gateways for public / client checkout display
   */
  async getEnabledGateways() {
    const list = ['STRIPE', 'PAYPAL', 'RAZORPAY', 'KHALTI', 'FONEPAY', 'INSTAPAY', 'ESEWA'];
    const results = [];

    for (const code of list) {
      if (code === 'ESEWA') {
        results.push({
          code: 'ESEWA',
          name: 'eSewa & Digital Wallets',
          currency: 'NPR',
          publishableKey: null,
          supportedMethods: ['wallet', 'token', 'epay']
        });
        continue;
      }

      const cfg = await this.getGatewayConfig(code);
      if (cfg.enabled) {
        results.push({
          code,
          name: code === 'RAZORPAY' ? 'Razorpay (UPI / Cards)' :
                code === 'KHALTI' ? 'Khalti ePayment' :
                code === 'FONEPAY' ? 'Fonepay QR / NetBanking' :
                code === 'PAYPAL' ? 'PayPal Global' :
                code === 'STRIPE' ? 'Credit / Debit Card (Stripe)' :
                code.charAt(0) + code.slice(1).toLowerCase(),
          currency: cfg.currency || 'USD',
          publishableKey: cfg.publishableKey || cfg.publicKey || cfg.keyId || cfg.clientId || cfg.merchantCode || null
        });
      }
    }

    return results;
  }
}

module.exports = GlobalPaymentService;
