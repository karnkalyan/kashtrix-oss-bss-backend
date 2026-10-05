const axios = require('axios');

/**
 * AsteriskAriClient
 * Optional REST client for modern Asterisk ARI.
 * Safely handles cases where ARI is not configured or disabled on the PBX.
 */
class AsteriskAriClient {
  #config = null;
  #client = null;
  #isAvailable = false;

  constructor(config = {}) {
    this.#config = config;

    const host = config.ariHost || config.host;
    const port = Number(config.ariPort || config.port) || 8088;
    const username = config.ariUsername || config.username;
    const password = config.ariPassword || config.password;

    if (host && username && password) {
      this.#client = axios.create({
        baseURL: `http://${host}:${port}`,
        auth: { username, password },
        timeout: 5000,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      });
      this.#isAvailable = true;
    } else {
      this.#isAvailable = false;
    }
  }

  get isConfigured() {
    return this.#isAvailable && !!this.#client;
  }

  /**
   * Test ARI connection by querying /ari/asterisk/info
   */
  async testConnection() {
    if (!this.isConfigured) {
      return { connected: false, message: 'ARI not configured', info: null };
    }

    try {
      const res = await this.#client.get('/ari/asterisk/info');
      return {
        connected: res.status === 200,
        message: res.status === 200 ? 'ARI connected successfully' : `ARI returned status ${res.status}`,
        info: res.data || null
      };
    } catch (err) {
      return {
        connected: false,
        message: `ARI connection failed: ${err.message}`,
        info: null
      };
    }
  }

  async getInfo() {
    if (!this.isConfigured) return null;
    try {
      const res = await this.#client.get('/ari/asterisk/info');
      return res.data;
    } catch (e) {
      return null;
    }
  }

  async listEndpoints() {
    if (!this.isConfigured) return [];
    try {
      const res = await this.#client.get('/ari/endpoints');
      return Array.isArray(res.data) ? res.data : [];
    } catch (e) {
      return [];
    }
  }

  async listChannels() {
    if (!this.isConfigured) return [];
    try {
      const res = await this.#client.get('/ari/channels');
      return Array.isArray(res.data) ? res.data : [];
    } catch (e) {
      return [];
    }
  }

  async listBridges() {
    if (!this.isConfigured) return [];
    try {
      const res = await this.#client.get('/ari/bridges');
      return Array.isArray(res.data) ? res.data : [];
    } catch (e) {
      return [];
    }
  }

  async hangupChannel(channelId, reason = 'normal') {
    if (!this.isConfigured) throw new Error('ARI not configured');
    const res = await this.#client.delete(`/ari/channels/${encodeURIComponent(channelId)}`, {
      params: { reason }
    });
    return res.data;
  }

  async playMedia(channelId, mediaUri) {
    if (!this.isConfigured) throw new Error('ARI not configured');
    const res = await this.#client.post(`/ari/channels/${encodeURIComponent(channelId)}/play`, null, {
      params: { media: mediaUri }
    });
    return res.data;
  }

  async recordChannel(channelId, name, format = 'wav') {
    if (!this.isConfigured) throw new Error('ARI not configured');
    const res = await this.#client.post(`/ari/channels/${encodeURIComponent(channelId)}/record`, null, {
      params: { name, format }
    });
    return res.data;
  }
}

module.exports = AsteriskAriClient;
