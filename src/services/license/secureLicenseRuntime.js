const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const {
  MODULES,
  getEntitlementLimit,
  normalizeEntitlements,
  normalizeModules,
  toUiFeatures,
} = require('./licensePolicy');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL_EVENTS = new Set([
  'LICENSE_REVOKED',
  'LICENSE_SUSPENDED',
  'LICENSE_EXPIRED',
  'CLIENT_BANNED',
  'TENANT_SUSPENDED',
]);

const resolveConfiguredPath = (baseDir, value, fallback) => {
  const selected = String(value || fallback || '').trim();
  if (!selected) return '';
  if (path.isAbsolute(selected)) {
    if (fs.existsSync(selected)) return selected;
    if (fallback) {
      const fallbackPath = path.isAbsolute(fallback) ? fallback : path.resolve(baseDir, fallback);
      if (fs.existsSync(fallbackPath)) return fallbackPath;
    }
    return selected;
  }
  const resolved = path.resolve(baseDir, selected);
  if (fs.existsSync(resolved)) return resolved;
  if (fallback) {
    const fallbackPath = path.isAbsolute(fallback) ? fallback : path.resolve(baseDir, fallback);
    if (fs.existsSync(fallbackPath)) return fallbackPath;
  }
  return resolved;
};

const resolveLicenseEndpoint = (env) => {
  const configuredUrl = String(env.KTX_LICENSE_SERVER_URL || '').trim();
  let host = String(env.KTX_LICENSE_SERVER_HOST || '').trim();
  let port = Number(env.KTX_LICENSE_SERVER_PORT || 7443);
  if (configuredUrl) {
    try {
      const parsed = new URL(configuredUrl);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error('Only https:// or http:// URLs are supported');
      }
      host = parsed.hostname;
      if (!env.KTX_LICENSE_SERVER_PORT && parsed.port) port = Number(parsed.port);
    } catch (error) {
      return { host, port, error: `Invalid KTX_LICENSE_SERVER_URL: ${error.message}` };
    }
  }
  if (!host) {
    host = 'license.simulcast.com.np';
  }
  return { host, port, error: '' };
};

const publicError = (error) => {
  const message = error instanceof Error ? error.message : String(error || 'License validation failed');
  if (/connection closed during handshake/i.test(message)) {
    return 'License server rejected the configured mTLS client certificate. Verify production certificates.';
  }
  return message.replace(/eyJ[A-Za-z0-9._-]+/g, '[redacted-license-key]').slice(0, 500);
};

const getSupportedModules = () => [
  { code: 'OSS_BSS', name: 'Kashtrix OSS/BSS Core', description: 'Core operational and business support system' },
  { code: 'CUSTOMERS', name: 'Subscriber CRM', description: 'Customer & subscriber management' },
  { code: 'BILLING', name: 'Billing & Invoicing', description: 'Automated billing, online payments and invoicing' },
  { code: 'PACKAGES', name: 'Bandwidth & Service Plans', description: 'Bandwidth packages and FUP management' },
  { code: 'RADIUS', name: 'AAA RADIUS Engine', description: 'High-throughput RADIUS authentication and accounting' },
  { code: 'NETWORK', name: 'Network Infrastructure', description: 'OLT, PON, MikroTik, NAS and fiber mapping' },
  { code: 'TR069', name: 'TR-069 ACS Server', description: 'Auto-configuration server and CPE management' },
  { code: 'VOIP', name: 'VoIP Telephony', description: 'PBX, Yeastar and Asterisk telephony' },
  { code: 'AI_AGENTS', name: 'Autonomous AI Agents', description: 'AI copilot and automation workflows' },
  { code: 'TICKETS', name: 'Helpdesk & Workorders', description: 'Customer support ticketing and workorders' },
  { code: 'INVENTORY', name: 'Inventory & Assets', description: 'Warehouse, stock and asset tracking' },
  { code: 'MAX_SUBSCRIBERS', name: 'Subscriber capacity', description: 'Maximum active broadband subscribers', type: 'integer', min: 0, max: 10000000, step: 1, defaultValue: 1000, unit: 'subscribers' },
  { code: 'MAX_DEVICES', name: 'Network devices', description: 'Maximum managed network devices', type: 'integer', min: 0, max: 100000, step: 1, defaultValue: 10, unit: 'devices' },
];

