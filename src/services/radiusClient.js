const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
const { SERVICE_CODES } = require('../lib/serviceConstants');
const { formatRadiusExpiration } = require('../utils/radiusExpiration');
const { normalizeExternalPayload, toCanonicalAdValue } = require('../utils/externalDatePayload');
const prisma = new PrismaClient();

class RadiusClient {
  #config;
  #token = null;
  #tokenExpiry = null;
  #api;

  constructor(config) {
    this.#config = config;
    this.#api = axios.create({
      baseURL: config.baseUrl,
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    });
  }

  /**
   * Factory method to create RadiusClient using service code
   */
  static async create(ispId) {
    if (!ispId) {
      throw new Error('ISP ID is required to create a Radius client.');
    }

    const radiusService = await prisma.iSPService.findFirst({
      where: {
        ispId: ispId,
        service: { code: SERVICE_CODES.RADIUS },
        isActive: true,
        isEnabled: true,
        isDeleted: false
      },
      include: {
        service: true,
        credentials: {
          where: { isActive: true, isDeleted: false },
          orderBy: { createdAt: 'desc' }
        }
      }
    });

    if (!radiusService) {
      throw new Error(`FreeRadius service is not configured or enabled for ISP ID: ${ispId}`);
    }

    // Map credentials to key-value object
    const credentials = {};
    radiusService.credentials.forEach(cred => {
      credentials[cred.key] = cred.value;
    });

    const username = credentials.username;
    const password = credentials.password;
    const baseUrl = radiusService.baseUrl;

    if (!username || !password) {
      throw new Error(`Missing credentials for Radius service. Required: username, password`);
    }

    if (!baseUrl) {
      throw new Error('Base URL is required for Radius service');
    }

    console.log(`[RADIUS] Creating client for baseUrl: ${baseUrl}, username: ${username}`);

    return new RadiusClient({
      ispId: Number(ispId),
      baseUrl: baseUrl,
      username: username,
      password: password,
      apiVersion: radiusService.apiVersion || 'v1',
      config: radiusService.config || {}
    });
  }

  // Helper method to get service status
  static async getServiceStatus(ispId) {
    try {
      const service = await prisma.iSPService.findFirst({
        where: {
          ispId: ispId,
          service: { code: SERVICE_CODES.RADIUS },
          isDeleted: false
        },
        include: {
          service: true,
          credentials: {
            where: { isActive: true, isDeleted: false }
          }
        }
      });

      if (!service) {
        return {
          enabled: false,
          configured: false,
          message: 'Service not configured'
        };
      }

      const hasCredentials = service.credentials.length > 0;
      const hasValidCredentials = service.credentials.some(c =>
        c.key === 'username' && c.value
      ) && service.credentials.some(c =>
        c.key === 'password' && c.value
      );

      // Try to connect to test if service is actually working
      let connectionTest = false;
      let connectionError = null;
      let connectionDetails = null;

      if (hasValidCredentials && service.baseUrl) {
        try {
          const client = await RadiusClient.create(ispId);
          const testResult = await client.testConnection();
          connectionTest = testResult.connected;
          connectionError = testResult.message;
          connectionDetails = testResult.data;
        } catch (error) {
          connectionTest = false;
          connectionError = error.message;
        }
      }

      return {
        enabled: service.isActive && service.isEnabled,
        configured: !!service.baseUrl && hasValidCredentials,
        isActive: service.isActive,
        isEnabled: service.isEnabled,
        baseUrl: service.baseUrl,
        hasCredentials,
        hasValidCredentials,
        connectionTest,
        connectionError,
        connectionDetails,
        serviceName: service.service.name,
        lastUpdated: service.updatedAt
      };
    } catch (error) {
      console.error('Error getting Radius service status:', error);
      return {
        enabled: false,
        configured: false,
        error: error.message
      };
    }
  }
















  // --- Authentication Methods ---
  async #login() {
    try {
      console.log(`[RADIUS] Logging in to ${this.#config.baseUrl}/login`);

      const response = await this.#api.post('/login', {
        username: this.#config.username,
        password: this.#config.password
      });

      if (response.data && response.data.token) {
        this.#token = response.data.token;
        // Token expires in 1 hour (3600 seconds)
        this.#tokenExpiry = Date.now() + 3600000;
        console.log('[RADIUS] Login successful, token received');
        return this.#token;
      } else {
        throw new Error('No token received in login response');
      }
    } catch (error) {
      console.error('[RADIUS] Login error:', {
        status: error.response?.status,
        data: error.response?.data,
        message: error.message
      });
      throw new Error(`Login failed: ${error.response?.data?.message || error.message}`);
    }
  }

  async #getToken() {
    const now = Date.now();
    const bufferMs = 5 * 60 * 1000; // 5 minutes buffer

    if (!this.#token || !this.#tokenExpiry || now >= (this.#tokenExpiry - bufferMs)) {
      await this.#login();
    }
    return this.#token;
  }

  async #apiRequest(method, endpoint, data = undefined, retry = true) {
    try {
      const token = await this.#getToken();
      const externalData = data === undefined ? undefined : normalizeExternalPayload(data);

      const config = {
        method: method.toLowerCase(),
        url: endpoint.startsWith('/') ? endpoint : `/${endpoint}`,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        timeout: 10000
      };

      if (['get', 'delete'].includes(method.toLowerCase())) {
        config.params = { ...(externalData || {}), ispId: this.#config.ispId };
      }

      if (['post', 'put', 'patch'].includes(method.toLowerCase())) {
        config.data = { ...(externalData || {}), ispId: this.#config.ispId };
      }

      const response = await this.#api.request(config);
      const tableMatch = config.url.match(/^\/api\/(radcheck|radreply|radusergroup|radgroupreply|radgroupcheck|radacct|radpostauth|nasreload|nas)(?:\/|\?|$)/i);
      if (method.toLowerCase() === 'get' && tableMatch) {
        const payload = response.data;
        if (Array.isArray(payload)) return payload.filter((row) => this.#rowBelongsToIsp(row));
        if (payload && Array.isArray(payload.rows)) return { ...payload, rows: payload.rows.filter((row) => this.#rowBelongsToIsp(row)) };
        if (payload && Array.isArray(payload.data)) return { ...payload, data: payload.data.filter((row) => this.#rowBelongsToIsp(row)) };
        if (payload && typeof payload === 'object' && !this.#rowBelongsToIsp(payload)) {
          const tenantError = new Error('Radius record was not found for the authenticated ISP');
          tenantError.statusCode = 404;
          throw tenantError;
        }
      }
      return response.data;

    } catch (error) {
      if (error.statusCode) throw error;
      console.error(`[RADIUS API ERROR] ${method} ${endpoint}:`, {
        status: error.response?.status,
        data: error.response?.data,
        message: error.message
      });

      if (error.response?.status === 401 && retry) {
        console.log('[RADIUS] Token expired, re-authenticating...');
        this.#token = null;
        this.#tokenExpiry = null;
        return this.#apiRequest(method, endpoint, data, false);
      }

      const err = new Error(error.response?.data?.message || error.message);
      err.responseData = error.response?.data || null;
      err.responseStatus = error.response?.status || null;
      throw err;
    }
  }

  // Test connection
  async testConnection() {
    try {
      // Try to login first
      const token = await this.#login();

      // Then try to get radcheck to verify API works
      const radcheck = await this.#apiRequest('get', '/api/radcheck');

      return {
        connected: true,
        message: 'Successfully connected to FreeRadius API',
        data: {
          token: token ? '***ENCRYPTED***' : null,
          apiVersion: this.#config.apiVersion,
          baseUrl: this.#config.baseUrl,
          radcheckCount: Array.isArray(radcheck) ? radcheck.length : 'N/A',
          endpoints: {
            radcheck: true,
            radreply: true,
            radusergroup: true,
            radacct: true
          }
        },
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('[RADIUS] Test connection error:', error.message);
      return {
        connected: false,
        message: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  // ---------------- RADGROUPREPLY API METHODS ----------------

  // Get all radgroupreply
  async getRadgroupreply() {
    return this.#apiRequest('get', '/api/radgroupreply');
  }

  // Get radgroupreply by groupname
  async getRadgroupreplyByGroupname(groupname) {
    try {
      const all = await this.getRadgroupreply();
      if (Array.isArray(all)) {
        return all.filter(entry => entry.groupname === groupname);
      }
      return [];
    } catch (error) {
      throw new Error(`Failed to get radgroupreply for group ${groupname}: ${error.message}`);
    }
  }

  // Get radgroupreply by ID
  async getRadgroupreplyById(id) {
    return this.#apiRequest('get', `/api/radgroupreply/${id}`);
  }

  // Create radgroupreply
  async createRadgroupreply(data) {
    const requiredFields = ['groupname', 'attribute', 'op', 'value'];
    const missingFields = requiredFields.filter(field => !data[field]);
    if (missingFields.length > 0) {
      throw new Error(`Missing required fields: ${missingFields.join(', ')}`);
    }
    return this.#apiRequest('post', '/api/radgroupreply', data);
  }

  // Update radgroupreply
  async updateRadgroupreply(id, data) {
    return this.#apiRequest('put', `/api/radgroupreply/${id}`, data);
  }

  // Delete radgroupreply
  async deleteRadgroupreply(id) {
    return this.#apiRequest('delete', `/api/radgroupreply/${id}`);
  }

  // ---------------- RADGROUPCHECK API METHODS ----------------

  // Get all radgroupcheck
  async getRadgroupcheck() {
    return this.#apiRequest('get', '/api/radgroupcheck');
  }

  // Get radgroupcheck by ID
  async getRadgroupcheckById(id) {
    return this.#apiRequest('get', `/api/radgroupcheck/${id}`);
  }

  // Create radgroupcheck
  async createRadgroupcheck(data) {
    const requiredFields = ['groupname', 'attribute', 'op', 'value'];
    const missingFields = requiredFields.filter(field => !data[field]);
    if (missingFields.length > 0) {
      throw new Error(`Missing required fields: ${missingFields.join(', ')}`);
    }
    return this.#apiRequest('post', '/api/radgroupcheck', data);
  }

  // Update radgroupcheck
  async updateRadgroupcheck(id, data) {
    return this.#apiRequest('put', `/api/radgroupcheck/${id}`, data);
  }

  // Delete radgroupcheck
  async deleteRadgroupcheck(id) {
    return this.#apiRequest('delete', `/api/radgroupcheck/${id}`);
  }

  // --- Public API Methods ---

  // NAS

  // ---------------- NAS API METHODS ----------------

  // Get all NAS
  async getNas() {
    try {
      return await this.#apiRequest('get', '/api/nas');
    } catch (error) {
      console.error('Error getting NAS list:', error);
      throw new Error(`Failed to get NAS list: ${error.message}`);
    }
  }


  // Get NAS by ID
  async getNasById(id) {
    try {
      return await this.#apiRequest('get', `/api/nas/${id}`);
    } catch (error) {
      console.error(`Error getting NAS ${id}:`, error);
      throw new Error(`Failed to get NAS ${id}: ${error.message}`);
    }
  }


  // Create NAS
  async createNas(data) {
    const requiredFields = ['nasname', 'shortname', 'type', 'ports', 'secret'];

    const missingFields = requiredFields.filter(field => !data[field]);

    if (missingFields.length > 0) {
      throw new Error(`Missing required fields: ${missingFields.join(', ')}`);
    }

    try {
      return await this.#apiRequest('post', '/api/nas', data);
    } catch (error) {
      console.error('Error creating NAS:', error);
      throw new Error(`Failed to create NAS: ${error.message}`);
    }
  }


  // Update NAS
  async updateNas(id, data) {
    try {
      return await this.#apiRequest('put', `/api/nas/${id}`, data);
    } catch (error) {
      console.error(`Error updating NAS ${id}:`, error);
      throw new Error(`Failed to update NAS ${id}: ${error.message}`);
    }
  }


  // Delete NAS
  async deleteNas(id) {
    console.log('Id', id);
    try {
      const response = await this.#apiRequest('delete', `/api/nas/${id}`);
      console.log('Response', response);
      return response;
    } catch (error) {
      console.error(`Error deleting NAS ${id}:`, error);
      throw new Error(`Failed to delete NAS ${id}: ${error.message}`);
    }
  }



  // Get all radcheck entries
  async getRadcheck() {
    return this.#apiRequest('get', '/api/radcheck');
  }

  // Get radcheck by ID
  async getRadcheckById(id) {
    return this.#apiRequest('get', `/api/radcheck/${id}`);
  }

  // Get radcheck by username
  async getRadcheckByUsername(username) {
    try {
      const allRadcheck = await this.getRadcheck();
      if (Array.isArray(allRadcheck)) {
        return allRadcheck.filter(entry => entry.username === username);
      }
      return [];
    } catch (error) {
      throw new Error(`Failed to get radcheck for username ${username}: ${error.message}`);
    }
  }

  // Create radcheck entry
  async createRadcheck(data) {
    const requiredFields = ['username', 'attribute', 'op', 'value'];
    const missingFields = requiredFields.filter(field => !data[field]);

    if (missingFields.length > 0) {
      throw new Error(`Missing required fields: ${missingFields.join(', ')}`);
    }

    return this.#apiRequest('post', '/api/radcheck', data);
  }

  // Update radcheck entry
  async updateRadcheck(id, data) {
    return this.#apiRequest('put', `/api/radcheck/${id}`, data);
  }

  // Delete radcheck entry
  async deleteRadcheck(id) {
    return this.#apiRequest('delete', `/api/radcheck/${id}`);
  }

  // Get all radreply entries
  async getRadreply() {
    return this.#apiRequest('get', '/api/radreply');
  }

  // Get radreply by ID
  async getRadreplyById(id) {
    return this.#apiRequest('get', `/api/radreply/${id}`);
  }

  // Create radreply entry
  async createRadreply(data) {
    const requiredFields = ['username', 'attribute', 'op', 'value'];
    const missingFields = requiredFields.filter(field => !data[field]);

    if (missingFields.length > 0) {
      throw new Error(`Missing required fields: ${missingFields.join(', ')}`);
    }

    return this.#apiRequest('post', '/api/radreply', data);
  }

  // Update radreply entry
  async updateRadreply(id, data) {
    return this.#apiRequest('put', `/api/radreply/${id}`, data);
  }

  // Delete radreply entry
  async deleteRadreply(id) {
    return this.#apiRequest('delete', `/api/radreply/${id}`);
  }

  // Get all radusergroup entries
  async getRadusergroup() {
    return this.#apiRequest('get', '/api/radusergroup');
  }

  // Get radusergroup by ID
  async getRadusergroupById(id) {
    return this.#apiRequest('get', `/api/radusergroup/${id}`);
  }

  // Get radusergroup by username
  async getRadusergroupByUsername(username) {
    try {
      const allGroups = await this.getRadusergroup();
      if (Array.isArray(allGroups)) {
        return allGroups.filter(entry => entry.username === username);
      }
      return [];
    } catch (error) {
      throw new Error(`Failed to get radusergroup for username ${username}: ${error.message}`);
    }
  }

  // Create radusergroup entry
  async createRadusergroup(data) {
    const requiredFields = ['username', 'groupname'];
    const missingFields = requiredFields.filter(field => !data[field]);

    if (missingFields.length > 0) {
      throw new Error(`Missing required fields: ${missingFields.join(', ')}`);
    }

    return this.#apiRequest('post', '/api/radusergroup', data);
  }

  // Update radusergroup entry
  async updateRadusergroup(id, data) {
    return this.#apiRequest('put', `/api/radusergroup/${id}`, data);
  }

  // Delete radusergroup entry
  async deleteRadusergroup(id) {
    return this.#apiRequest('delete', `/api/radusergroup/${id}`);
  }

  // Get all radacct entries
  async getRadacct() {
    return this.#apiRequest('get', '/api/radacct');
  }

  async getRadacctlimit(limit) {
    return this.#apiRequest('get', `/api/radacct?limit=${limit}`);
  }

  async getNasreload(limit = 500) {
    return this.#apiRequest('get', `/api/nasreload?limit=${limit}`);
  }

  async getTable(table, limit = 500, offset = 0) {
    const allowedTables = {
      radcheck: () => this.getRadcheck(),
      radreply: () => this.getRadreply(),
      radusergroup: () => this.getRadusergroup(),
      radgroupreply: () => this.getRadgroupreply(),
      radgroupcheck: () => this.getRadgroupcheck(),
      radacct: () => this.getRadacctlimit(limit),
      radpostauth: () => this.getRadpostauthlimit(limit),
      nas: () => this.getNas(),
      nasreload: () => this.getNasreload(limit)
    };

    const loader = allowedTables[String(table || '').toLowerCase()];
    if (!loader) {
      throw new Error('Unsupported Radius table');
    }

    const rows = await loader();
    const rawList = Array.isArray(rows) ? rows : [];
    const list = rawList.filter((row) => this.#rowBelongsToIsp(row));
    const start = Math.max(Number(offset) || 0, 0);
    const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 2000);

    return {
      table,
      ispId: this.#config.ispId,
      rows: list.slice(start, start + safeLimit),
      total: list.length,
      limit: safeLimit,
      offset: start,
      hasMore: start + safeLimit < list.length
    };
  }

  #rowBelongsToIsp(row) {
    if (!row || typeof row !== 'object') return false;
    const tenantValue = row.ispId ?? row.ispid ?? row.isp_id ?? row.ISP_ID;
    return tenantValue !== undefined && Number(tenantValue) === Number(this.#config.ispId);
  }

  #editableTable(table) {
    const normalized = String(table || '').toLowerCase();
    const editable = new Set(['radcheck', 'radreply', 'radusergroup', 'radgroupreply', 'radgroupcheck', 'nas']);
    if (!editable.has(normalized)) {
      throw new Error('This Radius table is read-only or unsupported');
    }
    return normalized;
  }

  async createTableRow(table, data) {
    const normalized = this.#editableTable(table);
    return this.#apiRequest('post', `/api/${normalized}`, { ...(data || {}), ispId: this.#config.ispId });
  }

  async updateTableRow(table, id, data) {
    const normalized = this.#editableTable(table);
    await this.#assertTableRowOwned(normalized, id);
    return this.#apiRequest('put', `/api/${normalized}/${encodeURIComponent(id)}`, { ...(data || {}), ispId: this.#config.ispId });
  }

  async deleteTableRow(table, id) {
    const normalized = this.#editableTable(table);
    await this.#assertTableRowOwned(normalized, id);
    return this.#apiRequest('delete', `/api/${normalized}/${encodeURIComponent(id)}`);
  }

  async #assertTableRowOwned(table, id) {
    const result = await this.getTable(table, 2000, 0);
    const owned = result.rows.some((row) => String(row.id ?? row.ID) === String(id));
    if (!owned) {
      const error = new Error('Radius record was not found for the authenticated ISP');
      error.statusCode = 404;
      throw error;
    }
  }

  // Get radacct by ID
  async getRadacctById(id) {
    return this.#apiRequest('get', `/api/radacct/${id}`);
  }

  // Get radacct by username
  async getRadacctByUsername(username, limit = 10000) {
    try {
      const allAcct = await this.getRadacctlimit(limit);
      console.log('total', allAcct.length);
      if (Array.isArray(allAcct)) {
        return allAcct
          .filter(entry => entry.username === username)
          .slice(0, limit);
      }
      return [];
    } catch (error) {
      throw new Error(`Failed to get radacct for username ${username}: ${error.message}`);
    }
  }

  // Get all radpostauth entries
  async getRadpostauth() {
    return this.#apiRequest('get', '/api/radpostauth');
  }

  async getRadpostauthlimit(limit) {
    return this.#apiRequest('get', `/api/radpostauth?limit=${limit}`);
  }

  // Get radpostauth by username
  async getRadpostauthByUsername(username, limit = 10000) {
    try {
      const allPostAuth = await this.getRadpostauthlimit(limit);
      if (Array.isArray(allPostAuth)) {
        return allPostAuth
          .filter(entry => entry.username === username)
          .slice(0, limit);
      }
      return [];
    } catch (error) {
      throw new Error(`Failed to get radpostauth for username ${username}: ${error.message}`);
    }
  }

  // Get active sessions
  async getActiveSessions() {
    try {
      const allAcct = await this.getRadacct();
      if (Array.isArray(allAcct)) {
        return allAcct.filter(entry =>
          !entry.acctstoptime || entry.acctstoptime === '0000-00-00 00:00:00'
        );
      }
      return [];
    } catch (error) {
      throw new Error(`Failed to get active sessions: ${error.message}`);
    }
  }

  async sendCoA(username, options = {}) {
    if (!username) {
      throw new Error('Username is required for Radius COA');
    }

    const action = options.action || 'disconnect';
    if (action === 'disconnect') {
      const sessionId = options.sessionId || options.acctSessionId;
      if (sessionId) {
        return this.#apiRequest('post', `/api/disconnect/session/${sessionId}`);
      } else {
        return this.#apiRequest('post', `/api/disconnect/${username}`);
      }
    }

    let activeSession = null;
    if (!options.sessionId && !options.acctSessionId) {
      try {
        const sessions = await this.getRadacctByUsername(username, 1000);
        activeSession = Array.isArray(sessions)
          ? sessions.find(entry => !entry.acctstoptime || entry.acctstoptime === '0000-00-00 00:00:00') || sessions[0]
          : null;
      } catch (error) {
        console.warn(`[RADIUS] Failed to resolve active session for ${username}: ${error.message}`);
      }
    }

    const payload = {
      username,
      action,
      nasIpAddress: options.nasIpAddress || options.nas || activeSession?.nasipaddress || activeSession?.nasIpAddress || undefined,
      framedIpAddress: options.framedIpAddress || options.framedIp || activeSession?.framedipaddress || activeSession?.framedIpAddress || undefined,
      sessionId: options.sessionId || options.acctSessionId || activeSession?.acctsessionid || activeSession?.acctSessionId || undefined,
      attributes: options.attributes || {}
    };

    return this.#apiRequest('post', '/api/coa', payload);
  }

  // --- Convenience Methods ---

  // Create a complete user
  async createUser(username, password, attributes = {}, groups = []) {
    const results = {};

    try {
      // 1. Create radcheck entry for password
      const radcheckData = {
        username: username,
        attribute: 'Cleartext-Password',
        op: ':=',
        value: password
      };
      results.radcheck = await this.createRadcheck(radcheckData);

      // Ensure Simultaneous-Use is set to 1 by default
      const hasSimUse = Object.keys(attributes).some(k => k.toLowerCase() === 'simultaneous-use');
      if (!hasSimUse) {
        attributes['Simultaneous-Use'] = '1';
      }

      // 2. Authentication constraints belong in radcheck; response attributes stay in radreply.
      if (Object.keys(attributes).length > 0) {
        results.radcheckAttributes = [];
        results.radreply = [];
        for (const [attribute, value] of Object.entries(attributes)) {
          const normalizedAttribute = String(attribute).toLowerCase();
          const isCheckAttribute = ['expiration', 'calling-station-id', 'nas-ip-address', 'simultaneous-use'].includes(normalizedAttribute);
          if (isCheckAttribute) {
            const checkResult = await this.createRadcheck({
              username,
              attribute,
              op: ['expiration', 'simultaneous-use'].includes(normalizedAttribute) ? ':=' : '==',
              value: String(value)
            });
            results.radcheckAttributes.push(checkResult);
          } else {
            const replyResult = await this.createRadreply({ username, attribute, op: ':=', value: String(value) });
            results.radreply.push(replyResult);
          }
        }
      }

      // 3. Add to groups if provided
      if (groups.length > 0) {
        results.radusergroup = [];
        for (const groupname of groups) {
          const groupData = {
            username: username,
            groupname: groupname,
            priority: 0
          };
          const groupResult = await this.createRadusergroup(groupData);
          results.radusergroup.push(groupResult);
        }
      }

      return {
        success: true,
        message: `User ${username} created successfully`,
        data: results
      };
    } catch (error) {
      console.error(`Error creating user ${username}:`, error);
      throw new Error(`Failed to create user: ${error.message}`);
    }
  }

  /**
   * Update User Expiration in Radius
   */
  async updateExpiration(username, date) {
    try {
      const canonicalDate = date instanceof Date ? date : toCanonicalAdValue(date);
      const expirationDate = canonicalDate instanceof Date ? canonicalDate : new Date(canonicalDate);
      if (Number.isNaN(expirationDate.getTime())) throw new Error('Invalid expiration date');

      console.log('[RADIUS EXPIRATION] Sync started', {
        username,
        expiration: formatRadiusExpiration(expirationDate),
        timezone: 'Asia/Kathmandu'
      });

      const [radcheck, radreply] = await Promise.all([
        this.getRadcheckByUsername(username),
        this.getRadreply().catch(() => [])
      ]);
      const expirationEntries = (Array.isArray(radcheck) ? radcheck : []).filter(entry =>
        String(entry.attribute || '').toLowerCase() === 'expiration'
      );
      const staleReplyEntries = (Array.isArray(radreply) ? radreply : []).filter(entry =>
        entry.username === username && String(entry.attribute || '').toLowerCase() === 'expiration'
      );
      await Promise.all(staleReplyEntries.map(entry => this.deleteRadreply(entry.id)));
      if (staleReplyEntries.length) {
        console.log('[RADIUS EXPIRATION] Removed stale radreply entries', {
          username,
          entryIds: staleReplyEntries.map(entry => entry.id)
        });
      }

      const formattedDate = formatRadiusExpiration(expirationDate);

      if (expirationEntries.length) {
        const result = await Promise.all(expirationEntries.map(entry =>
          this.updateRadcheck(entry.id, { op: ':=', value: formattedDate })
        ));
        console.log('[RADIUS EXPIRATION] Existing radcheck updated', {
          username,
          entryIds: expirationEntries.map(entry => entry.id),
          value: formattedDate
        });
        return result;
      } else {
        const result = await this.createRadcheck({
          username,
          attribute: 'Expiration',
          op: ':=',
          value: formattedDate
        });
        console.log('[RADIUS EXPIRATION] New radcheck created', { username, value: formattedDate });
        return result;
      }
    } catch (error) {
      console.error('[RADIUS EXPIRATION] Sync failed', {
        username,
        expiration: (() => { try { return formatRadiusExpiration(date); } catch { return String(date); } })(),
        timezone: 'Asia/Kathmandu',
        error: error.message,
        responseStatus: error.responseStatus || null,
        responseData: error.responseData || null
      });
      throw error;
    }
  }

  // Get user details

  async getUser(username) {
    try {
      const [
        radcheck,
        radreply,
        radusergroup,
        radacct,
        radpostauth
      ] = await Promise.all([
        this.getRadcheckByUsername(username),
        this.getRadreply().then(data =>
          Array.isArray(data) ? data.filter(entry => entry.username === username) : []
        ),
        this.getRadusergroupByUsername(username),
        this.getRadacctByUsername(username, 50),
        this.getRadpostauthByUsername(username, 50).catch(() => [])
      ]);
      const groupNames = [...new Set(radusergroup.map((entry) => entry.groupname).filter(Boolean))];
      const allGroupReplies = groupNames.length ? await this.getRadgroupreply() : [];
      const allGroupChecks = groupNames.length ? await this.getRadgroupcheck() : [];
      const radgroupreply = Array.isArray(allGroupReplies)
        ? allGroupReplies.filter((entry) => groupNames.includes(entry.groupname))
        : [];
      const radgroupcheck = Array.isArray(allGroupChecks)
        ? allGroupChecks.filter((entry) => groupNames.includes(entry.groupname))
        : [];

      return {
        username,
        radcheck,
        radreply,
        radusergroup,
        radgroupreply,
        radgroupcheck,
        radacct,
        radpostauth,
        hasActiveSession: radacct.some(entry =>
          !entry.acctstoptime || entry.acctstoptime === '0000-00-00 00:00:00'
        )
      };
    } catch (error) {
      throw new Error(`Failed to get user ${username}: ${error.message}`);
    }
  }

  // Delete user completely
  async deleteUser(username) {
    try {
      const results = {};

      // Get all entries for this user
      const radcheckEntries = await this.getRadcheckByUsername(username);
      const radreplyEntries = await this.getRadreply().then(data =>
        Array.isArray(data) ? data.filter(entry => entry.username === username) : []
      );
      const radusergroupEntries = await this.getRadusergroupByUsername(username);

      // Delete radcheck entries
      for (const entry of radcheckEntries) {
        await this.deleteRadcheck(entry.id);
      }
      results.radcheckDeleted = radcheckEntries.length;

      // Delete radreply entries
      for (const entry of radreplyEntries) {
        await this.deleteRadreply(entry.id);
      }
      results.radreplyDeleted = radreplyEntries.length;

      // Delete radusergroup entries
      for (const entry of radusergroupEntries) {
        await this.deleteRadusergroup(entry.id);
      }
      results.radusergroupDeleted = radusergroupEntries.length;

      return {
        success: true,
        message: `User ${username} deleted successfully`,
        data: results
      };
    } catch (error) {
      console.error(`Error deleting user ${username}:`, error);
      throw new Error(`Failed to delete user: ${error.message}`);
    }
  }

  // List all users
  async listUsers(limit = 100, offset = 0) {
    try {
      const radcheckEntries = await this.getRadcheck();

      if (!Array.isArray(radcheckEntries)) {
        return {
          users: [],
          total: 0,
          limit,
          offset
        };
      }

      // Extract unique usernames
      const uniqueUsernames = [...new Set(radcheckEntries.map(entry => entry.username))];

      // Apply pagination
      const paginatedUsernames = uniqueUsernames.slice(offset, offset + limit);

      // Get user details for paginated users
      const usersWithDetails = await Promise.all(
        paginatedUsernames.map(async username => ({
          username,
          hasPassword: radcheckEntries.some(entry =>
            entry.username === username &&
            (entry.attribute === 'Cleartext-Password' || entry.attribute === 'MD5-Password')
          ),
          entryCount: radcheckEntries.filter(entry => entry.username === username).length
        }))
      );

      return {
        users: usersWithDetails,
        total: uniqueUsernames.length,
        limit,
        offset,
        hasMore: offset + limit < uniqueUsernames.length
      };
    } catch (error) {
      console.error('Error listing users:', error);
      throw new Error(`Failed to list users: ${error.message}`);
    }
  }


  // List all NAS
  async listNas(limit = 100, offset = 0) {
    try {
      const nasEntries = await this.getNas();

      if (!Array.isArray(nasEntries)) {
        return {
          nas: [],
          total: 0,
          limit,
          offset
        };
      }

      // Apply pagination
      const paginatedNas = nasEntries.slice(offset, offset + limit);

      return {
        nas: paginatedNas,
        total: nasEntries.length,
        limit,
        offset,
        hasMore: offset + limit < nasEntries.length
      };
    } catch (error) {
      console.error('Error listing NAS:', error);
      throw new Error(`Failed to list NAS: ${error.message}`);
    }
  }

  // --- New Disconnect & Sessions API Endpoints ---
  async listNasDevices() {
    return this.#apiRequest('get', '/api/nas-devices');
  }

  async listActiveSessions(limit = 100, offset = 0) {
    return this.#apiRequest('get', '/api/sessions', { limit, offset });
  }

  async getSessionInfo(username) {
    return this.#apiRequest('get', `/api/sessions/${username}`);
  }

  async disconnectUser(username) {
    return this.#apiRequest('post', `/api/disconnect/${username}`);
  }

  async disconnectAllSessions(username) {
    return this.#apiRequest('post', `/api/disconnect/${username}/all`);
  }

  async disconnectBySessionId(sessionId) {
    return this.#apiRequest('post', `/api/disconnect/session/${sessionId}`);
  }





  // Get system stats
  async getSystemStats() {
    try {
      const [
        radcheck,
        radreply,
        radusergroup,
        radacct,
        activeSessions
      ] = await Promise.all([
        this.getRadcheck(),
        this.getRadreply(),
        this.getRadusergroup(),
        this.getRadacct(),
        this.getActiveSessions()
      ]);

      const uniqueUsers = Array.isArray(radcheck) ?
        new Set(radcheck.map(entry => entry.username)).size : 0;

      return {
        timestamp: new Date().toISOString(),
        counts: {
          radcheck: Array.isArray(radcheck) ? radcheck.length : 0,
          radreply: Array.isArray(radreply) ? radreply.length : 0,
          radusergroup: Array.isArray(radusergroup) ? radusergroup.length : 0,
          radacct: Array.isArray(radacct) ? radacct.length : 0,
          activeSessions: Array.isArray(activeSessions) ? activeSessions.length : 0
        },
        uniqueUsers,
        summary: {
          totalUsers: uniqueUsers,
          totalEntries: (Array.isArray(radcheck) ? radcheck.length : 0) +
            (Array.isArray(radreply) ? radreply.length : 0) +
            (Array.isArray(radusergroup) ? radusergroup.length : 0),
          activeConnections: Array.isArray(activeSessions) ? activeSessions.length : 0
        }
      };
    } catch (error) {
      console.error('Error getting system stats:', error);
      throw new Error(`Failed to get system stats: ${error.message}`);
    }
  }

  // Get health status
  async getHealth() {
    try {
      const response = await this.#api.get('/health', { timeout: 5000 });
      return {
        status: response.data?.status || 'unknown',
        timestamp: new Date().toISOString(),
        data: response.data
      };
    } catch (error) {
      return {
        status: 'error',
        message: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }
}

module.exports = { RadiusClient };
