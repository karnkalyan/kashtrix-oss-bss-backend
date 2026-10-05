const path = require('path');
const crypto = require('crypto');
const { AsteriskProvisioningAdapter } = require('./asterisk-provisioning-adapter');
const { getAmiClient } = require('./asterisk-ami-client');

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
  #astConfig = null;
  #adapter = null;

  constructor(ispId, prisma, config, astConfig = null) {
    this.#ispId = ispId;
    this.#prisma = prisma;
    this.#config = config;
    this.#astConfig = astConfig;
    this.#adapter = AsteriskProvisioningAdapter.create(config, prisma);
  }

  #getAmi() {
    return getAmiClient(this.#ispId, this.#astConfig || this.#config);
  }

  static async getService(ispId, prisma) {
    let config = await prisma.asteriskProvisioningConfig.findUnique({
      where: { ispId }
    });
    const astConfig = await prisma.asteriskConfig.findUnique({
      where: { ispId }
    });
    if (!config) {
      config = {
        ispId,
        enabled: astConfig ? astConfig.enabled : false,
        provisioningMode: (astConfig && astConfig.amiEnabled) ? 'ami' : 'disabled',
        mode: (astConfig && astConfig.amiEnabled) ? 'ami' : 'disabled'
      };
    }
    return new AsteriskProvisioningService(ispId, prisma, config, astConfig);
  }

  getAdapter() {
    return this.#adapter;
  }

  isConfigured() {
    const provMode = this.#config?.provisioningMode || this.#config?.mode;
    if (this.#config && (this.#config.enabled || this.#config.provisioningEnabled)) {
      if (['local', 'ssh', 'ami', 'ari'].includes(provMode)) return true;
    }
    if (this.#astConfig && this.#astConfig.enabled && (this.#astConfig.amiEnabled || this.#astConfig.ariEnabled)) {
      return true;
    }
    return false;
  }

  async getCapabilities() {
    if (!this.isConfigured()) {
      return {
        configured: false,
        mode: null,
        features: []
      };
    }
    const ami = this.#getAmi();
    const amiActive = ami && ami.connected;
    return {
      configured: true,
      mode: this.#config.provisioningMode || this.#config.mode || 'ami',
      amiConnected: !!amiActive,
      features: [
        'create_extension',
        'update_extension',
        'delete_extension',
        'enable_extension',
        'disable_extension',
        'reload_pjsip',
        'reload_dialplan',
        'dialplan_live_injection',
        'service_status',
        'service_start',
        'service_stop',
        'service_restart'
      ]
    };
  }

  #assertConfigured() {
    if (!this.isConfigured()) {
      const err = new Error('Asterisk service/provisioning is not configured for this ISP');
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

    const provMode = this.#config.provisioningMode || this.#config.mode;
    if (['local', 'ssh'].includes(provMode)) {
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
      } catch (err) {
        console.warn('[ASTERISK FILE PROVISIONING WARNING]:', err.message);
      } finally {
        this.#releaseLock();
      }
    }

    // AMI Live Dialplan & Reload
    const ami = this.#getAmi();
    if (ami && ami.connected) {
      try {
        await ami.addDialplanExtension({
          context,
          extension: extNumber,
          priority: 1,
          app: 'Dial',
          appData: `PJSIP/${extNumber},30`,
          replace: true
        });
      } catch (amiErr) {
        console.warn('[AMI addDialplanExtension warning]:', amiErr.message);
      }
    }
    await this.reloadPjsip();
    await this.reloadDialplan();

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

    const provMode = this.#config.provisioningMode || this.#config.mode;
    if (['local', 'ssh'].includes(provMode)) {
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
      } catch (err) {
        console.warn('[ASTERISK FILE DELETE WARNING]:', err.message);
      } finally {
        this.#releaseLock();
      }
    }

    // AMI Live Dialplan extension removal & reload
    const ami = this.#getAmi();
    if (ami && ami.connected) {
      try {
        await ami.removeDialplanExtension({ context: 'internal', extension: extNumber });
      } catch (amiErr) {
        console.warn('[AMI removeDialplanExtension warning]:', amiErr.message);
      }
    }
    await this.reloadPjsip();
    await this.reloadDialplan();

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
    const provMode = this.#config.provisioningMode || this.#config.mode;
    if (['local', 'ssh'].includes(provMode)) {
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
      } catch (err) {
        console.warn('[ASTERISK FILE ENABLE WARNING]:', err.message);
      } finally {
        this.#releaseLock();
      }
    }
    const ami = this.#getAmi();
    if (ami && ami.connected) {
      try {
        await ami.addDialplanExtension({
          context: 'internal',
          extension: extNumber,
          priority: 1,
          app: 'Dial',
          appData: `PJSIP/${extNumber},30`,
          replace: true
        });
      } catch (e) {}
    }
    await this.reloadPjsip();
    await this.reloadDialplan();

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
    const provMode = this.#config.provisioningMode || this.#config.mode;
    if (['local', 'ssh'].includes(provMode)) {
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
      } catch (err) {
        console.warn('[ASTERISK FILE DISABLE WARNING]:', err.message);
      } finally {
        this.#releaseLock();
      }
    }
    const ami = this.#getAmi();
    if (ami && ami.connected) {
      try {
        await ami.removeDialplanExtension({ context: 'internal', extension: extNumber });
      } catch (e) {}
    }
    await this.reloadPjsip();
    await this.reloadDialplan();

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
    const provMode = this.#config.provisioningMode || this.#config.mode;
    if (['local', 'ssh'].includes(provMode)) {
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
      } catch (err) {
        console.warn('[ASTERISK FILE REGENERATE WARNING]:', err.message);
      } finally {
        this.#releaseLock();
      }
    }
    await this.reloadPjsip();
    return { success: true, generatedSecret: newSecret };
  }

  // System actions via AMI first, then CLI fallback
  async reloadPjsip() {
    const ami = this.#getAmi();
    if (ami && ami.connected) {
      try {
        await ami.reloadPjsip();
        return { success: true, method: 'AMI' };
      } catch (err) {
        console.warn('[AMI reloadPjsip warning]:', err.message);
      }
    }
    try {
      await this.#adapter.runAsteriskCli(['pjsip', 'reload']);
      return { success: true, method: 'CLI' };
    } catch (err) {
      console.warn('[ASTERISK reloadPjsip warning]:', err.message);
      return { success: false, error: err.message };
    }
  }

  async reloadDialplan() {
    const ami = this.#getAmi();
    if (ami && ami.connected) {
      try {
        await ami.reloadDialplan();
        return { success: true, method: 'AMI' };
      } catch (err) {
        console.warn('[AMI reloadDialplan warning]:', err.message);
      }
    }
    try {
      await this.#adapter.runAsteriskCli(['dialplan', 'reload']);
      return { success: true, method: 'CLI' };
    } catch (err) {
      console.warn('[ASTERISK reloadDialplan warning]:', err.message);
      return { success: false, error: err.message };
    }
  }

  async addDialplanExtension({ context = 'internal', extension, priority = 1, app = 'Dial', appData = '', replace = true }) {
    const ami = this.#getAmi();
    if (ami && ami.connected) {
      return ami.addDialplanExtension({ context, extension, priority, app, appData, replace });
    }
    throw new Error('AMI is not connected. Live dialplan manipulation requires active AMI connection.');
  }

  async removeDialplanExtension({ context = 'internal', extension }) {
    const ami = this.#getAmi();
    if (ami && ami.connected) {
      return ami.removeDialplanExtension({ context, extension });
    }
    throw new Error('AMI is not connected. Live dialplan manipulation requires active AMI connection.');
  }

  async executeAmiCommand(command) {
    const ami = this.#getAmi();
    if (ami && ami.connected) {
      return ami.executeCommand(command);
    }
    throw new Error('AMI is not connected.');
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