class SecureLicenseRuntime extends EventEmitter {
  constructor({ baseDir, env = process.env } = {}) {
    super();
    this.baseDir = baseDir || path.resolve(__dirname, '../../..');
    this.env = env;
    this.client = null;
    this.provisioningClient = null;
    this.generation = 0;
    this.retryTimer = null;
    this.expiryTimer = null;
    this.connectPromise = null;
    this.hwid = '';
    this.clientId = '';
    this.snapshot = null;
    this.onlineValidated = false;
    this.lastEvent = '';
    this.state = 'unlicensed';
    this.reason = 'No secure license has been activated';
    this.supportedModules = getSupportedModules();

    this.storageDir = resolveConfiguredPath(
      this.baseDir,
      env.KTX_LICENSE_STORAGE_DIR,
      path.join(this.baseDir, 'data', 'secure-license')
    );
    this.keyPath = resolveConfiguredPath(
      this.baseDir,
      env.KTX_LICENSE_KEY_PATH,
      path.join(this.storageDir, 'license.jwt')
    );
    this.denialPath = path.join(this.storageDir, 'license.denied.json');

    const endpoint = resolveLicenseEndpoint(env);
    this.endpointError = endpoint.error;

    // Use environment tenant and app IDs if set, or fall back to dev UUIDs for local identity
    const rawTenantId = String(env.KTX_LICENSE_TENANT_ID || '').trim().toLowerCase();
    const rawAppId = String(env.KTX_LICENSE_APPLICATION_ID || '').trim().toLowerCase();

    const tenantId = UUID_RE.test(rawTenantId)
      ? rawTenantId
      : '00000000-0000-0000-0000-000000000001';

    const applicationId = UUID_RE.test(rawAppId)
      ? rawAppId
      : '00000000-0000-0000-0000-000000000002';

    this.config = {
      host: endpoint.host,
      port: endpoint.port,
      tenantId,
      applicationId,
      caPath: resolveConfiguredPath(
        this.baseDir,
        env.KTX_LICENSE_CA_PATH,
        path.join(this.baseDir, 'certs', 'production', 'ca-cert.pem')
      ),
      certPath: resolveConfiguredPath(
        this.baseDir,
        env.KTX_LICENSE_CLIENT_CERT_PATH,
        path.join(this.baseDir, 'certs', 'production', 'client-cert.pem')
      ),
      keyPath: resolveConfiguredPath(
        this.baseDir,
        env.KTX_LICENSE_CLIENT_KEY_PATH,
        path.join(this.baseDir, 'certs', 'production', 'client-key.pem')
      ),
      publicLicenseKeyPath: resolveConfiguredPath(
        this.baseDir,
        env.KTX_LICENSE_PUBLIC_KEY_PATH,
        path.join(this.baseDir, 'certs', 'production', 'license-ed25519-public.pem')
      ),
      servername: String(env.KTX_LICENSE_SERVERNAME || '').trim() || undefined,
      expectedIssuer: String(env.KTX_LICENSE_EXPECTED_ISSUER || 'secure-license-manager').trim(),
      expectedAudience: String(env.KTX_LICENSE_EXPECTED_AUDIENCE || 'licensed-app').trim(),
      validationTimeoutMs: Number(env.KTX_LICENSE_VALIDATION_TIMEOUT_MS || 75000),
    };
  }

