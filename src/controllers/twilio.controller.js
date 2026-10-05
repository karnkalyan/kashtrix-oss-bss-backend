const TwilioService = require('../services/twilio.service');

class TwilioController {
  #prisma = null;

  constructor(prisma) {
    this.#prisma = prisma;
  }

  async sendSms(req, res) {
    try {
      const ispId = req.ispId || 1;
      const { to, message, from } = req.body;

      if (!to || !message) {
        return res.status(400).json({ success: false, error: 'Recipient phone number (to) and message are required' });
      }

      const service = new TwilioService(ispId, this.#prisma);
      const result = await service.sendSms({ to, message, from });

      res.json(result);
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  }

  async makeCall(req, res) {
    try {
      const ispId = req.ispId || 1;
      const { to, from, twiml, url } = req.body;

      if (!to) {
        return res.status(400).json({ success: false, error: 'Destination phone number (to) is required' });
      }

      const service = new TwilioService(ispId, this.#prisma);
      const result = await service.makeCall({ to, from, twiml, url });

      res.json(result);
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  }

  async sendOtp(req, res) {
    try {
      const ispId = req.ispId || 1;
      const { to, code, appName } = req.body;

      if (!to || !code) {
        return res.status(400).json({ success: false, error: 'Phone number and verification code are required' });
      }

      const service = new TwilioService(ispId, this.#prisma);
      const result = await service.sendOtp({ to, code, appName });

      res.json(result);
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  }

  async getStatus(req, res) {
    try {
      const ispId = req.ispId || 1;
      const service = new TwilioService(ispId, this.#prisma);
      const info = await service.getAccountInfo();

      res.json({ success: true, data: info });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  async getConfig(req, res) {
    try {
      const ispId = req.ispId || 1;
      const service = new TwilioService(ispId, this.#prisma);
      const config = await service.getConfig();

      const sanitized = {
        accountSid: config.accountSid,
        fromNumber: config.fromNumber,
        messagingServiceSid: config.messagingServiceSid,
        enabled: config.enabled,
        authToken: config.authToken ? '••••••••' + config.authToken.slice(-4) : ''
      };

      res.json({ success: true, data: sanitized });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  async saveConfig(req, res) {
    try {
      const ispId = req.ispId || 1;
      const service = new TwilioService(ispId, this.#prisma);
      const result = await service.saveConfig(req.body);

      res.json(result);
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  }
}

module.exports = TwilioController;
