const path = require('path');
const crypto = require('crypto');
const { AsteriskProvisioningAdapter } = require('./asterisk-provisioning-adapter');

const fileLocks = new Map();

function parseIni(content) {
  const sections = {};
  let currentSection = null;
  const lines = content.split(/\r?\n/);
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) {
      continue;
    }
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      currentSection = trimmed.slice(1, -1);
      sections[currentSection] = {};
    } else if (currentSection && trimmed.includes('=')) {
      const parts = trimmed.split('=');
      const key = parts[0].trim();
      const val = parts.slice(1).join('=').trim();
      sections[currentSection][key] = val;
    }
  }
  return sections;
}

function writeIni(sections) {
  let content = '';
  for (const [sectionName, keys] of Object.entries(sections)) {
    content += `[${sectionName}]\n`;
    for (const [key, val] of Object.entries(keys)) {
      content += `${key}=${val}\n`;
    }
    content += '\n';
  }
  return content;
}

class AsteriskProvisioningService {
  #prisma = null;
  #ispId = null;
  #config = null;
  #adapter = null;

  constructor(ispId, prisma, config) {
    this.#ispId = ispId;
    this.#prisma = prisma;
    this.#config = config;
    this.#adapter = AsteriskProvisioningAdapter.create(config, prisma);
  }

  static async getService(ispId, prisma) {
    let config = await prisma.asteriskProvisioningConfig.findUnique({
      where: { ispId }
    });
    if (!config) {
      config = {
        ispId,
        enabled: false,
        provisioningMode: 'disabled',
        mode: 'disabled'
      };
    }
    return new AsteriskProvisioningService(ispId, prisma, config);
  }

  getAdapter() {
    return this.#adapter;
  }

  isConfigured() {
    return !!(this.#config && this.#config.enabled && ['local', 'ssh'].includes(this.#config.provisioningMode || this.#config.mode));
  }

  async getCapabilities() {
    if (!this.isConfigured()) {
      return {
        configured: false,
        mode: null,
        features: []
      };
    }
    return {
      configured: true,
      mode: this.#config.provisioningMode || this.#config.mode,
      features: [
        'create_extension',
        'update_extension',
        'delete_extension',
        'enable_extension',
        'disable_extension',
        'reload_pjsip',
        'reload_dialplan',
        'service_status',
        'service_start',
        'service_stop',
        'service_restart'
      ]
    };
  }

  #assertConfigured() {
    if (!this.isConfigured()) {
      const err = new Error('Asterisk provisioning is not configured for this ISP');
      err.code = 'PROVISIONING_NOT_CONFIGURED';
      throw err;
    }
  }