  configurationError() {
    const missing = [];
    if (this.endpointError) missing.push(this.endpointError);
    if (!this.config.host) missing.push('KTX_LICENSE_SERVER_HOST');
    if (!UUID_RE.test(this.config.tenantId)) missing.push('KTX_LICENSE_TENANT_ID');
    if (!UUID_RE.test(this.config.applicationId)) missing.push('KTX_LICENSE_APPLICATION_ID');
    if (!this.config.caPath) missing.push('KTX_LICENSE_CA_PATH');
    if (!this.config.publicLicenseKeyPath) missing.push('KTX_LICENSE_PUBLIC_KEY_PATH');
    if (!!this.config.certPath !== !!this.config.keyPath) {
      missing.push('both KTX_LICENSE_CLIENT_CERT_PATH and KTX_LICENSE_CLIENT_KEY_PATH');
    }
    if (this.config.caPath && !fs.existsSync(this.config.caPath)) missing.push('existing KTX_LICENSE_CA_PATH file');
    if (this.config.certPath && !fs.existsSync(this.config.certPath)) missing.push('existing KTX_LICENSE_CLIENT_CERT_PATH file');
    if (this.config.keyPath && !fs.existsSync(this.config.keyPath)) missing.push('existing KTX_LICENSE_CLIENT_KEY_PATH file');
    if (this.config.publicLicenseKeyPath && !fs.existsSync(this.config.publicLicenseKeyPath)) {
      missing.push('existing KTX_LICENSE_PUBLIC_KEY_PATH file');
    }
    if (!Number.isInteger(this.config.port) || this.config.port < 1 || this.config.port > 65535) {
      missing.push('valid KTX_LICENSE_SERVER_PORT');
    }
    return missing.length ? `Secure license configuration required: ${missing.join(', ')}` : '';
  }

  async loadSdk() {
    if (!this.sdk) {
      try {
        this.sdk = await import('@license/node-sdk');
      } catch {
        try {
          this.sdk = await import(path.join(this.baseDir, 'lib/license-sdk/dist/index.js'));
        } catch {
          this.sdk = await import('../../lib/license-sdk/dist/index.js');
        }
      }
    }
    return this.sdk;
  }

  async getHardwareId(tenantIdOverride) {
    const tenantId = tenantIdOverride || this.config.tenantId || '00000000-0000-0000-0000-000000000001';
    if (!tenantIdOverride && this.hwid) {
      return this.hwid;
    }
    const { generateHwid } = await this.loadSdk();
    const computed = await generateHwid({
      tenantId,
      applicationId: this.config.applicationId || '00000000-0000-0000-0000-000000000002',
    });
    if (!tenantIdOverride) {
      this.hwid = computed;
    }
    return computed;
  }

  async getClientId() {
    if (!this.clientId) {
      const { loadOrCreateScopedClientId } = await this.loadSdk();
      this.clientId = await loadOrCreateScopedClientId(
        this.storageDir,
        this.config.tenantId || '00000000-0000-0000-0000-000000000001',
        this.config.applicationId || '00000000-0000-0000-0000-000000000002'
      );
    }
    return this.clientId;
  }

  getProvisioningId() {
    if (!this.hwid || !UUID_RE.test(this.clientId) || !UUID_RE.test(this.config.tenantId) || !UUID_RE.test(this.config.applicationId)) {
      return '';
    }
    const payload = JSON.stringify({
      v: 1,
      tenantId: this.config.tenantId,
      applicationId: this.config.applicationId,
      clientId: this.clientId,
      hwid: this.hwid,
      modules: this.supportedModules,
    });
    return `KTX1.${Buffer.from(payload, 'utf8').toString('base64url')}`;
  }

  getPublicStatus() {
    const modules = normalizeModules(this.snapshot?.modules || []);
    const entitlements = normalizeEntitlements(this.snapshot?.entitlements || {});
    const isActivated = this.state === 'activated';

    return {
      active: isActivated,
      status: this.state,
      reason: this.reason || undefined,
      message: isActivated ? 'License is active' : this.reason || 'License activation required',
      features: toUiFeatures(modules),
      modules,
      entitlements,
      provisioningId: this.getProvisioningId() || undefined,
      systemHwid: this.hwid || undefined,
      hardwareId: this.hwid || undefined,
      hwid: this.hwid || undefined,
      hardwareBound: isActivated,
      hardwareMatch: isActivated,
      maxSubscribers: getEntitlementLimit(entitlements, MODULES.MAX_SUBSCRIBERS),
      maxDevices: getEntitlementLimit(entitlements, MODULES.MAX_DEVICES),
      licenseId: this.snapshot?.licenseId,
      licenseSerial: this.snapshot?.licenseSerial,
      clientId: this.snapshot?.clientId || this.clientId || undefined,
      company: this.snapshot?.customerName,
      customerName: this.snapshot?.customerName,
      contact: this.snapshot?.customerEmail,
      customerEmail: this.snapshot?.customerEmail,
      validFrom: this.snapshot?.validFrom instanceof Date
        ? this.snapshot.validFrom.toISOString()
        : this.snapshot?.validFrom,
      expiresAt: this.snapshot?.expiresAt instanceof Date
        ? this.snapshot.expiresAt.toISOString()
        : this.snapshot?.expiresAt,
      maxActivations: this.snapshot?.maxActivations,
      clientAppVersion: this.snapshot?.appVersion,
      clientPlatform: this.snapshot?.platform,
      tenantId: this.snapshot?.tenantId || this.config.tenantId || undefined,
      applicationId: this.snapshot?.applicationId || this.config.applicationId || undefined,
      entitlementVersion: this.snapshot?.entitlementVersion,
      validatedAt: this.snapshot?.validatedAt instanceof Date
        ? this.snapshot.validatedAt.toISOString()
        : this.snapshot?.validatedAt,
      lastEvent: this.lastEvent || undefined,
      configured: !this.configurationError(),
      remoteActivationReady: Boolean(this.provisioningClient),
      validationMode: isActivated && this.onlineValidated ? 'online' : isActivated ? 'offline' : undefined,
    };
  }

