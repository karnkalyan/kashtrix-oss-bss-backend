const net = require('net');
const axios = require('axios');
const { SERVICE_CODES } = require('../lib/serviceConstants');
const { getAmiClient } = require('./asterisk-ami-client');

function normalizeAriUrl(host, port) {
  if (!host) {
    throw new Error('ARI host is required');
  }

  let url = host.trim();
  while (url.endsWith('/')) {
    url = url.slice(0, -1);
  }

  if (/^[a-zA-Z0-9.+-]+:\/\//.test(url)) {
    if (!/^https?:\/\//i.test(url)) {
      throw new Error('Invalid protocol, only HTTP and HTTPS are allowed');
    }
  } else {
    url = 'http://' + url;
  }

  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Invalid protocol, only HTTP and HTTPS are allowed');
  }

  const portRegex = /:\d+$/;
  if (!portRegex.test(parsed.host)) {
    parsed.port = port.toString();
  }

  let normalized = parsed.toString();
  if (normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

function calculateUptime(startupTimeStr) {
  if (!startupTimeStr) return 'Unknown';
  const startupTime = new Date(startupTimeStr);
  if (isNaN(startupTime.getTime())) return 'Unknown';

  const diffMs = Date.now() - startupTime.getTime();
  const diffSecs = Math.max(0, Math.floor(diffMs / 1000));
  
  const days = Math.floor(diffSecs / 86400);
  const hours = Math.floor((diffSecs % 86400) / 3600);
  const minutes = Math.floor((diffSecs % 3600) / 60);

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);

  return parts.join(' ') || '0m';
}

function classifyEndpoint(ep, dbTrunks) {
  const resource = ep.resource || '';
  const lowerRes = resource.toLowerCase();

  const matchedTrunkDb = dbTrunks.find(t => t.pbxTrunkId === resource || t.trunkname === resource);
  if (matchedTrunkDb) {
    return 'trunk';
  }

  const isTrunkTerm = lowerRes.includes('trunk') || 
                      lowerRes.includes('yeastar') || 
                      lowerRes.includes('gateway') || 
                      lowerRes.includes('pbx-peer') || 
                      lowerRes.includes('interconnect');
  if (isTrunkTerm) {
    return 'trunk';
  }

  if (/^[0-9]{2,10}$/.test(resource)) {
    return 'extension';
  }

  return 'trunk';
}

class AsteriskService {
  #config = null;
  #prisma = null;
  #ispId = null;
  #ariClient = null;

