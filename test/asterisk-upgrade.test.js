process.env.ACCESS_SECRET = 'test-secret-for-upgrades';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const http = require('http');
const fs = require('fs');

let mockGetHandler = async () => ({ status: 200, data: {} });
let mockPostHandler = async () => ({ status: 200, data: {} });

axios.create = function(config) {
  return {
    get: async (url, cfg) => mockGetHandler(url, cfg),
    post: async (url, data, cfg) => mockPostHandler(url, data, cfg),
    delete: async () => ({ status: 200, data: {} })
  };
};

const AsteriskService = require('../src/services/asterisk.service');
const AsteriskProvisioningService = require('../src/services/asterisk-provisioning.service');
const AsteriskAiAgentService = require('../src/services/asterisk-ai-agent.service');
const AsteriskAiAgentProvisioningService = require('../src/services/asterisk-ai-agent-provisioning.service');
const asteriskRoutes = require('../src/routes/asterisk.routes');

test('VoIP Module Audits & Upgrades - Phase 3', async (t) => {

  const mockPrisma = {
    iSPService: {
      findFirst: async () => ({
        credentials: [
          { key: 'ari_host', value: 'http://10.3.2.16' },
          { key: 'ari_username', value: 'kashtrix-api' },
          { key: 'ari_password', value: 'secret' }
        ]
      })
    },
    asteriskProvisioningConfig: {
      findUnique: async () => ({
        mode: 'local_file',
        enabled: true,
        localConfigDir: './scratch/asterisk'
      })
    },
    asteriskExtension: {
      findFirst: async () => null,
      create: async (data) => data.data,
      upsert: async () => ({})
    },
    asteriskAiAgent: {
      findFirst: async () => null,
      create: async (data) => ({ id: 1, ...data.data }),
      findMany: async () => [],
      update: async (data) => data.data
    },
    asteriskAiAgentPromptVersion: {
      create: async (data) => data.data
    },
    asteriskOutboundRoute: {
      findMany: async () => []
    },
    asteriskTrunk: {
      findMany: async () => [
        { pbxTrunkId: 'yeastar-s50', trunkname: 'yeastar-s50' }
      ],
      upsert: async () => ({})
    },
    asteriskSystemStatus: {
      findUnique: async () => ({})
    }
  };

  await t.test('1. Endpoint Classification', () => {
    const dbTrunks = [
      { pbxTrunkId: 'yeastar-s50', trunkname: 'yeastar-s50' }
    ];

    const ep1 = { resource: '1001', technology: 'PJSIP' };
    const ep2 = { resource: '1002', technology: 'PJSIP' };
    const ep3 = { resource: 'yeastar-s50', technology: 'PJSIP' };

    assert.equal(AsteriskService.classifyEndpoint(ep1, dbTrunks), 'extension');
    assert.equal(AsteriskService.classifyEndpoint(ep2, dbTrunks), 'extension');
    assert.equal(AsteriskService.classifyEndpoint(ep3, dbTrunks), 'trunk');
  });

  await t.test('2. AI Agents Auto-seeding & Sync', async () => {
    let seeded = 0;
    const testPrisma = {
      ...mockPrisma,
      asteriskAiAgent: {
        findFirst: async () => null,
        create: async (data) => {
          seeded++;
          return { id: seeded, ...data.data };
        }
      }
    };

    const agentService = new AsteriskAiAgentService(1, testPrisma);
    await agentService.syncDefaultAgents();
    assert.equal(seeded, 2); // 800 and 801
  });

  await t.test('3. AI Agent Health Probing Schema', async () => {
    const agentService = new AsteriskAiAgentService(1, mockPrisma);
    agentService.getAgent = async () => ({
      id: 1,
      extension: '801',
      audioSocketHost: '127.0.0.1',
      audioSocketPort: 9020,
      serviceName: 'kashtrix-voice-agent',
      enabled: true
    });
    agentService.checkPortStatus = async () => 'running';

    const health = await agentService.getAgentHealth(1);
    assert.equal(health.databaseStatus, 'configured');
    assert.equal(health.socketStatus, 'listening');
    assert.equal(health.serviceStatus, 'running');
    assert.equal(health.runtimeStatus, 'healthy');
  });

  await t.test('4. Safe Provisioning adaptors block arbitrary systemd services', async () => {
    const prov = new AsteriskAiAgentProvisioningService(1, mockPrisma, {
      mode: 'local_file',
      enabled: true
    });

    // Allowed service
    const res1 = await prov.startRuntime('kashtrix-voice-agent');
    assert.equal(res1.success, true);

    // Blocked service
    await assert.rejects(async () => {
      await prov.startRuntime('unauthorized-arbitrary-service');
    }, /is not in the trusted allowlist/);
  });

  await t.test('5. Safe dialplan format generation with UUID Random Set', async () => {
    const prov = new AsteriskAiAgentProvisioningService(1, mockPrisma, {
      mode: 'local_file',
      enabled: true,
      localConfigDir: './scratch/test_asterisk'
    });

    const agent = {
      extension: '801',
      name: 'Kashtrix AI Agent',
      audioSocketHost: '127.0.0.1',
      audioSocketPort: 9020,
      enabled: true
    };

    await prov.bindDialplanDestination(agent);

    const dialplanPath = './scratch/test_asterisk/extensions.conf';
    assert.ok(fs.existsSync(dialplanPath));
    const content = fs.readFileSync(dialplanPath, 'utf-8');
    assert.ok(content.includes('Set(AI_CALL_UUID='));
    assert.ok(content.includes('AudioSocket(${AI_CALL_UUID},127.0.0.1:9020)'));

    // cleanup
    fs.rmSync('./scratch/test_asterisk', { recursive: true, force: true });
  });
});