  publish() {
    this.emit('change', this.getPublicStatus());
  }

  setDenied(reason, event = '') {
    if (event === 'LICENSE_EXPIRED') this.state = 'expired';
    else if (event === 'LICENSE_SUSPENDED' || event === 'TENANT_SUSPENDED') this.state = 'suspended';
    else if (event === 'LICENSE_REVOKED') this.state = 'revoked';
    else if (event === 'CLIENT_BANNED') this.state = 'client_banned';
    else this.state = 'unlicensed';
    this.reason = reason || event || 'Secure online validation failed';
    this.lastEvent = event;
    this.snapshot = null;
    this.onlineValidated = false;
    clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.publish();
  }

  hasUsableSnapshot() {
    if (this.state !== 'activated' || !this.snapshot) return false;
    const expiresAt = this.snapshot.expiresAt ? new Date(this.snapshot.expiresAt).getTime() : Infinity;
    return Number.isFinite(expiresAt) ? expiresAt > Date.now() : true;
  }

  scheduleExpiry() {
    clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (!this.snapshot?.expiresAt) return;
    const remaining = new Date(this.snapshot.expiresAt).getTime() - Date.now();
    if (remaining <= 0) {
      this.setDenied('License has expired', 'LICENSE_EXPIRED');
      return;
    }
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      const expiresAt = this.snapshot?.expiresAt ? new Date(this.snapshot.expiresAt).getTime() : Infinity;
      if (expiresAt <= Date.now()) this.setDenied('License has expired', 'LICENSE_EXPIRED');
      else this.scheduleExpiry();
    }, Math.min(remaining, 2_147_000_000));
    this.expiryTimer.unref?.();
  }

  applySnapshot(snapshot, { offline = false } = {}) {
    this.snapshot = {
      ...snapshot,
      modules: normalizeModules(snapshot.modules),
      entitlements: normalizeEntitlements(snapshot.entitlements),
    };
    this.state = 'activated';
    this.onlineValidated = !offline;
    this.reason = offline ? 'License server is offline; locally verified license remains active until expiry' : '';
    this.scheduleExpiry();
    this.publish();
  }

  async verifyOfflineLicense(licenseKey) {
    const [{ importSPKI, jwtVerify }, publicPem] = await Promise.all([
      import('jose'),
      fs.promises.readFile(this.config.publicLicenseKeyPath, 'utf8'),
    ]);
    const publicKey = await importSPKI(publicPem, 'EdDSA');
    const { payload } = await jwtVerify(licenseKey, publicKey, {
      algorithms: ['EdDSA'],
      issuer: this.config.expectedIssuer,
      audience: this.config.expectedAudience,
      typ: 'JWT',
    });
    if (
      payload.typ !== 'license' ||
      typeof payload.jti !== 'string' ||
      typeof payload.lic !== 'string' ||
      payload.ten !== this.config.tenantId ||
      payload.app !== this.config.applicationId ||
      !Array.isArray(payload.mod) ||
      payload.mod.some((value) => typeof value !== 'string') ||
      !payload.ent ||
      typeof payload.ent !== 'object' ||
      Array.isArray(payload.ent) ||
      Object.values(payload.ent).some(
        (value) => typeof value !== 'boolean' && !(Number.isInteger(value) && value >= 0)
      ) ||
      !Number.isInteger(payload.ev)
    ) {
      throw new Error('Invalid offline license claims');
    }
    const validFrom = new Date(Number(payload.nbf || payload.iat || 0) * 1000);
    const expiresAt = payload.exp ? new Date(Number(payload.exp) * 1000) : undefined;
    if (Number.isNaN(validFrom.getTime()) || (expiresAt && Number.isNaN(expiresAt.getTime()))) {
      throw new Error('Invalid offline license validity period');
    }
    return {
      tenantId: this.config.tenantId,
      applicationId: this.config.applicationId,
      clientId: this.clientId,
      licenseId: payload.jti,
      licenseSerial: payload.lic,
      validFrom,
      expiresAt,
      maxActivations: 1,
      appVersion: process.env.npm_package_version || '1.0.0',
      platform: `${process.platform}-${process.arch}`,
      modules: payload.mod,
      entitlements: payload.ent,
      entitlementVersion: Number(payload.ev),
      validatedAt: new Date(),
    };
  }

  keyFingerprint(licenseKey) {
    return createHash('sha256').update(String(licenseKey || ''), 'utf8').digest('hex');
  }

  async readTerminalDenial(licenseKey) {
    try {
      const stored = JSON.parse(await fs.promises.readFile(this.denialPath, 'utf8'));
      return stored?.keyFingerprint === this.keyFingerprint(licenseKey) ? stored : null;
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      return null;
    }
  }

  async persistTerminalDenial(licenseKey, event, reason) {
    if (!licenseKey) return;
    await fs.promises.mkdir(this.storageDir, { recursive: true, mode: 0o700 });
    const record = JSON.stringify({
      keyFingerprint: this.keyFingerprint(licenseKey),
      event,
      reason,
      receivedAt: new Date().toISOString(),
    });
    const tempPath = `${this.denialPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(tempPath, record, { encoding: 'utf8', mode: 0o600 });
    await fs.promises.rename(tempPath, this.denialPath);
    await fs.promises.chmod(this.denialPath, 0o600).catch(() => {});
  }

  async clearTerminalDenial() {
    await fs.promises.unlink(this.denialPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }

  terminalEventForError(error) {
    if (error?.code === 'ERR_JWT_EXPIRED') return 'LICENSE_EXPIRED';
    const lower = publicError(error).toLowerCase();
    if (lower.includes('expired')) return 'LICENSE_EXPIRED';
    if (lower.includes('tenant') && lower.includes('suspend')) return 'TENANT_SUSPENDED';
    if (lower.includes('suspend')) return 'LICENSE_SUSPENDED';
    if (lower.includes('revok')) return 'LICENSE_REVOKED';
    if (lower.includes('ban')) return 'CLIENT_BANNED';
    if (lower.includes('hwid') || lower.includes('hardware')) return 'HARDWARE_MISMATCH';
    if (
      lower.includes('superseded') ||
      lower.includes('invalid offline license') ||
      lower.includes('signature')
    ) {
      return 'LICENSE_KEY_REISSUED';
    }
    return '';
  }

  handleConnectionLost(error) {
    if (this.hasUsableSnapshot()) {
      this.client = null;
      this.onlineValidated = false;
      this.reason = 'License server unavailable; locally verified license remains active until expiry';
      this.publish();
    } else {
      this.setDenied(publicError(error));
    }
    this.scheduleRetry();
  }

  async createClient(licenseKey, generation) {
    const configError = this.configurationError();
    if (configError) throw new Error(configError);
    const { LicenseSystem } = await this.loadSdk();
    const [clientId] = await Promise.all([this.getClientId(), this.getHardwareId()]);
    return new LicenseSystem({
      ...this.config,
      clientId,
      licenseKey,
      hwid: this.hwid,
      appVersion: process.env.npm_package_version || '1.0.0',
      platform: `${process.platform}-${process.arch}`,
      certPath: this.config.certPath || undefined,
      keyPath: this.config.keyPath || undefined,
      onEntitlementsChanged: (snapshot) => {
        if (generation === this.generation) this.applySnapshot(snapshot);
      },
      onLicenseReady: (licenseKey) => this.acceptRemoteLicense(licenseKey, generation),
      onStateChange: (event, reason) => {
        if (generation !== this.generation) return;
        this.lastEvent = event;
        if (TERMINAL_EVENTS.has(event)) {
          this.setDenied(reason || event, event);
          void this.persistTerminalDenial(licenseKey, event, reason || event).catch(() => {});
          this.scheduleRetry(1000);
        } else if (event === 'LICENSE_RESTORED') {
          void this.clearTerminalDenial().catch(() => {});
          this.reason = '';
          if (this.snapshot) {
            this.state = 'activated';
            this.onlineValidated = true;
          }
          this.publish();
          void this.connectKey(licenseKey, { preserveActive: true }).catch(() => {});
        } else {
          this.reason =
            event === 'LICENSE_KEY_REISSUED'
              ? 'A replacement license key is required before the next reconnect'
              : '';
          this.publish();
        }
      },
      onConnectionLost: (error) => {
        if (generation !== this.generation) return;
        this.handleConnectionLost(error);
      },
    });
  }

  async connectKey(licenseKey, { persist = false, preserveActive = false } = {}) {
    const trimmed = String(licenseKey || '').trim();
    if (trimmed.length < 50) throw new Error('A valid secure license JWT is required');
    if (this.connectPromise) throw new Error('License validation is already in progress');
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const generation = ++this.generation;
    const previous = this.client;
    this.client = null;
    previous?.close();
    this.provisioningClient?.close();
    this.provisioningClient = null;

    if (!preserveActive || !this.hasUsableSnapshot()) {
      this.state = 'connecting';
      this.reason = 'Validating with the secure license server';
      this.snapshot = null;
    } else {
      this.reason = 'Checking for license updates in the background';
    }
    this.publish();

    this.connectPromise = (async () => {
      // First try online connection
      let snapshot = null;
      let onlineError = null;
      try {
        const client = await this.createClient(trimmed, generation);
        this.client = client;
        snapshot = await client.connect();
      } catch (err) {
        onlineError = err;
      }

      if (generation !== this.generation) {
        this.client?.close();
        throw new Error('License validation was superseded');
      }

      if (snapshot) {
        this.applySnapshot(snapshot);
        if (persist) await this.persistKey(trimmed);
        await this.clearTerminalDenial();
        return this.getPublicStatus();
      }

      // If online connection failed, fallback to offline verification if key is valid
      try {
        const offlineSnapshot = await this.verifyOfflineLicense(trimmed);
        this.applySnapshot(offlineSnapshot, { offline: true });
        if (persist) await this.persistKey(trimmed);
        await this.clearTerminalDenial();
        this.scheduleRetry();
        return this.getPublicStatus();
      } catch (offlineErr) {
        throw onlineError || offlineErr;
      }
    })();

    try {
      return await this.connectPromise;
    } catch (error) {
      if (generation === this.generation) {
        this.client?.close();
        this.client = null;
        const reason = publicError(error);
        const event = this.terminalEventForError(error);
        if (event === 'HARDWARE_MISMATCH') {
          this.state = 'hardware_mismatch';
          this.reason = reason;
          this.lastEvent = '';
          this.snapshot = null;
          this.publish();
          await this.persistTerminalDenial(trimmed, event, reason).catch(() => {});
        } else if (event) {
          this.setDenied(reason, event);
          await this.persistTerminalDenial(trimmed, event, reason).catch(() => {});
        } else if (preserveActive && this.hasUsableSnapshot()) {
          this.reason = 'License server unavailable; locally verified license remains active until expiry';
          this.publish();
          this.scheduleRetry();
        } else {
          this.setDenied(reason);
        }
      }
      throw error;
    } finally {
      this.connectPromise = null;
    }
  }

  async persistKey(licenseKey) {
    await fs.promises.mkdir(path.dirname(this.keyPath), { recursive: true, mode: 0o700 });
    const tempPath = `${this.keyPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(tempPath, licenseKey, { encoding: 'utf8', mode: 0o600 });
    await fs.promises.rename(tempPath, this.keyPath);
    await fs.promises.chmod(this.keyPath, 0o600).catch(() => {});
  }

  async activate(licenseKey) {
    return this.connectKey(licenseKey, { persist: true });
  }

  acceptRemoteLicense(licenseKey, generation) {
    if (generation !== this.generation) return;
    this.provisioningClient = null;
    void this.connectKey(licenseKey, { persist: true }).catch((error) => {
      this.setDenied(publicError(error));
      this.scheduleRetry();
    });
  }

  async startProvisioning() {
    if (this.provisioningClient || this.connectPromise) return this.getPublicStatus();
    const configError = this.configurationError();
    if (configError) {
      this.setDenied(configError);
      return this.getPublicStatus();
    }
    const [{ LicenseProvisioningClient }, clientId] = await Promise.all([
      this.loadSdk(),
      this.getClientId(),
    ]);
    await this.getHardwareId();
    const provisioningId = this.getProvisioningId();
    if (!provisioningId) throw new Error('Client provisioning identity is unavailable');

    const generation = ++this.generation;
    const provisioningClient = new LicenseProvisioningClient({
      ...this.config,
      clientId,
      hwid: this.hwid,
      provisioningId,
      certPath: this.config.certPath || undefined,
      keyPath: this.config.keyPath || undefined,
      onLicenseReady: (licenseKey) => this.acceptRemoteLicense(licenseKey, generation),
      onConnectionLost: (error) => {
        if (generation !== this.generation) return;
        this.provisioningClient = null;
        this.reason = `Remote activation connection lost: ${publicError(error)}`;
        this.publish();
        this.scheduleRetry();
      },
    });

    this.provisioningClient = provisioningClient;
    this.state = 'unlicensed';
    this.reason = 'Waiting for secure remote activation from License Manager';
    this.publish();

    try {
      await provisioningClient.connect();
      return this.getPublicStatus();
    } catch (error) {
      if (generation === this.generation) {
        this.provisioningClient = null;
        this.reason = `Remote activation unavailable: ${publicError(error)}`;
        this.publish();
        this.scheduleRetry();
      }
      return this.getPublicStatus();
    }
  }

  async start() {
    try {
      await Promise.all([this.getHardwareId(), this.getClientId()]);
    } catch (error) {
      this.setDenied(publicError(error));
      return this.getPublicStatus();
    }

    let licenseKey = '';
    try {
      licenseKey = (await fs.promises.readFile(this.keyPath, 'utf8')).trim();
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.setDenied(`Unable to read secure license storage: ${publicError(error)}`);
      }
    }

    if (!licenseKey) {
      return this.startProvisioning();
    }

    const denial = await this.readTerminalDenial(licenseKey).catch((error) => {
      this.setDenied(`Unable to read license revocation state: ${publicError(error)}`);
      return null;
    });

    if (denial) {
      this.setDenied(denial.reason || denial.event, denial.event);
      void this.connectKey(licenseKey)
        .then(() => this.clearTerminalDenial())
        .catch(() => this.scheduleRetry());
      return this.getPublicStatus();
    }

    try {
      const snapshot = await this.verifyOfflineLicense(licenseKey);
      this.applySnapshot(snapshot, { offline: true });
    } catch (error) {
      this.setDenied(publicError(error), this.terminalEventForError(error));
      return this.getPublicStatus();
    }

    void this.connectKey(licenseKey, { preserveActive: true }).catch(() => {});
    return this.getPublicStatus();
  }

  scheduleRetry(delayMs = 30000) {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.start();
    }, delayMs);
    this.retryTimer.unref?.();
  }

  async deactivate() {
    ++this.generation;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.client?.close();
    this.client = null;
    this.provisioningClient?.close();
    this.provisioningClient = null;
    this.snapshot = null;
    this.onlineValidated = false;

    await fs.promises.unlink(this.keyPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
    await this.clearTerminalDenial();

    this.state = 'unlicensed';
    this.reason = 'No secure license has been activated';
    this.lastEvent = '';
    this.publish();

    void this.startProvisioning();
    return this.getPublicStatus();
  }

  close() {
    ++this.generation;
    clearTimeout(this.retryTimer);
    clearTimeout(this.expiryTimer);
    this.retryTimer = null;
    this.expiryTimer = null;
    this.client?.close();
    this.client = null;
    this.provisioningClient?.close();
    this.provisioningClient = null;
  }
}

module.exports = { SecureLicenseRuntime, getSupportedModules };