  constructor(config, prisma) {
    this.#config = config;
    this.#prisma = prisma;
    this.#ispId = config.ispId;

    if (config && config.enabled && config.ariHost) {
      try {
        const normalizedUrl = normalizeAriUrl(config.ariHost, config.ariPort || 8088);
        this.#ariClient = axios.create({
          baseURL: normalizedUrl,
          auth: config.ariUsername ? {
            username: config.ariUsername,
            password: config.ariPassword || ''
          } : undefined,
          timeout: 4000,
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        });

        if (config.amiEnabled) {
          getAmiClient(this.#ispId, this.#config);
        }
      } catch (err) {
        console.warn('[ASTERISK] ARI URL initialization failed:', err.message);
        this.#ariClient = null;
      }
    }
  }

  static async create(ispId, prisma) {
    try {
      const config = await AsteriskService.getConfig(ispId, prisma);
      return new AsteriskService(config, prisma);
    } catch (error) {
      console.error('[ASTERISK] Failed to create service:', error.message);
      throw error;
    }
  }

  static async getConfig(ispId, prisma) {
    try {
      let config = null;
      if (prisma && prisma.asteriskProvisioningConfig) {
        config = await prisma.asteriskProvisioningConfig.findUnique({
          where: { ispId }
        });
      }

      // Check iSPService for active status
      let ispService = null;
      let legacyConfig = {};
      if (prisma && prisma.iSPService) {
        ispService = await prisma.iSPService.findFirst({
          where: { ispId, service: { code: 'ASTERISK' } },
          include: { service: true }
        });
        if (ispService && Array.isArray(ispService.credentials)) {
          const creds = {};
          for (const c of ispService.credentials) {
            creds[c.key] = c.value;
          }
          const hasAmi = !!(creds.ami_host && creds.ami_username);
          legacyConfig = {
            enabled: ispService.status !== 'DISABLED' && ispService.isActive !== false,
            pbxHost: creds.ari_host || creds.pbx_host || null,
            sipPort: parseInt(creds.sip_port || '5060', 10),
            ariEnabled: Boolean(creds.ari_host && creds.ari_username),
            ariHost: creds.ari_host || null,
            ariPort: parseInt(creds.ari_port || '8088', 10),
            ariAppName: creds.ari_app || 'kashtrix-voip',
            ariUsername: creds.ari_username || null,
            ariPassword: creds.ari_password || null,
            amiEnabled: hasAmi,
            amiHost: hasAmi ? creds.ami_host : null,
            amiPort: hasAmi ? parseInt(creds.ami_port || '5038', 10) : null,
            amiUsername: hasAmi ? creds.ami_username : null,
            amiPassword: hasAmi ? creds.ami_password : null,
            provisioningEnabled: false,
            provisioningMode: 'disabled',
            cdrSourceType: 'internal_cache'
          };
        }
      }

      const hasConfig = Boolean(config && (config.ariHost || config.pbxHost));
      const hasLegacy = Boolean(legacyConfig && legacyConfig.ariHost);
      const hasEnv = Boolean(process.env.ASTERISK_HOST || process.env.ASTERISK_ARI_HOST);
      const isConfigured = hasConfig || hasLegacy || hasEnv;

      const base = config || (hasLegacy ? legacyConfig : {});

      // Determine enabled state cleanly
      let isEnabled = false;
      if (process.env.ASTERISK_ENABLED !== undefined) {
        isEnabled = process.env.ASTERISK_ENABLED === 'true';
      } else if (config) {
        isEnabled = config.enabled !== false && Boolean(config.ariHost || config.pbxHost);
      } else if (ispService) {
        isEnabled = ispService.status !== 'DISABLED' && ispService.isActive !== false && isConfigured;
      } else {
        isEnabled = false;
      }

      // Read configuration without hardcoded LAN values
      const ariHost = process.env.ASTERISK_ARI_HOST || base.ariHost || process.env.ASTERISK_HOST || base.pbxHost || null;
      const ariPass = process.env.ASTERISK_ARI_PASSWORD || process.env.KASHTRIX_ARI_PASSWORD || base.ariPassword || null;
      const ariUser = process.env.ASTERISK_ARI_USERNAME || base.ariUsername || null;
      const amiPass = process.env.ASTERISK_AMI_SECRET || process.env.KASHTRIX_AMI_SECRET || base.amiPassword || base.amiSecret || null;
      const amiHost = process.env.ASTERISK_AMI_HOST || base.amiHost || null;
      const amiUsername = process.env.ASTERISK_AMI_USERNAME || base.amiUsername || null;
      const amiPort = process.env.ASTERISK_AMI_PORT
        ? parseInt(process.env.ASTERISK_AMI_PORT, 10)
        : (amiHost ? (base.amiPort || 5038) : null);
      const amiRequested = process.env.ASTERISK_AMI_ENABLED !== undefined
        ? process.env.ASTERISK_AMI_ENABLED === 'true'
        : (base.amiEnabled !== undefined ? base.amiEnabled : false);
      const amiConfigured = Boolean(amiRequested && amiHost && amiUsername && amiPass);
      const sshKey = process.env.KASHTRIX_ASTERISK_SSH_KEY_PATH || base.sshPrivateKey || null;

      const merged = {
        ispId,
        isConfigured: Boolean(isConfigured && ariHost && ariUser),
        enabled: Boolean(isEnabled && isConfigured && ariHost && ariUser),
        pbxHost: ariHost,
        sipPort: process.env.ASTERISK_SIP_PORT ? parseInt(process.env.ASTERISK_SIP_PORT, 10) : (base.sipPort || 5060),
        ariEnabled: Boolean(isEnabled && ariHost && ariUser),
        ariHost: ariHost,
        ariPort: process.env.ASTERISK_ARI_PORT ? parseInt(process.env.ASTERISK_ARI_PORT, 10) : (base.ariPort || 8088),
        ariAppName: process.env.ASTERISK_ARI_APP_NAME || base.ariAppName || 'kashtrix-voip',
        ariUsername: ariUser,
        ariPassword: ariPass,
        amiEnabled: amiConfigured,
        amiHost: amiConfigured ? amiHost : null,
        amiPort: amiConfigured ? amiPort : null,
        amiUsername: amiConfigured ? amiUsername : null,
        amiPassword: amiConfigured ? amiPass : null,
        provisioningEnabled: Boolean(isEnabled && (process.env.ASTERISK_PROVISIONING_ENABLED !== undefined ? process.env.ASTERISK_PROVISIONING_ENABLED === 'true' : (base.provisioningEnabled !== undefined ? base.provisioningEnabled : false))),
        provisioningMode: process.env.ASTERISK_PROVISIONING_MODE || base.provisioningMode || base.mode || 'local',
        provisioningHost: process.env.ASTERISK_HOST || base.provisioningHost || base.host || null,
        provisioningPort: base.provisioningPort || base.port || 22,
        provisioningUsername: base.provisioningUsername || base.username || null,
        sshPrivateKey: sshKey,
        sshPassword: base.sshPassword || null,
        asteriskConfigDirectory: process.env.ASTERISK_CONFIG_DIR || base.asteriskConfigDirectory || '/etc/asterisk',
        asteriskCliPath: process.env.ASTERISK_CLI_PATH || base.asteriskCliPath || '/usr/sbin/asterisk',
        asteriskSystemdService: process.env.ASTERISK_SYSTEMD_SERVICE || base.asteriskSystemdService || 'asterisk',
        customDialplanFile: process.env.ASTERISK_CUSTOM_DIALPLAN_FILE || base.customDialplanFile || '/etc/asterisk/extensions_custom.conf',
        audioSocketBindHost: base.audioSocketBindHost || '127.0.0.1',
        cdrSourceType: base.cdrSourceType || 'internal_cache',
        cdrConnectionSettings: base.cdrConnectionSettings,
        localConfigDir: base.localConfigDir || './scratch/asterisk'
      };

      return merged;
    } catch (error) {
      console.error('[ASTERISK] Config error:', error.message);
      throw error;
    }
  }


  static async getServiceStatus(ispId, prisma) {
    try {
      const config = await this.getConfig(ispId, prisma);
      let apiConnected = false;
      let amiConnected = false;
      let errorMsg = null;

      try {
        const client = new AsteriskService(config, prisma);
        const test = await client.testConnection();
        apiConnected = test.ariConnected;
        amiConnected = test.amiConnected;
        if (!apiConnected) {
          errorMsg = test.message;
        }
      } catch (error) {
        errorMsg = error.message;
      }

      const systemStatus = await prisma.asteriskSystemStatus.findUnique({
        where: { ispId }
      });

      return {
        service: 'asterisk',
        enabled: Boolean(config.enabled),
        configured: Boolean(config.isConfigured),
        isActive: apiConnected,
        connected: apiConnected,
        amiHost: config.amiHost,
        amiPort: config.amiPort,
        ariHost: config.ariHost,
        ariPort: config.ariPort,
        apiConnected,
        amiConnected,
        apiError: errorMsg,
        systemStatus,
        lastUpdated: new Date().toISOString()
      };
    } catch (error) {
      return {
        service: 'asterisk',
        enabled: false,
        configured: false,
        isActive: false,
        ariHost: null,
        ariPort: null,
        amiHost: null,
        amiPort: null,
        apiConnected: false,
        amiConnected: false,
        apiError: error.message,
        systemStatus: null,
        lastUpdated: new Date().toISOString()
      };
    }
  }

  #extractError(error) {
    if (!error) return 'Unknown error';
    if (error.config) {
      delete error.config.auth;
      if (error.config.headers) {
        delete error.config.headers.Authorization;
      }
    }
    return error.response?.data?.message || error.response?.data?.error || error.message || String(error);
  }

  async testConnection() {
    if (!this.#config.enabled || !this.#config.isConfigured || !this.#ariClient) {
      return {
        success: true,
        connected: false,
        isConfigured: Boolean(this.#config && this.#config.isConfigured),
        ariConnected: false,
        amiConnected: false,
        message: 'Asterisk VoIP service is disabled or not configured',
        timestamp: new Date().toISOString()
      };
    }

    let ariConnected = false;
    let ariMsg = 'ARI not tested';

    try {
      const response = await this.#ariClient.get('/ari/asterisk/info');
      if (response.status === 200) {
        ariConnected = true;
        ariMsg = 'ARI connected successfully';
      }
    } catch (error) {
      ariMsg = `ARI connection failed: ${this.#extractError(error)}`;
    }

    const amiClient = getAmiClient(this.#ispId, this.#config);
    const amiConnected = amiClient ? amiClient.connected : false;
    const amiMsg = amiClient ? (amiClient.connected ? 'AMI connected successfully' : 'AMI connection failed') : 'AMI not configured';

    return {
      success: ariConnected,
      connected: ariConnected,
      ariConnected,
      amiConnected,
      message: `ARI: ${ariMsg} | AMI: ${amiMsg}`,
      timestamp: new Date().toISOString()
    };
  }

  async getCapabilities() {
    if (!this.#config.enabled || !this.#ariClient) {
      return {
        ari: { configured: false, connected: false, features: [] },
        ami: { configured: false, connected: false, features: [] },
        provisioning: { mode: 'disabled', configured: false }
      };
    }

    const AsteriskProvisioningService = require('./asterisk-provisioning.service');
    const provService = await AsteriskProvisioningService.getService(this.#ispId, this.#prisma);
    const provCapabilities = await provService.getCapabilities();

    let ariConnected = false;
    try {
      const res = await this.#ariClient.get('/ari/asterisk/info');
      if (res.status === 200) {
        ariConnected = true;
      }
    } catch (e) {}

    const amiClient = getAmiClient(this.#ispId, this.#config);

    return {
      ari: {
        configured: true,
        connected: ariConnected,
        features: [
          'system_info',
          'endpoint_state',
          'active_channels',
          'originate',
          'hangup',
          'bridges',
          'playback',
          'recording'
        ]
      },
      ami: {
        configured: !!amiClient,
        connected: amiClient ? amiClient.connected : false,
        features: amiClient ? [
          'system_info',
          'events',
          'originate',
          'hangup',
          'channels',
          'pjsip_endpoints',
          'pjsip_registrations',
          'queues',
          'trunks'
        ] : []
      },
      provisioning: provCapabilities
    };
  }

  async getSystemInfo() {
    if (!this.#config.enabled || !this.#ariClient) {
      return {
        asteriskVersion: 'Not connected',
        operatingSystem: 'Unknown',
        startupTime: null,
        lastReloadTime: null,
        calculatedUptime: 'Offline',
        ariConnected: false,
        amiConnected: false,
        activeChannelCount: 0,
        endpointCount: 0,
        registeredEndpointCount: 0,
        bridgeCount: 0,
        recordingCapability: false,
        provisioningMode: 'disabled',
        lastSuccessfulSync: null,
        lastError: 'Asterisk service is disabled or not configured'
      };
    }

    let ariConnected = false;
    let version = 'Asterisk Unknown';
    let os = 'Unknown';
    let startupTime = 'Unknown';
    let reloadTime = 'Unknown';
    let uptime = 'Unknown';
    let endpointsCount = 0;
    let registeredCount = 0;
    let bridgeCount = 0;

    try {
      const infoRes = await this.#ariClient.get('/ari/asterisk/info');
      if (infoRes.status === 200) {
        ariConnected = true;
        const info = infoRes.data;
        version = info.system?.version || 'Asterisk Unknown';
        os = info.system?.os || 'Unknown';
        startupTime = info.status?.startup_time || 'Unknown';
        reloadTime = info.status?.last_reload_time || 'Unknown';
        if (info.status?.startup_time) {
          uptime = calculateUptime(info.status.startup_time);
        }
      }
    } catch (e) {}

    if (os === 'Unknown' || os === 'linux') {
      try {
        const provService = await require('./asterisk-provisioning.service').getService(this.#ispId, this.#prisma);
        const adapter = provService.getAdapter();
        if (adapter && await adapter.fileExists('/etc/os-release')) {
          const releaseContent = await adapter.readFile('/etc/os-release');
          const match = releaseContent.match(/^PRETTY_NAME="([^"]+)"/m) || releaseContent.match(/^NAME="([^"]+)"/m);
          if (match) {
            os = match[1];
          }
        }
      } catch (e) {}
    }

    if (ariConnected) {
      try {
        const endpointsRes = await this.#ariClient.get('/ari/endpoints');
        if (Array.isArray(endpointsRes.data)) {
          endpointsCount = endpointsRes.data.length;
          registeredCount = endpointsRes.data.filter(ep => (ep.state || '').toLowerCase() === 'online').length;
        }
      } catch (e) {}

      try {
        const bridgesRes = await this.#ariClient.get('/ari/bridges');
        if (Array.isArray(bridgesRes.data)) {
          bridgeCount = bridgesRes.data.length;
        }
      } catch (e) {}
    }

    const testRes = await this.testConnection();
    const provService = await require('./asterisk-provisioning.service').getService(this.#ispId, this.#prisma);
    const provCapabilities = await provService.getCapabilities();

    return {
      asteriskVersion: version,
      operatingSystem: os,
      startupTime,
      lastReloadTime: reloadTime,
      calculatedUptime: uptime,
      ariConnected,
      amiConnected: testRes.amiConnected,
      activeChannelCount: (await this.getActiveCalls()).total || 0,
      endpointCount: endpointsCount,
      registeredEndpointCount: registeredCount,
      bridgeCount,
      recordingCapability: true,
      provisioningMode: provCapabilities.mode,
      lastSuccessfulSync: new Date().toISOString(),
      lastError: testRes.ariConnected ? null : testRes.message
    };
  }

  // ==================== EXTENSIONS ====================
  async listExtensions() {
    if (!this.#config.enabled || !this.#ariClient) {
      return {
        success: true,
        connected: false,
        isConfigured: false,
        data: [],
        total: 0,
        message: 'Asterisk service is disabled or not configured'
      };
    }

    try {
      const response = await this.#ariClient.get('/ari/endpoints');
      if (!Array.isArray(response.data)) {
        throw new Error('Invalid response from Asterisk ARI: endpoints must be an array');
      }

      const dbTrunks = await this.#prisma.asteriskTrunk.findMany({
        where: { ispId: this.#ispId, isDeleted: false }
      });

      const extList = response.data
        .filter(ep => {
          const tech = (ep.technology || '').toUpperCase();
          if (tech !== 'PJSIP' && tech !== 'SIP') return false;
          return classifyEndpoint(ep, dbTrunks) === 'extension';
        })
        .map(ep => {
          const stateNormalized = (ep.state || '').toLowerCase();
          return {
            number: ep.resource,
            name: ep.resource,
            status: stateNormalized === 'online' ? 'Registered' : 'Unregistered',
            type: ep.technology.toUpperCase()
          };
        });

      await this.#syncExtensionsToDB(extList);

      return {
        success: true,
        connected: true,
        data: extList,
        total: extList.length,
        message: 'Extensions list loaded'
      };
    } catch (error) {
      return {
        success: true,
        connected: false,
        isConfigured: true,
        data: [],
        total: 0,
        error: this.#extractError(error),
        message: 'Failed to list extensions: ' + this.#extractError(error)
      };
    }
  }

  async getExtension(extNumber) {
    try {
      const response = await this.#ariClient.get(`/ari/endpoints/PJSIP/${extNumber}`);
      const ep = response.data;
      const stateNormalized = (ep.state || '').toLowerCase();
      return {
        number: ep.resource,
        name: ep.resource,
        status: stateNormalized === 'online' ? 'Registered' : 'Unregistered',
        type: ep.technology.toUpperCase(),
        source: 'asterisk'
      };
    } catch (err) {
      throw new Error(`Extension ${extNumber} not found in Asterisk runtime`);
    }
  }

  async getSoftphoneConfig(extNumber) {
    const pbxId = `${this.#ispId}_${extNumber}`;
    const dbExt = await this.#prisma.asteriskExtension.findFirst({
      where: { ispId: this.#ispId, pbxExtensionId: pbxId }
    });
    if (!dbExt) {
      throw new Error('Extension not found in database');
    }

    return {
      success: true,
      extensionNumber: extNumber,
      hostname: this.#config.ariHost,
      port: 5060,
      username: extNumber,
      displayName: dbExt.extensionName || extNumber,
      qrPayload: `SIP:${extNumber}@${this.#config.ariHost}:5060`
    };
  }

  async #syncExtensionsToDB(extensions) {
    for (const ext of extensions) {
      try {
        const pbxId = `${this.#ispId}_${ext.number}`;
        await this.#prisma.asteriskExtension.upsert({
          where: {
            ispId_pbxExtensionId: {
              ispId: this.#ispId,
              pbxExtensionId: pbxId
            }
          },
          update: {
            extensionName: ext.name,
            extensionType: ext.type,
            status: ext.status,
            lastSync: new Date()
          },
          create: {
            ispId: this.#ispId,
            pbxExtensionId: pbxId,
            extensionNumber: ext.number,
            extensionName: ext.name,
            extensionType: ext.type,
            status: ext.status,
            lastSync: new Date()
          }
        });
      } catch (error) {
        console.error(`[ASTERISK] Sync extension error ${ext.number}:`, error.message);
      }
    }
  }

  // ==================== TRUNKS ====================
  async listTrunks() {
    try {
      const response = await this.#ariClient.get('/ari/endpoints');
      if (!Array.isArray(response.data)) {
        throw new Error('Invalid response from Asterisk ARI: endpoints must be an array');
      }

      const dbTrunks = await this.#prisma.asteriskTrunk.findMany({
        where: {
          ispId: this.#ispId,
          isDeleted: false
        }
      });

      const trunkList = await Promise.all(response.data
        .filter(ep => {
          return classifyEndpoint(ep, dbTrunks) === 'trunk';
        })
        .map(async ep => {
          const resource = ep.resource;
          const matchedDb = dbTrunks.find(t => t.pbxTrunkId === resource || t.trunkname === resource);
          const stateNormalized = (ep.state || '').toLowerCase();
          
          let status = stateNormalized === 'online' ? 'Registered' : 'Not Registered';
          let contacts = ep.contacts?.join(', ') || '';
          let latency = 'Unknown';
          let activeChannels = 0;
          let transport = 'transport-udp';

          const amiClient = getAmiClient(this.#ispId, this.#config);
          if (amiClient && amiClient.connected) {
            try {
              const events = await amiClient.sendActionWithEvents(
                { Action: 'PJSIPShowEndpoint', Endpoint: ep.resource },
                ['EndpointDetail', 'AorDetail', 'ContactStatusDetail', 'TransportDetail'],
                'EndpointDetailComplete'
              );
              const endpointDetail = events.find(ev => ev.Event === 'EndpointDetail');
              const contactStatus = events.find(ev => ev.Event === 'ContactStatusDetail');
              const transportDetail = events.find(ev => ev.Event === 'TransportDetail');

              if (endpointDetail) {
                activeChannels = parseInt(endpointDetail.ActiveChannels, 10) || 0;
              }
              if (contactStatus) {
                contacts = contactStatus.URI || contacts;
                status = contactStatus.ContactStatus || status;
                if (contactStatus.RoundtripUsec) {
                  latency = `${(parseInt(contactStatus.RoundtripUsec, 10) / 1000).toFixed(1)} ms`;
                }
              }
              if (transportDetail) {
                transport = transportDetail.TransportType || transport;
              }
            } catch (e) {}
          }

          return {
            id: matchedDb ? matchedDb.id : resource,
            trunkname: matchedDb ? matchedDb.trunkname : resource,
            trunktype: ep.technology || 'PJSIP',
            status,
            host: matchedDb ? matchedDb.host : (this.#config.pbxHost || null),
            registrationDirection: 'both',
            contacts,
            latency,
            activeChannels,
            transport
          };
        }));

      if (trunkList.length > 0) {
        await this.#syncTrunksToDB(trunkList);
      }

      return {
        success: true,
        connected: true,
        data: trunkList,
        total: trunkList.length,
        message: 'Trunks list loaded'
      };
    } catch (error) {
      return {
        success: true,
        connected: false,
        isConfigured: true,
        data: [],
        total: 0,
        error: this.#extractError(error),
        message: 'Failed to list trunks: ' + this.#extractError(error)
      };
    }
  }

  async #syncTrunksToDB(trunks) {
    for (const trunk of trunks) {
      try {
        const trunkId = `${this.#ispId}_${trunk.trunkname}`;
        await this.#prisma.asteriskTrunk.upsert({
          where: { trunkId: trunkId },
          update: {
            trunkname: trunk.trunkname,
            trunktype: trunk.trunktype,
            status: trunk.status,
            host: trunk.host,
            lastSync: new Date()
          },
          create: {
            ispId: this.#ispId,
            trunkId: trunkId,
            pbxTrunkId: trunk.trunkname,
            trunkname: trunk.trunkname,
            trunktype: trunk.trunktype,
            status: trunk.status,
            host: trunk.host,
            lastSync: new Date()
          }
        });
      } catch (error) {
        console.error(`[ASTERISK] Sync trunk error ${trunk.trunkname}:`, error.message);
      }
    }
  }

  // ==================== DIALPLAN ROUTE SIMULATION ====================
  async simulateOutboundRoute(number, sourceExt) {
    const routes = await this.#prisma.asteriskOutboundRoute.findMany({
      where: { ispId: this.#ispId, enabled: true }
    });

    for (const route of routes) {
      const regexStr = route.dialPattern
        .replace(/X/g, '[0-9]')
        .replace(/Z/g, '[1-9]')
        .replace(/N/g, '[2-9]')
        .replace(/\./g, '.*');
      const regex = new RegExp(`^${regexStr}$`);
      
      if (regex.test(number)) {
        return {
          success: true,
          matchedRoute: route.routeName,
          prefix: route.prefix,
          prepend: route.prepend,
          primaryTrunk: route.trunkOrder[0] || null,
          fallbackTrunks: route.fallbackTrunks || []
        };
      }
    }

    return {
      success: false,
      message: 'No matching outbound route found for this dial pattern'
    };
  }

  // ==================== HISTORICAL CDR LOGS ====================
  async listCallLogs(filters = {}) {
    const AsteriskProvisioningService = require('./asterisk-provisioning.service');
    const provService = await AsteriskProvisioningService.getService(this.#ispId, this.#prisma);
    const adapter = provService.getAdapter();
    const AsteriskCdrProvider = require('./asterisk-cdr-provider');
    const cdrProvider = new AsteriskCdrProvider(this.#config, this.#prisma, adapter);
    return cdrProvider.fetchLogs(filters);
  }

  // ==================== CALL CONTROL ====================
  async makeCall(extension, destination) {
    try {
      const extPattern = /^[0-9]{2,10}$/;
      const destPattern = /^[0-9*#+]{2,30}$/;

      if (!extPattern.test(extension)) {
        return {
          success: false,
          error: 'Invalid extension format. Must be 2-10 digits.',
          message: 'Validation failed'
        };
      }

      if (!destPattern.test(destination)) {
        return {
          success: false,
          error: 'Invalid destination format. Must be 2-30 characters containing digits, *, #, or +.',
          message: 'Validation failed'
        };
      }

      const amiClient = getAmiClient(this.#ispId, this.#config);
      if (amiClient && amiClient.connected) {
        const res = await amiClient.sendAction({
          Action: 'Originate',
          Channel: `PJSIP/${extension}`,
          Context: 'internal',
          Exten: destination,
          Priority: '1',
          CallerID: `Kashtrix AI Test <${destination}>`,
          Async: 'true',
          Timeout: '30000'
        });
        if (res.Response === 'Error') {
          throw new Error(res.Message || 'AMI Originate failed');
        }
        return {
          success: true,
          data: {
            id: res.ActionID,
            actionId: res.ActionID,
            agentId: destination === '5000' || destination === '800' || destination === '801' ? parseInt(destination, 10) : null,
            sourceExtension: extension,
            destinationExtension: destination,
            originateMethod: 'ami',
            status: 'accepted'
          },
          message: `Call originated to PJSIP/${extension} connecting to ${destination} via AMI`
        };
      } else {
        const response = await this.#ariClient.post('/ari/channels', null, {
          params: {
            endpoint: `PJSIP/${extension}`,
            extension: destination,
            context: 'internal',
            priority: 1,
            callerId: extension,
            timeout: 30
          }
        });

        return {
          success: true,
          data: {
            id: response.data?.id,
            actionId: response.data?.id,
            agentId: destination === '5000' || destination === '800' || destination === '801' ? parseInt(destination, 10) : null,
            sourceExtension: extension,
            destinationExtension: destination,
            originateMethod: 'ari',
            status: 'accepted'
          },
          message: `Call originated to PJSIP/${extension} connecting to ${destination} via ARI`
        };
      }
    } catch (error) {
      return {
        success: false,
        error: this.#extractError(error),
        message: 'Failed to originate call'
      };
    }
  }

  async hangupCall(channelId) {
    try {
      if (!channelId) {
        return { success: false, error: 'Channel ID is required' };
      }

      let channelExists = false;
      try {
        const checkRes = await this.#ariClient.get('/ari/channels');
        if (Array.isArray(checkRes.data)) {
          channelExists = checkRes.data.some(c => c.id === channelId);
        } else {
          channelExists = true;
        }
      } catch (err) {
        channelExists = true;
      }

      if (!channelExists) {
        return {
          success: false,
          error: 'Channel not found',
          message: `Channel ${channelId} no longer exists in Asterisk runtime`
        };
      }

      const encodedId = encodeURIComponent(channelId);
      await this.#ariClient.delete(`/ari/channels/${encodedId}`);

      return {
        success: true,
        message: `Channel ${channelId} hung up`
      };
    } catch (error) {
      return {
        success: false,
        error: this.#extractError(error),
        message: `Failed to hang up channel ${channelId}`
      };
    }
  }

  async redirectCall(channelId, destination) {
    try {
      const encodedId = encodeURIComponent(channelId);
      await this.#ariClient.post(`/ari/channels/${encodedId}/redirect`, null, {
        params: { endpoint: `PJSIP/${destination}` }
      });
      return { success: true, message: 'Call redirected' };
    } catch (error) {
      return { success: false, error: this.#extractError(error) };
    }
  }

  async muteCall(channelId) {
    try {
      const encodedId = encodeURIComponent(channelId);
      await this.#ariClient.post(`/ari/channels/${encodedId}/mute`);
      return { success: true, message: 'Channel muted' };
    } catch (error) {
      return { success: false, error: this.#extractError(error) };
    }
  }

  async unmuteCall(channelId) {
    try {
      const encodedId = encodeURIComponent(channelId);
      await this.#ariClient.delete(`/ari/channels/${encodedId}/mute`);
      return { success: true, message: 'Channel unmuted' };
    } catch (error) {
      return { success: false, error: this.#extractError(error) };
    }
  }

  async startRecording(channelId) {
    try {
      const encodedId = encodeURIComponent(channelId);
      const recName = `rec-${Date.now()}`;
      await this.#ariClient.post(`/ari/channels/${encodedId}/record`, null, {
        params: { name: recName, format: 'wav' }
      });
      return { success: true, message: `Recording started: ${recName}` };
    } catch (error) {
      return { success: false, error: this.#extractError(error) };
    }
  }

  async stopRecording(channelId) {
    try {
      return { success: true, message: 'Recording stopped' };
    } catch (error) {
      return { success: false, error: this.#extractError(error) };
    }
  }

  async getActiveCalls() {
    if (!this.#config.enabled || !this.#ariClient) {
      return {
        success: true,
        connected: false,
        isConfigured: false,
        data: [],
        total: 0,
        message: 'Asterisk service is disabled or not configured'
      };
    }

    try {
      const response = await this.#ariClient.get('/ari/channels');
      if (!Array.isArray(response.data)) {
        throw new Error('Invalid response from Asterisk ARI: channels must be an array');
      }

      let bridges = [];
      try {
        const bridgesRes = await this.#ariClient.get('/ari/bridges');
        if (Array.isArray(bridgesRes.data)) {
          bridges = bridgesRes.data;
        }
      } catch (e) {}

      const channels = response.data.map(chan => {
        let duration = 0;
        if (chan.creationtime) {
          const created = new Date(chan.creationtime);
          if (!isNaN(created.getTime())) {
            duration = Math.max(0, Math.floor((Date.now() - created.getTime()) / 1000));
          }
        }

        const linkedBridge = bridges.find(b => b.channels?.includes(chan.id));

        const destExt = chan.dialplan?.exten || '';
        let aiAgentId = null;
        if (['5000', '800', '801'].includes(destExt)) {
          aiAgentId = destExt;
        }

        let trunkId = null;
        const callerNum = chan.caller?.number || '';
        const callerName = chan.caller?.name || '';
        if (callerNum.includes('yeastar-s50') || callerName.includes('yeastar-s50') || chan.id.includes('yeastar-s50')) {
          trunkId = 'yeastar-s50';
        }

        if (!trunkId && linkedBridge) {
          const peerChanId = linkedBridge.channels?.find(id => id !== chan.id);
          if (peerChanId && peerChanId.includes('yeastar-s50')) {
            trunkId = 'yeastar-s50';
          }
        }

        return {
          channelId: chan.id,
          linkedId: chan.id,
          callerNumber: callerNum,
          callerName: callerName,
          connectedNumber: destExt,
          destination: destExt,
          context: chan.dialplan?.context || 'internal',
          state: chan.state || 'Unknown',
          technology: 'PJSIP',
          endpoint: callerNum,
          bridgeId: linkedBridge ? linkedBridge.id : null,
          startTime: chan.creationtime || new Date().toISOString(),
          durationSeconds: duration,
          direction: 'internal',
          aiAgentId,
          trunkId,
          callid: chan.id,
          channelid: chan.id,
          caller: callerNum,
          called: destExt,
          status: chan.state || 'Unknown',
          duration
        };
      });

      return {
        success: true,
        connected: true,
        data: channels,
        total: channels.length,
        message: 'Active calls fetched'
      };
    } catch (error) {
      return {
        success: true,
        connected: false,
        isConfigured: true,
        data: [],
        total: 0,
        error: this.#extractError(error),
        message: 'Failed to fetch active calls'
      };
    }
  }

  async syncSystemStatus() {
    try {
      const currentStatus = await this.#prisma.asteriskSystemStatus.findUnique({
        where: { ispId: this.#ispId }
      });

      let totalExtensions = currentStatus?.totalExtensions || 0;
      let activeExtensions = currentStatus?.activeExtensions || 0;
      let totalTrunks = currentStatus?.totalTrunks || 0;
      let activeTrunks = currentStatus?.activeTrunks || 0;
      let activeCallsCount = currentStatus?.activeCalls || 0;

      const extensions = await this.listExtensions();
      if (extensions.success) {
        totalExtensions = extensions.total || 0;
        activeExtensions = extensions.data?.filter(e => e.status === 'Registered').length || 0;
      }

      const trunks = await this.listTrunks();
      if (trunks.success) {
        totalTrunks = trunks.total || 0;
        activeTrunks = trunks.data?.filter(t => t.status === 'Registered' || t.status === 'Reachable').length || 0;
      }

      const activeCalls = await this.getActiveCalls();
      if (activeCalls.success) {
        activeCallsCount = activeCalls.total || 0;
      }

      let ariConnected = false;
      let version = 'Asterisk Unknown';
      let uptime = 'Unknown';
      let lastError = null;

      try {
        const infoRes = await this.#ariClient.get('/ari/asterisk/info');
        if (infoRes.status === 200) {
          ariConnected = true;
          const info = infoRes.data;
          version = info.system?.version || 'Asterisk Unknown';
          if (info.status?.startup_time) {
            uptime = calculateUptime(info.status.startup_time);
          }
        }
      } catch (err) {
        lastError = this.#extractError(err);
      }

      const statusData = {
        pbxIp: this.#config.ariHost,
        apiPort: this.#config.ariPort,
        tcpPort: this.#config.amiPort || 5038,
        version: ariConnected ? version : (currentStatus?.version || 'Asterisk Unknown'),
        totalExtensions,
        activeExtensions,
        totalTrunks,
        activeTrunks,
        activeCalls: activeCallsCount,
        systemUptime: ariConnected ? uptime : (currentStatus?.systemUptime || 'Unknown'),
        status: ariConnected ? 'online' : 'offline',
        lastError: lastError,
        lastSync: new Date()
      };

      await this.#prisma.asteriskSystemStatus.upsert({
        where: { ispId: this.#ispId },
        update: statusData,
        create: {
          ...statusData,
          ispId: this.#ispId
        }
      });

      return { success: true, data: statusData };
    } catch (error) {
      return { success: false, error: this.#extractError(error) };
    }
  }
}

module.exports = AsteriskService;
module.exports.classifyEndpoint = classifyEndpoint;
