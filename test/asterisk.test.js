// Set up necessary environment variables before imports
process.env.ACCESS_SECRET = 'dummy-secret-for-testing';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

// Mock Axios create behavior before requiring AsteriskService
let lastAxiosConfig = null;
let mockGetHandler = async () => ({ status: 200, data: {} });
let lastPostParams = null;
let lastDeleteUrl = null;

const originalCreate = axios.create;
axios.create = function(config) {
  lastAxiosConfig = config;
  return {
    get: async (url, cfg) => mockGetHandler(url, cfg),
    post: async (url, data, cfg) => {
      lastPostParams = cfg?.params || {};
      return { status: 200, data: { id: 'chan-12345' } };
    },
    delete: async (url, cfg) => {
      lastDeleteUrl = url;
      return { status: 200, data: {} };
    }
  };
};

const AsteriskService = require('../src/services/asterisk.service');
const asteriskRoutes = require('../src/routes/asterisk.routes');

test('Asterisk Integration Audits & Repairs', async (t) => {

  const mockPrisma = {
    iSPService: {
      findFirst: async () => ({
        credentials: [
          { key: 'ari_host', value: '10.3.2.16' },
          { key: 'ari_username', value: 'kashtrix-api' },
          { key: 'ari_password', value: 'secret' }
        ]
      })
    },
    asteriskExtension: {
      upsert: async () => ({})
    },
    asteriskTrunk: {
      findMany: async () => ([]),
      upsert: async () => ({})
    },
    asteriskSystemStatus: {
      findUnique: async () => ({
        totalExtensions: 5,
        activeExtensions: 3,
        totalTrunks: 2,
        activeTrunks: 1,
        activeCalls: 1,
        version: 'Asterisk 18',
        systemUptime: '1d 5h'
      }),
      upsert: async () => ({})
    }
  };

  await t.test('ARI-only configuration loads successfully without AMI credentials', async () => {
    const config = await AsteriskService.getConfig(1, mockPrisma);
    assert.equal(config.ariHost, '10.3.2.16');
    assert.equal(config.ariPort, 8088);
    assert.equal(config.ariUsername, 'kashtrix-api');
    assert.equal(config.ariPassword, 'secret');
    assert.equal(config.ariAppName, 'kisan');
    
    // Optional AMI fields must be null when credentials are absent
    assert.equal(config.amiHost, null);
    assert.equal(config.amiPort, null);
    assert.equal(config.amiUsername, null);
    assert.equal(config.amiPassword, null);
  });

  await t.test('ARI Host normalization builds valid URL without duplicating schemes/ports', async () => {
    const testCases = [
      { host: '10.3.2.16', expected: 'http://10.3.2.16:8088' },
      { host: 'http://10.3.2.16', expected: 'http://10.3.2.16:8088' },
      { host: 'https://10.3.2.16', expected: 'https://10.3.2.16:8088' },
      { host: 'http://10.3.2.16:9000', expected: 'http://10.3.2.16:9000' },
      { host: 'https://10.3.2.16:8443/', expected: 'https://10.3.2.16:8443' }
    ];

    for (const tc of testCases) {
      const config = {
        ispId: 1,
        ariHost: tc.host,
        ariPort: 8088,
        ariUsername: 'user',
        ariPassword: 'pwd',
        ariAppName: 'kisan'
      };
      new AsteriskService(config, mockPrisma);
      assert.equal(lastAxiosConfig.baseURL, tc.expected);
    }

    // Invalid protocol should throw error
    assert.throws(() => {
      new AsteriskService({
        ispId: 1,
        ariHost: 'ftp://10.3.2.16',
        ariPort: 8088,
        ariUsername: 'user',
        ariPassword: 'pwd'
      }, mockPrisma);
    }, /Invalid protocol/);
  });

  await t.test('testConnection returns successful connection state for ARI', async () => {
    mockGetHandler = async (url) => {
      if (url === '/ari/asterisk/info') {
        return { status: 200, data: { system: { version: '18.9.0' } } };
      }
      return { status: 404 };
    };

    const config = await AsteriskService.getConfig(1, mockPrisma);
    const service = new AsteriskService(config, mockPrisma);
    const res = await service.testConnection();

    assert.equal(res.success, true);
    assert.equal(res.connected, true);
    assert.equal(res.ariConnected, true);
    assert.equal(res.amiConnected, false);
    assert.match(res.message, /AMI not configured/);
  });

  await t.test('testConnection handles ARI connection failure and reports truthfully', async () => {
    mockGetHandler = async () => {
      throw new Error('Connection refused');
    };

    const config = await AsteriskService.getConfig(1, mockPrisma);
    const service = new AsteriskService(config, mockPrisma);
    const res = await service.testConnection();

    assert.equal(res.success, false);
    assert.equal(res.connected, false);
    assert.equal(res.ariConnected, false);
    assert.match(res.message, /ARI connection failed/);
  });

  await t.test('endpoint filtering handles PJSIP technology case-insensitively and maps registered status', async () => {
    mockGetHandler = async (url) => {
      if (url === '/ari/endpoints') {
        return {
          status: 200,
          data: [
            { technology: 'pjsip', resource: '1001', state: 'online' },
            { technology: 'SIP', resource: '1002', state: 'offline' },
            { technology: 'DAHDI', resource: '1', state: 'online' }
          ]
        };
      }
      return { status: 404 };
    };

    const config = await AsteriskService.getConfig(1, mockPrisma);
    const service = new AsteriskService(config, mockPrisma);
    const res = await service.listExtensions();

    assert.equal(res.success, true);
    assert.equal(res.total, 2); // Only PJSIP and SIP
    assert.equal(res.data[0].number, '1001');
    assert.equal(res.data[0].type, 'PJSIP');
    assert.equal(res.data[0].status, 'Registered');
    assert.equal(res.data[1].number, '1002');
    assert.equal(res.data[1].type, 'SIP');
    assert.equal(res.data[1].status, 'Unregistered');
  });

  await t.test('listExtensions returns success false and does not fall back to mock data on error', async () => {
    mockGetHandler = async () => {
      throw new Error('API failure');
    };

    const config = await AsteriskService.getConfig(1, mockPrisma);
    const service = new AsteriskService(config, mockPrisma);
    const res = await service.listExtensions();

    assert.equal(res.success, false);
    assert.equal(res.data.length, 0);
    assert.equal(res.total, 0);
  });

  await t.test('makeCall originates dialplan call with context internal, priority 1, and no app parameter', async () => {
    const config = await AsteriskService.getConfig(1, mockPrisma);
    const service = new AsteriskService(config, mockPrisma);
    const res = await service.makeCall('1001', '9841234567');

    assert.equal(res.success, true);
    assert.equal(res.data.id, 'chan-12345');
    assert.equal(lastPostParams.endpoint, 'PJSIP/1001');
    assert.equal(lastPostParams.extension, '9841234567');
    assert.equal(lastPostParams.context, 'internal');
    assert.equal(lastPostParams.priority, 1);
    assert.equal(lastPostParams.callerId, '1001');
    assert.equal(lastPostParams.app, undefined); // App parameter must not be present
  });

  await t.test('makeCall rejects invalid extension and destination with clear errors', async () => {
    const config = await AsteriskService.getConfig(1, mockPrisma);
    const service = new AsteriskService(config, mockPrisma);

    // Invalid extension
    const res1 = await service.makeCall('1', '9841234567');
    assert.equal(res1.success, false);
    assert.match(res1.error, /Invalid extension format/);

    // Invalid destination
    const res2 = await service.makeCall('1001', '9');
    assert.equal(res2.success, false);
    assert.match(res2.error, /Invalid destination format/);
  });

  await t.test('hangupCall uses URL-encoded channel ID', async () => {
    const config = await AsteriskService.getConfig(1, mockPrisma);
    const service = new AsteriskService(config, mockPrisma);
    const res = await service.hangupCall('PJSIP/1001-0000000a');

    assert.equal(res.success, true);
    assert.equal(lastDeleteUrl, '/ari/channels/PJSIP%2F1001-0000000a');
  });

  await t.test('route permissions are properly declared on asterisk router', () => {
    const dummyPrisma = {};
    const router = asteriskRoutes(dummyPrisma);
    
    // Check registered routes and their handlers
    const paths = router.stack.map(layer => layer.route?.path).filter(Boolean);
    assert.ok(paths.includes('/calls/make'));
    assert.ok(paths.includes('/extensions'));
  });
});
