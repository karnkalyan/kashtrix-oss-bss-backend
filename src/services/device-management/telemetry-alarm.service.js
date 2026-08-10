const mailHelper = require('../../utils/mailHelper');
const whatsappService = require('../whatsapp.service');
const SmsService = require('../sms.service');

class TelemetryAlarmService {
  constructor(prisma) {
    this.prisma = prisma;
    this.sms = new SmsService(prisma);
    this.lastTriggered = new Map();
  }

  async rulesFor(ispId) {
    if (!this.prisma?.iSPSettings?.findFirst) return [];
    const setting = await this.prisma.iSPSettings.findFirst({ where: { ispId: Number(ispId), key: 'telemetry_alarm_rules' } });
    if (!setting?.value) return [];
    try {
      const parsed = JSON.parse(setting.value);
      return Array.isArray(parsed) ? parsed.filter(rule => rule.enabled !== false) : [];
    } catch { return []; }
  }

  async hasMetricRules(ispId) { return (await this.rulesFor(ispId)).some(rule => rule.metric !== 'status'); }

  metricValue(snapshot, metric) {
    if (metric === 'status') return snapshot?.connection?.status;
    const aliases = {
      cpuLoadPercent: ['cpuloadpercent', 'cpuload', 'cpuusage', 'cpuutilization'],
      memoryUtilizationPercent: ['memoryutilizationpercent', 'memoryusage', 'memoryutilization'],
      maximumTemperatureC: ['maximumtemperaturec', 'temperature', 'maxtemperature']
    };
    const accepted = new Set([metric.toLowerCase(), ...(aliases[metric] || [])]);
    const search = (node, depth = 0) => {
      if (!node || typeof node !== 'object' || depth > 10) return null;
      for (const [key, value] of Object.entries(node)) {
        if (accepted.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''))) {
          const number = Number.parseFloat(String(value?._value ?? value).replace(/[^\d+.-]/g, ''));
          if (Number.isFinite(number)) return number;
        }
      }
      for (const value of Object.values(node)) {
        const found = search(value, depth + 1);
        if (found !== null) return found;
      }
      return null;
    };
    for (const root of [snapshot?.health?.summary, snapshot?.health?.view?.summary, snapshot?.health, snapshot]) {
      const value = search(root);
      if (value !== null) return value;
    }
    return null;
  }

  async send(ispId, channel, recipient, subject, message) {
    if (channel === 'Email') {
      const result = await mailHelper.sendMail(ispId, { to: recipient, subject, text: message });
      if (!result?.success) throw new Error(result?.error || 'SMTP rejected the alarm email');
      return result;
    }
    if (channel === 'SMS') {
      const result = await this.sms.sendSms(ispId, recipient, message);
      if (result?.error) throw new Error(result.message || 'SMS provider rejected the alarm');
      return result;
    }
    if (channel === 'WhatsApp') return whatsappService.sendMessage(ispId, recipient, message);
    throw new Error(`Unsupported alarm channel: ${channel}`);
  }

  recipientsFor(channel, raw) {
    const all = String(raw || '').split(/[;,\n]+/).map(value => value.trim()).filter(Boolean);
    if (channel === 'Email') return all.filter(value => value.includes('@'));
    return all.filter(value => !value.includes('@')).map(value => value.replace(/[^\d+]/g, '')).filter(Boolean);
  }

  async evaluate(device, snapshot) {
    for (const rule of await this.rulesFor(device.ispId)) {
      const current = this.metricValue(snapshot, rule.metric);
      if (current === null || current === undefined) continue;
      const numeric = Number(current), threshold = Number(rule.value);
      const triggered = rule.metric === 'status'
        ? String(current).toLowerCase() !== 'online'
        : rule.operator === 'gt' ? numeric > threshold : rule.operator === 'lt' ? numeric < threshold : numeric === threshold;
      if (!triggered) continue;
      const key = `${device.ispId}:${rule.id}:${device.id}`;
      const cooldownMs = Math.max(1, Number(rule.cooldownMinutes) || 15) * 60000;
      if (Date.now() - (this.lastTriggered.get(key) || 0) < cooldownMs) continue;
      const subject = `ALERT: Device ${device.name} triggered ${rule.name}`;
      const message = `Device: ${device.name} (${device.host})\nRule: ${rule.name}\nMetric: ${rule.metric}\nValue: ${current} (threshold: ${rule.operator} ${rule.value})\nTimestamp: ${new Date().toISOString()}`;
      const deliveries = [];
      for (const channel of Array.isArray(rule.channels) ? rule.channels : ['Email']) {
        for (const recipient of this.recipientsFor(channel, rule.recipients)) deliveries.push(this.send(device.ispId, channel, recipient, subject, message));
      }
      if (!deliveries.length) continue;
      const results = await Promise.allSettled(deliveries);
      if (results.some(result => result.status === 'fulfilled')) this.lastTriggered.set(key, Date.now());
      results.filter(result => result.status === 'rejected').forEach(result => console.error('[Telemetry Alarm Delivery]', result.reason?.message || result.reason));
    }
  }
}

module.exports = TelemetryAlarmService;
