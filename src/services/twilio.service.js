const axios = require('axios');

/**
 * Twilio Communication Service
 * Official API Integrations for:
 * 1. Twilio Programmable SMS (Messages.json API)
 * 2. Twilio Programmable Voice Calls (Calls.json API)
 * 3. Two-Factor Authentication / OTP SMS
 * 4. Call / SMS Status Webhooks
 */
class TwilioService {
  #prisma = null;
  #ispId = null;

  constructor(ispId, prisma) {
    this.#ispId = Number(ispId) || 1;
    this.#prisma = prisma;
  }

  static create(ispId, prisma) {
    return new TwilioService(ispId, prisma);
  }

  async getConfig() {
    const settingKey = 'COMMUNICATION_TWILIO_CONFIG';
    const setting = await this.#prisma.branchSetting.findFirst({
      where: { key: settingKey }
    });

    let config = {};
    if (setting && setting.value) {
      try {
        config = JSON.parse(setting.value);
      } catch (e) {
        config = {};
      }
    }

    return {
      accountSid: config.accountSid || process.env.TWILIO_ACCOUNT_SID || '',
      authToken: config.authToken || process.env.TWILIO_AUTH_TOKEN || '',
      fromNumber: config.fromNumber || process.env.TWILIO_PHONE_NUMBER || '',
      messagingServiceSid: config.messagingServiceSid || process.env.TWILIO_MESSAGING_SERVICE_SID || '',
      enabled: config.enabled !== false && Boolean(config.accountSid || process.env.TWILIO_ACCOUNT_SID)
    };
  }

  async saveConfig(config) {
    const settingKey = 'COMMUNICATION_TWILIO_CONFIG';
    const existing = await this.#prisma.branchSetting.findFirst({
      where: { key: settingKey }
    });

    const val = JSON.stringify(config);
    if (existing) {
      await this.#prisma.branchSetting.update({
        where: { id: existing.id },
        data: { value: val, updatedAt: new Date() }
      });
    } else {
      await this.#prisma.branchSetting.create({
        data: {
          branchId: 1,
          key: settingKey,
          value: val,
          description: 'Twilio SMS and Voice Call Configuration',
          updatedAt: new Date()
        }
      });
    }

    return { success: true, message: 'Twilio configuration saved successfully' };
  }

  /**
   * Send SMS via Twilio Messages API
   */
  async sendSms({ to, message, from }) {
    const config = await this.getConfig();
    if (!config.accountSid || !config.authToken) {
      throw new Error('Twilio is not configured. Account SID or Auth Token missing.');
    }

    const sender = from || config.fromNumber;
    if (!sender && !config.messagingServiceSid) {
      throw new Error('Twilio From Number or Messaging Service SID is required');
    }

    const auth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64');
    const params = new URLSearchParams();
    params.append('To', to);
    params.append('Body', message);

    if (config.messagingServiceSid) {
      params.append('MessagingServiceSid', config.messagingServiceSid);
    } else {
      params.append('From', sender);
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`;
    const response = await axios.post(url, params.toString(), {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 10000
    });

    return {
      success: true,
      messageSid: response.data.sid,
      status: response.data.status,
      to: response.data.to,
      from: response.data.from,
      dateSent: response.data.date_created
    };
  }

  /**
   * Originate Voice Call via Twilio Calls API
   */
  async makeCall({ to, from, twiml, url }) {
    const config = await this.getConfig();
    if (!config.accountSid || !config.authToken) {
      throw new Error('Twilio is not configured. Account SID or Auth Token missing.');
    }

    const sender = from || config.fromNumber;
    if (!sender) {
      throw new Error('Twilio From Number is required for outbound voice calls');
    }

    const auth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64');
    const params = new URLSearchParams();
    params.append('To', to);
    params.append('From', sender);

    if (twiml) {
      params.append('Twiml', twiml);
    } else if (url) {
      params.append('Url', url);
    } else {
      params.append('Twiml', '<Response><Say voice="alice">This is an automated call from Kashtrix ISP Support.</Say></Response>');
    }

    const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Calls.json`;
    const response = await axios.post(endpoint, params.toString(), {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 10000
    });

    return {
      success: true,
      callSid: response.data.sid,
      status: response.data.status,
      to: response.data.to,
      from: response.data.from,
      startTime: response.data.start_time
    };
  }

  /**
   * Send OTP Verification code
   */
  async sendOtp({ to, code, appName = 'Kashtrix ISP' }) {
    const message = `Your verification code for ${appName} is ${code}. Valid for 10 minutes. Do not share this code.`;
    return this.sendSms({ to, message });
  }

  /**
   * Verify Twilio Account Status & Balance
   */
  async getAccountInfo() {
    const config = await this.getConfig();
    if (!config.accountSid || !config.authToken) {
      return { configured: false, status: 'unconfigured' };
    }

    try {
      const auth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64');
      const response = await axios.get(
        `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}.json`,
        {
          headers: { 'Authorization': `Basic ${auth}` },
          timeout: 5000
        }
      );

      return {
        configured: true,
        accountSid: config.accountSid,
        friendlyName: response.data.friendly_name,
        status: response.data.status,
        type: response.data.type,
        fromNumber: config.fromNumber
      };
    } catch (err) {
      return {
        configured: false,
        status: 'error',
        error: err.message
      };
    }
  }
}

module.exports = TwilioService;