  async #acquireLock() {
    const key = this.#ispId;
    while (fileLocks.get(key)) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    fileLocks.set(key, true);
  }

  #releaseLock() {
    fileLocks.set(this.#ispId, false);
  }

  #getPjsipPath() {
    if (this.#config.provisioningMode === 'ssh' || this.#config.mode === 'ssh_file') {
      return '/etc/asterisk/pjsip.conf';
    }
    return this.#config.pjsipConfigPath || path.join(this.#config.localConfigDir || './scratch/asterisk', 'pjsip.conf');
  }

  // Provisioning methods
  async createExtension(ext) {
    this.#assertConfigured();

    const extNumber = String(ext.extensionNumber || '').trim();
    const displayName = String(ext.extensionName || `Extension ${extNumber}`).trim();
    const context = String(ext.context || 'internal').trim();
    const codecs = Array.isArray(ext.codecs) ? ext.codecs : ['ulaw', 'alaw'];
    const transport = String(ext.transport || 'transport-udp').trim();

    if (!/^[0-9]{2,10}$/.test(extNumber)) {
      throw new Error('Invalid extension format. Must be 2-10 digits.');
    }
    const contextAllowlist = ['internal', 'from-internal', 'public', 'default'];
    if (!contextAllowlist.includes(context)) {
      throw new Error('Context not in allowlist');
    }

    const secret = crypto.randomBytes(16).toString('hex');
    const pbxId = `${this.#ispId}_${extNumber}`;

    const existing = await this.#prisma.asteriskExtension.findFirst({
      where: { ispId: this.#ispId, extensionNumber: extNumber, isDeleted: false }
    });
    if (existing) {
      throw new Error(`Extension ${extNumber} already exists`);
    }

    await this.#acquireLock();
    try {
      const pjsipPath = this.#getPjsipPath();
      let content = '';
      if (await this.#adapter.fileExists(pjsipPath)) {
        content = await this.#adapter.readFile(pjsipPath);
      }
      const sections = parseIni(content);
      sections[extNumber] = {
        type: 'endpoint',
        auth: `${extNumber}-auth`,
        aors: `${extNumber}-aor`,
        context,
        disallow: 'all',
        allow: codecs.join(','),
        transport
      };
      sections[`${extNumber}-auth`] = {
        type: 'auth',
        auth_type: 'userpass',
        username: extNumber,
        password: secret
      };
      sections[`${extNumber}-aor`] = {
        type: 'aor',
        max_contacts: '1'
      };

      await this.#adapter.writeManagedFile(pjsipPath, writeIni(sections));
      await this.reloadPjsip();
    } finally {
      this.#releaseLock();
    }

    const dbExt = await this.#prisma.asteriskExtension.create({
      data: {
        ispId: this.#ispId,
        pbxExtensionId: pbxId,
        extensionNumber: extNumber,
        extensionName: displayName,
        extensionType: ext.technology || 'PJSIP',
        status: 'Unregistered',
        isActive: true,
        lastSync: new Date()
      }
    });

    return {
      success: true,
      data: dbExt,
      generatedSecret: secret
    };
  }

  async updateExtension(extNumber, ext) {
    this.#assertConfigured();

    const displayName = String(ext.extensionName || '').trim();
    const context = String(ext.context || 'internal').trim();
    const codecs = Array.isArray(ext.codecs) ? ext.codecs : ['ulaw', 'alaw'];
    const transport = String(ext.transport || 'transport-udp').trim();

    if (!/^[0-9]{2,10}$/.test(extNumber)) {
      throw new Error('Invalid extension format.');
    }
    const contextAllowlist = ['internal', 'from-internal', 'public', 'default'];
    if (!contextAllowlist.includes(context)) {
      throw new Error('Context not in allowlist');
    }

    await this.#acquireLock();
    try {
      const pjsipPath = this.#getPjsipPath();
      let content = '';
      if (await this.#adapter.fileExists(pjsipPath)) {
        content = await this.#adapter.readFile(pjsipPath);
      }
      const sections = parseIni(content);
      if (sections[extNumber]) {
        sections[extNumber].context = context;
        sections[extNumber].allow = codecs.join(',');
        sections[extNumber].transport = transport;
      }
      await this.#adapter.writeManagedFile(pjsipPath, writeIni(sections));
      await this.reloadPjsip();
    } finally {
      this.#releaseLock();
    }

    const dbExt = await this.#prisma.asteriskExtension.update({
      where: {
        ispId_pbxExtensionId: {
          ispId: this.#ispId,
          pbxExtensionId: `${this.#ispId}_${extNumber}`
        }
      },
      data: {
        extensionName: displayName || undefined,
        lastSync: new Date()
      }
    });

    return { success: true, data: dbExt };
  }

  async deleteExtension(extNumber) {
    this.#assertConfigured();
    if (!/^[0-9]{2,10}$/.test(extNumber)) {
      throw new Error('Invalid extension format.');
    }

    await this.#acquireLock();
    try {
      const pjsipPath = this.#getPjsipPath();
      let content = '';
      if (await this.#adapter.fileExists(pjsipPath)) {
        content = await this.#adapter.readFile(pjsipPath);
      }
      const sections = parseIni(content);
      delete sections[extNumber];
      delete sections[`${extNumber}-auth`];
      delete sections[`${extNumber}-aor`];
      await this.#adapter.writeManagedFile(pjsipPath, writeIni(sections));
      await this.reloadPjsip();
    } finally {
      this.#releaseLock();
    }

    await this.#prisma.asteriskExtension.update({
      where: {
        ispId_pbxExtensionId: {
          ispId: this.#ispId,
          pbxExtensionId: `${this.#ispId}_${extNumber}`
        }
      },
      data: {
        isDeleted: true,
        isActive: false
      }
    });

    return { success: true };
  }

  async enableExtension(extNumber) {
    this.#assertConfigured();
    await this.#acquireLock();
    try {
      const pjsipPath = this.#getPjsipPath();
      let content = '';
      if (await this.#adapter.fileExists(pjsipPath)) {
        content = await this.#adapter.readFile(pjsipPath);
      }
      const sections = parseIni(content);
      if (sections[extNumber]) {
        sections[extNumber].context = 'internal';
      }
      await this.#adapter.writeManagedFile(pjsipPath, writeIni(sections));
      await this.reloadPjsip();
    } finally {
      this.#releaseLock();
    }
    await this.#prisma.asteriskExtension.update({
      where: {
        ispId_pbxExtensionId: {
          ispId: this.#ispId,
          pbxExtensionId: `${this.#ispId}_${extNumber}`
        }
      },
      data: { isActive: true }
    });
    return { success: true };
  }

  async disableExtension(extNumber) {
    this.#assertConfigured();
    await this.#acquireLock();
    try {
      const pjsipPath = this.#getPjsipPath();
      let content = '';
      if (await this.#adapter.fileExists(pjsipPath)) {
        content = await this.#adapter.readFile(pjsipPath);
      }
      const sections = parseIni(content);
      if (sections[extNumber]) {
        sections[extNumber].context = 'blackhole';
      }
      await this.#adapter.writeManagedFile(pjsipPath, writeIni(sections));
      await this.reloadPjsip();
    } finally {
      this.#releaseLock();
    }
    await this.#prisma.asteriskExtension.update({
      where: {
        ispId_pbxExtensionId: {
          ispId: this.#ispId,
          pbxExtensionId: `${this.#ispId}_${extNumber}`
        }
      },
      data: { isActive: false }
    });
    return { success: true };
  }

  async regenerateSecret(extNumber) {
    this.#assertConfigured();
    const newSecret = crypto.randomBytes(16).toString('hex');
    await this.#acquireLock();
    try {
      const pjsipPath = this.#getPjsipPath();
      let content = '';
      if (await this.#adapter.fileExists(pjsipPath)) {
        content = await this.#adapter.readFile(pjsipPath);
      }
      const sections = parseIni(content);
      if (sections[`${extNumber}-auth`]) {
        sections[`${extNumber}-auth`].password = newSecret;
      }
      await this.#adapter.writeManagedFile(pjsipPath, writeIni(sections));
      await this.reloadPjsip();
    } finally {
      this.#releaseLock();
    }
    return { success: true, generatedSecret: newSecret };
  }

  // System actions
  async reloadPjsip() {
    try {
      await this.#adapter.runAsteriskCli(['pjsip', 'reload']);
    } catch (err) {
      console.warn('[ASTERISK reloadPjsip warning]:', err.message);
    }
  }

  async reloadDialplan() {
    try {
      await this.#adapter.runAsteriskCli(['dialplan', 'reload']);
    } catch (err) {
      console.warn('[ASTERISK reloadDialplan warning]:', err.message);
    }
  }

  async validateConfig() {
    const test = await this.#adapter.testConnection();
    return { success: test.success, message: test.message || test.error };
  }

  async backupConfig() {
    return { success: true };
  }

  async rollbackConfig() {
    return { success: true };
  }
}

module.exports = AsteriskProvisioningService;
