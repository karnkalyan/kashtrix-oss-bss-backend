const AsteriskService = require('../services/asterisk.service');
const AsteriskProvisioningService = require('../services/asterisk-provisioning.service');
const AsteriskAiAgentService = require('../services/asterisk-ai-agent.service');
const AsteriskAiAgentProvisioningService = require('../services/asterisk-ai-agent-provisioning.service');
const { logAudit } = require('../utils/auditLogger');

function hasManagePermission(req) {
  if (!req.user) return false;
  const role = req.user.role?.toLowerCase() || '';
  if (['administrator', 'super admin', 'super_admin', 'admin'].includes(role)) {
    return true;
  }
  return Array.isArray(req.user.permissions) && req.user.permissions.includes('asterisk_manage');
}

function redactAgent(agent, hasManage) {
  if (!agent) return agent;
  if (hasManage) return agent;
  return {
    ...agent,
    prompt: '[REDACTED]',
    audioSocketHost: '[REDACTED]',
    audioSocketPort: 0
  };
}

class AsteriskController {
  constructor(prisma) {
    this.prisma = prisma;
    console.log('✅ AsteriskController initialized with Upgraded VoIP Management');
  }

  #handleServiceError(error, operation = 'operation') {
    console.error(`[AsteriskController] ${operation} error:`, error);
    return {
      success: false,
      code: error.code || 'UPSTREAM_ERROR',
      error: error.message || String(error),
      message: `Failed to ${operation.replace(/_/g, ' ')}`,
      timestamp: new Date().toISOString()
    };
  }

  async getCapabilities(req, res) {
    try {
      const ispId = req.ispId;
      const service = await AsteriskService.create(ispId, this.prisma);
      const capabilities = await service.getCapabilities();
      res.json({ success: true, data: capabilities });
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'get_capabilities'));
    }
  }

  async getDashboardStatus(req, res) {
    try {
      const ispId = req.ispId;
      const status = await AsteriskService.getServiceStatus(ispId, this.prisma);
      res.json({ success: true, data: status });
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'get_status'));
    }
  }

  async getSystemInfo(req, res) {
    try {
      const ispId = req.ispId;
      const service = await AsteriskService.create(ispId, this.prisma);
      const info = await service.getSystemInfo();
      res.json({ success: true, data: info });
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'get_system_info'));
    }
  }

  async syncSystemStatus(req, res) {
    try {
      const ispId = req.ispId;
      const service = await AsteriskService.create(ispId, this.prisma);
      res.json(result);
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'sync_system_status'));
    }
  }

  async testConnection(req, res) {
    try {
      const ispId = req.ispId;
      const service = await AsteriskService.create(ispId, this.prisma);
      const result = await service.testConnection();
      res.json(result);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message || String(error),
        message: 'Connection test failed'
      });
    }
  }

  // ==================== PROVISIONING CONFIG ====================
  async getProvisioningConfig(req, res) {
    try {
      const ispId = req.ispId;
      const config = await this.prisma.asteriskProvisioningConfig.findUnique({
        where: { ispId }
      });
      if (!config) {
        return res.json({
          success: true,
          data: {
            configured: false,
            enabled: false,
            mode: 'disabled',
            host: '10.3.2.16',
            port: 22,
            configDirectory: '/etc/asterisk',
            customDialplanFile: '/etc/asterisk/extensions_custom.conf',
            capabilities: [],
            lastCheck: null,
            lastError: null
          }
        });
      }

      // Redact passwords & keys
      const redacted = {
        configured: true,
        enabled: config.enabled,
        mode: config.provisioningMode || config.mode || 'local',
        host: config.provisioningHost || config.host || '10.3.2.16',
        port: config.provisioningPort || config.port || 22,
        configDirectory: config.asteriskConfigDirectory || '/etc/asterisk',
        customDialplanFile: config.customDialplanFile || '/etc/asterisk/extensions_custom.conf',
        capabilities: [
          'read_config',
          'write_managed_config',
          'dialplan_reload',
          'service_status',
          'service_start',
          'service_stop',
          'service_restart',
          'systemd_status',
          'socket_health'
        ],
        lastCheck: config.lastTestedAt,
        lastError: config.lastError
      };

      res.json({ success: true, data: redacted });
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'get_provisioning_config'));
    }
  }

  async updateProvisioningConfig(req, res) {
    try {
      const ispId = req.ispId;
      const data = req.body;

      const existing = await this.prisma.asteriskProvisioningConfig.findUnique({
        where: { ispId }
      });

      // Preserve secrets if redacted is sent
      if (existing) {
        if (data.sshPassword === '[REDACTED]') data.sshPassword = existing.sshPassword;
        if (data.sshPrivateKey === '[REDACTED]') data.sshPrivateKey = existing.sshPrivateKey;
        if (data.credentialReference === '[REDACTED]') data.credentialReference = existing.credentialReference;
        if (data.ariPassword === '[REDACTED]') data.ariPassword = existing.ariPassword;
        if (data.amiPassword === '[REDACTED]') data.amiPassword = existing.amiPassword;
      }

      const config = await this.prisma.asteriskProvisioningConfig.upsert({
        where: { ispId },
        update: {
          enabled: data.enabled !== false,
          pbxHost: data.pbxHost,
          sipPort: data.sipPort ? parseInt(data.sipPort, 10) : undefined,
          ariEnabled: data.ariEnabled !== false,
          ariHost: data.ariHost,
          ariPort: data.ariPort ? parseInt(data.ariPort, 10) : undefined,
          ariAppName: data.ariAppName,
          ariUsername: data.ariUsername,
          ariPassword: data.ariPassword,
          amiEnabled: data.amiEnabled !== false,
          amiHost: data.amiHost,
          amiPort: data.amiPort ? parseInt(data.amiPort, 10) : undefined,
          amiUsername: data.amiUsername,
          amiPassword: data.amiPassword,
          provisioningEnabled: data.provisioningEnabled !== false,
          provisioningMode: data.provisioningMode || data.mode || 'local',
          provisioningHost: data.provisioningHost || data.host,
          provisioningPort: data.provisioningPort ? parseInt(data.provisioningPort, 10) : undefined,
          provisioningUsername: data.provisioningUsername || data.username,
          sshPrivateKey: data.sshPrivateKey,
          asteriskConfigDirectory: data.asteriskConfigDirectory,
          asteriskCliPath: data.asteriskCliPath,
          asteriskSystemdService: data.asteriskSystemdService,
          customDialplanFile: data.customDialplanFile,
          audioSocketBindHost: data.audioSocketBindHost,
          cdrSourceType: data.cdrSourceType,
          cdrConnectionSettings: data.cdrConnectionSettings,
          // Compatibility mappings
          mode: data.provisioningMode || data.mode || 'local',
          host: data.provisioningHost || data.host,
          port: data.provisioningPort ? parseInt(data.provisioningPort, 10) : undefined,
          username: data.provisioningUsername || data.username,
          sshHost: data.provisioningHost || data.host,
          sshPort: data.provisioningPort ? parseInt(data.provisioningPort, 10) : undefined,
          sshUsername: data.provisioningUsername || data.username,
          sshPassword: data.sshPassword || data.credentialReference,
          localConfigDir: data.localConfigDir
        },
        create: {
          ispId,
          enabled: data.enabled !== false,
          pbxHost: data.pbxHost,
          sipPort: data.sipPort ? parseInt(data.sipPort, 10) : undefined,
          ariEnabled: data.ariEnabled !== false,
          ariHost: data.ariHost,
          ariPort: data.ariPort ? parseInt(data.ariPort, 10) : undefined,
          ariAppName: data.ariAppName,
          ariUsername: data.ariUsername,
          ariPassword: data.ariPassword,
          amiEnabled: data.amiEnabled !== false,
          amiHost: data.amiHost,
          amiPort: data.amiPort ? parseInt(data.amiPort, 10) : undefined,
          amiUsername: data.amiUsername,
          amiPassword: data.amiPassword,
          provisioningEnabled: data.provisioningEnabled !== false,
          provisioningMode: data.provisioningMode || data.mode || 'local',
          provisioningHost: data.provisioningHost || data.host,
          provisioningPort: data.provisioningPort ? parseInt(data.provisioningPort, 10) : undefined,
          provisioningUsername: data.provisioningUsername || data.username,
          sshPrivateKey: data.sshPrivateKey,
          asteriskConfigDirectory: data.asteriskConfigDirectory,
          asteriskCliPath: data.asteriskCliPath,
          asteriskSystemdService: data.asteriskSystemdService,
          customDialplanFile: data.customDialplanFile,
          audioSocketBindHost: data.audioSocketBindHost,
          cdrSourceType: data.cdrSourceType,
          cdrConnectionSettings: data.cdrConnectionSettings,
          // Compatibility mappings
          mode: data.provisioningMode || data.mode || 'local',
          host: data.provisioningHost || data.host,
          port: data.provisioningPort ? parseInt(data.provisioningPort, 10) : undefined,
          username: data.provisioningUsername || data.username,
          sshHost: data.provisioningHost || data.host,
          sshPort: data.provisioningPort ? parseInt(data.provisioningPort, 10) : undefined,
          sshUsername: data.provisioningUsername || data.username,
          sshPassword: data.sshPassword || data.credentialReference,
          localConfigDir: data.localConfigDir
        }
      });

      await logAudit(this.prisma, req.user?.id, 'UPDATE_PROVISIONING_CONFIG', { mode: config.provisioningMode }, req);
      res.json({ success: true, data: config });
    } catch (error) {
      res.status(400).json(this.#handleServiceError(error, 'update_provisioning_config'));
    }
  }

  async testProvisioningConfig(req, res) {
    try {
      const ispId = req.ispId;
      const prov = await AsteriskProvisioningService.getService(ispId, this.prisma);
      if (!prov.isConfigured()) {
        return res.status(503).json({
          success: false,
          code: 'PROVISIONING_NOT_CONFIGURED',
          message: 'AI-agent provisioning is not configured for this ISP'
        });
      }
      const validate = await prov.validateConfig();
      if (!validate.success) {
        return res.status(400).json({ success: false, error: validate.message });
      }
      res.json({ success: true, message: 'Provisioning configuration tested successfully' });
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'test_provisioning'));
    }
  }

  // ==================== EXTENSIONS ====================
  async listExtensions(req, res) {
    try {
      const ispId = req.ispId;
      const service = await AsteriskService.create(ispId, this.prisma);
      const result = await service.listExtensions();
      res.json(result);
    } catch (error) {
      res.json({
        success: true,
        connected: false,
        data: [],
        total: 0,
        message: 'Asterisk service not configured or connected'
      });
    }
  }

  async getExtensionDetails(req, res) {
    try {
      const ispId = req.ispId;
      const { extension } = req.params;
      const service = await AsteriskService.create(ispId, this.prisma);
      const details = await service.getExtension(extension);
      res.json({ success: true, data: details });
    } catch (error) {
      res.status(404).json(this.#handleServiceError(error, 'get_extension_details'));
    }
  }

  async getExtensionsFromDB(req, res) {
    try {
      const ispId = req.ispId;
      const extensions = await this.prisma.asteriskExtension.findMany({
        where: {
          ispId,
          isActive: true,
          isDeleted: false
        },
        orderBy: { extensionNumber: 'asc' }
      });
      res.json({
        success: true,
        data: extensions,
        total: extensions.length,
        message: `${extensions.length} extensions found in database`
      });
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'get_extensions_from_db'));
    }
  }

  async createExtension(req, res) {
    try {
      const ispId = req.ispId;
      const prov = await AsteriskProvisioningService.getService(ispId, this.prisma);
      const result = await prov.createExtension(req.body);
      
      await logAudit(this.prisma, req.user?.id, 'CREATE_EXTENSION', { extensionNumber: req.body.extensionNumber }, req);
      res.status(201).json(result);
    } catch (error) {
      if (error.code === 'PROVISIONING_NOT_CONFIGURED') {
        return res.status(503).json({ success: false, code: error.code, message: error.message });
      }
      res.status(400).json(this.#handleServiceError(error, 'create_extension'));
    }
  }

  async updateExtension(req, res) {
    try {
      const ispId = req.ispId;
      const { extension } = req.params;
      const prov = await AsteriskProvisioningService.getService(ispId, this.prisma);
      const result = await prov.updateExtension(extension, req.body);

      await logAudit(this.prisma, req.user?.id, 'UPDATE_EXTENSION', { extensionNumber: extension, updates: req.body }, req);
      res.json(result);
    } catch (error) {
      res.status(400).json(this.#handleServiceError(error, 'update_extension'));
    }
  }

  async deleteExtension(req, res) {
    try {
      const ispId = req.ispId;
      const { extension } = req.params;
      const prov = await AsteriskProvisioningService.getService(ispId, this.prisma);
      const result = await prov.deleteExtension(extension);

      await logAudit(this.prisma, req.user?.id, 'DELETE_EXTENSION', { extensionNumber: extension }, req);
      res.json(result);
    } catch (error) {
      res.status(400).json(this.#handleServiceError(error, 'delete_extension'));
    }
  }

  async toggleExtensionStatus(req, res) {
    try {
      const ispId = req.ispId;
      const { extension } = req.params;
      const { isActive } = req.body;
      const prov = await AsteriskProvisioningService.getService(ispId, this.prisma);
      
      let result;
      if (isActive) {
        result = await prov.enableExtension(extension);
      } else {
        result = await prov.disableExtension(extension);
      }

      await logAudit(this.prisma, req.user?.id, 'TOGGLE_EXTENSION_STATUS', { extensionNumber: extension, isActive }, req);
      res.json(result);
    } catch (error) {
      res.status(400).json(this.#handleServiceError(error, 'toggle_extension_status'));
    }
  }

  async regenerateSecret(req, res) {
    try {
      const ispId = req.ispId;
      const { extension } = req.params;
      const prov = await AsteriskProvisioningService.getService(ispId, this.prisma);
      const result = await prov.regenerateSecret(extension);

      await logAudit(this.prisma, req.user?.id, 'REGENERATE_EXTENSION_SECRET', { extensionNumber: extension }, req);
      res.json(result);
    } catch (error) {
      res.status(400).json(this.#handleServiceError(error, 'regenerate_secret'));
    }
  }

  async getSoftphoneConfig(req, res) {
    try {
      const ispId = req.ispId;
      const { extension } = req.params;
      const service = await AsteriskService.create(ispId, this.prisma);
      const config = await service.getSoftphoneConfig(extension);
      res.json({ success: true, data: config });
    } catch (error) {
      res.status(404).json(this.#handleServiceError(error, 'get_softphone_config'));
    }
  }

  // ==================== AI AGENTS ====================
  async listAiAgents(req, res) {
    try {
      const ispId = req.ispId;
      const agentService = new AsteriskAiAgentService(ispId, this.prisma);
      const agents = await agentService.listAgents();

      const hasManage = hasManagePermission(req);
      const updatedAgents = await Promise.all(agents.map(async (agent) => {
        const portStatus = await agentService.checkPortStatus(agent.audioSocketHost, agent.audioSocketPort);
        const redacted = redactAgent(agent, hasManage);
        return { ...redacted, runtimeStatus: portStatus };
      }));

      res.json({ success: true, data: updatedAgents });
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'list_ai_agents'));
    }
  }

  async getAiAgent(req, res) {
    try {
      const ispId = req.ispId;
      const id = parseInt(req.params.id, 10);
      const agentService = new AsteriskAiAgentService(ispId, this.prisma);
      const agent = await agentService.getAgent(id);
      if (!agent) {
        return res.status(404).json({ success: false, error: 'AI Agent not found' });
      }
      res.json({ success: true, data: redactAgent(agent, hasManagePermission(req)) });
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'get_ai_agent'));
    }
  }

  async createAiAgent(req, res) {
    try {
      const ispId = req.ispId;
      const agentService = new AsteriskAiAgentService(ispId, this.prisma);
      const agent = await agentService.createAgent(req.body);

      await logAudit(this.prisma, req.user?.id, 'CREATE_AI_AGENT', { extension: req.body.extension }, req);
      res.status(201).json({ success: true, data: agent });
    } catch (error) {
      res.status(400).json(this.#handleServiceError(error, 'create_ai_agent'));
    }
  }

  async updateAiAgent(req, res) {
    try {
      const ispId = req.ispId;
      const id = parseInt(req.params.id, 10);
      const agentService = new AsteriskAiAgentService(ispId, this.prisma);
      const agent = await agentService.updateAgent(id, req.body);

      await logAudit(this.prisma, req.user?.id, 'UPDATE_AI_AGENT', { id, updates: req.body }, req);
      res.json({ success: true, data: agent });
    } catch (error) {
      res.status(400).json(this.#handleServiceError(error, 'update_ai_agent'));
    }
  }

  async cloneAiAgent(req, res) {
    try {
      const ispId = req.ispId;
      const id = parseInt(req.params.id, 10);
      const { newExtension } = req.body;
      const agentService = new AsteriskAiAgentService(ispId, this.prisma);
      const cloned = await agentService.cloneAgent(id, newExtension);

      await logAudit(this.prisma, req.user?.id, 'CLONE_AI_AGENT', { sourceId: id, newExtension }, req);
      res.status(201).json({ success: true, data: cloned });
    } catch (error) {
      res.status(400).json(this.#handleServiceError(error, 'clone_ai_agent'));
    }
  }

  async toggleAiAgentStatus(req, res) {
    try {
      const ispId = req.ispId;
      const id = parseInt(req.params.id, 10);
      const { enabled } = req.body;
      const agentService = new AsteriskAiAgentService(ispId, this.prisma);
      const agent = await agentService.updateAgent(id, { enabled });

      await logAudit(this.prisma, req.user?.id, 'TOGGLE_AI_AGENT_STATUS', { id, enabled }, req);
      res.json({ success: true, data: agent });
    } catch (error) {
      res.status(400).json(this.#handleServiceError(error, 'toggle_ai_agent_status'));
    }
  }

  async deleteAiAgent(req, res) {
    try {
      const ispId = req.ispId;
      const id = parseInt(req.params.id, 10);
      const agentService = new AsteriskAiAgentService(ispId, this.prisma);
      const result = await agentService.deleteAgent(id);

      await logAudit(this.prisma, req.user?.id, 'DELETE_AI_AGENT', { id }, req);
      res.json(result);
    } catch (error) {
      res.status(400).json(this.#handleServiceError(error, 'delete_ai_agent'));
    }
  }

  async restartAiAgent(req, res) {
    try {
      const ispId = req.ispId;
      const id = parseInt(req.params.id, 10);
      const agentService = new AsteriskAiAgentService(ispId, this.prisma);
      await agentService.restartService(id);

      // Wait briefly for state transition
      await new Promise(resolve => setTimeout(resolve, 500));

      const health = await agentService.getAgentHealth(id);

      await logAudit(this.prisma, req.user?.id, 'RESTART_AI_AGENT', { id }, req);
      res.json({
        success: true,
        data: {
          agentId: id,
          operation: 'restart',
          serviceStatus: health.serviceStatus,
          socketStatus: health.socketStatus,
          dialplanStatus: health.dialplanStatus,
          runtimeStatus: health.runtimeStatus
        }
      });
    } catch (error) {
      if (error.code === 'PROVISIONING_NOT_CONFIGURED' || error.message?.includes('not configured')) {
        return res.status(400).json({ success: false, connected: false, code: error.code || 'SERVICE_DISCONNECTED', message: 'Asterisk provisioning is not configured. Please configure in Service Integrations.' });
      }
      res.status(400).json(this.#handleServiceError(error, 'restart_ai_agent'));
    }
  }

  async startAiAgent(req, res) {
    try {
      const ispId = req.ispId;
      const id = parseInt(req.params.id, 10);
      const agentService = new AsteriskAiAgentService(ispId, this.prisma);
      await agentService.startService(id);

      // Wait briefly for state transition
      await new Promise(resolve => setTimeout(resolve, 500));

      const health = await agentService.getAgentHealth(id);

      await logAudit(this.prisma, req.user?.id, 'START_AI_AGENT', { id }, req);
      res.json({
        success: true,
        data: {
          agentId: id,
          operation: 'start',
          serviceStatus: health.serviceStatus,
          socketStatus: health.socketStatus,
          dialplanStatus: health.dialplanStatus,
          runtimeStatus: health.runtimeStatus
        }
      });
    } catch (error) {
      if (error.code === 'PROVISIONING_NOT_CONFIGURED' || error.message?.includes('not configured')) {
        return res.status(400).json({ success: false, connected: false, code: error.code || 'SERVICE_DISCONNECTED', message: 'Asterisk provisioning is not configured. Please configure in Service Integrations.' });
      }
      res.status(400).json(this.#handleServiceError(error, 'start_ai_agent'));
    }
  }

  async stopAiAgent(req, res) {
    try {
      const ispId = req.ispId;
      const id = parseInt(req.params.id, 10);
      const agentService = new AsteriskAiAgentService(ispId, this.prisma);
      await agentService.stopService(id);

      // Wait briefly for state transition
      await new Promise(resolve => setTimeout(resolve, 500));

      const health = await agentService.getAgentHealth(id);

      await logAudit(this.prisma, req.user?.id, 'STOP_AI_AGENT', { id }, req);
      res.json({
        success: true,
        data: {
          agentId: id,
          operation: 'stop',
          serviceStatus: health.serviceStatus,
          socketStatus: health.socketStatus,
          dialplanStatus: health.dialplanStatus,
          runtimeStatus: health.runtimeStatus
        }
      });
    } catch (error) {
      if (error.code === 'PROVISIONING_NOT_CONFIGURED' || error.message?.includes('not configured')) {
        return res.status(400).json({ success: false, connected: false, code: error.code || 'SERVICE_DISCONNECTED', message: 'Asterisk provisioning is not configured. Please configure in Service Integrations.' });
      }
      res.status(400).json(this.#handleServiceError(error, 'stop_ai_agent'));
    }
  }

  async testAiAgentHealth(req, res) {
    try {
      const ispId = req.ispId;
      const id = parseInt(req.params.id, 10);
      const agentService = new AsteriskAiAgentService(ispId, this.prisma);
      const health = await agentService.getAgentHealth(id);
      res.json({ success: true, data: health });
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'test_ai_agent'));
    }
  }

  async callAiAgent(req, res) {
    try {
      const ispId = req.ispId;
      const id = parseInt(req.params.id, 10);
      const agentService = new AsteriskAiAgentService(ispId, this.prisma);
      const agent = await agentService.getAgent(id);
      if (!agent) {
        return res.status(404).json({ success: false, error: 'Agent not found' });
      }

      const body = req.body || {};
      const sourceExtension = body.sourceExtension || '1001';

      const service = await AsteriskService.create(ispId, this.prisma);
      const result = await service.makeCall(sourceExtension, agent.extension);
      if (!result.success) {
        return res.status(400).json(result);
      }
      res.json(result);
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'call_ai_agent'));
    }
  }

  // ==================== TRUNKS ====================
  async listTrunks(req, res) {
    try {
      const ispId = req.ispId;
      const service = await AsteriskService.create(ispId, this.prisma);
      const result = await service.listTrunks();
      res.json(result);
    } catch (error) {
      res.json({
        success: true,
        connected: false,
        data: [],
        total: 0,
        message: 'Asterisk service not configured or connected'
      });
    }
  }

  async getTrunk(req, res) {
    try {
      const ispId = req.ispId;
      const id = parseInt(req.params.id, 10);
      const trunk = await this.prisma.asteriskTrunk.findFirst({
        where: { id, ispId }
      });
      if (!trunk) {
        return res.status(404).json({ success: false, error: 'Trunk not found' });
      }
      res.json({ success: true, data: trunk });
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'get_trunk'));
    }
  }

  async getTrunksFromDB(req, res) {
    try {
      const ispId = req.ispId;
      const trunks = await this.prisma.asteriskTrunk.findMany({
        where: {
          ispId,
          isActive: true,
          isDeleted: false
        },
        orderBy: { trunkname: 'asc' }
      });
      res.json({
        success: true,
        data: trunks,
        total: trunks.length,
        message: `${trunks.length} trunks found in database`
      });
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'get_trunks_from_db'));
    }
  }

  async createTrunk(req, res) {
    try {
      const ispId = req.ispId;
      const { trunkname, host, port, username, password } = req.body;
      if (!trunkname || !host) {
        return res.status(400).json({ success: false, error: 'Trunk name and Host are required' });
      }

      const trunkId = `${ispId}_${trunkname}`;
      const existing = await this.prisma.asteriskTrunk.findUnique({
        where: { trunkId }
      });
      if (existing) {
        return res.status(409).json({ success: false, error: 'Trunk name already exists' });
      }

      const trunk = await this.prisma.asteriskTrunk.create({
        data: {
          ispId,
          trunkId,
          pbxTrunkId: trunkname,
          trunkname,
          host,
          port: port || '5060',
          username,
          password
        }
      });

      await logAudit(this.prisma, req.user?.id, 'CREATE_TRUNK', { trunkname }, req);
      res.status(201).json({ success: true, data: trunk });
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'create_trunk'));
    }
  }

  async updateTrunk(req, res) {
    try {
      const ispId = req.ispId;
      const id = parseInt(req.params.id, 10);
      const { trunkname, host, port, username, password } = req.body;

      const trunk = await this.prisma.asteriskTrunk.update({
        where: { id },
        data: { trunkname, host, port, username, password }
      });

      await logAudit(this.prisma, req.user?.id, 'UPDATE_TRUNK', { id }, req);
      res.json({ success: true, data: trunk });
    } catch (error) {
      res.status(400).json(this.#handleServiceError(error, 'update_trunk'));
    }
  }

  async deleteTrunk(req, res) {
    try {
      const ispId = req.ispId;
      const id = parseInt(req.params.id, 10);
      await this.prisma.asteriskTrunk.delete({
        where: { id }
      });

      await logAudit(this.prisma, req.user?.id, 'DELETE_TRUNK', { id }, req);
      res.json({ success: true });
    } catch (error) {
      res.status(400).json(this.#handleServiceError(error, 'delete_trunk'));
    }
  }

  // ==================== INBOUND & OUTBOUND ROUTES ====================
  async listInboundRoutes(req, res) {
    try {
      const ispId = req.ispId;
      const routes = await this.prisma.asteriskInboundRoute.findMany({
        where: { ispId }
      });
      res.json({ success: true, data: routes });
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'list_inbound_routes'));
    }
  }

  async createInboundRoute(req, res) {
    try {
      const ispId = req.ispId;
      const route = await this.prisma.asteriskInboundRoute.create({
        data: { ...req.body, ispId }
      });
      await logAudit(this.prisma, req.user?.id, 'CREATE_INBOUND_ROUTE', { routeName: req.body.routeName }, req);
      res.status(201).json({ success: true, data: route });
    } catch (error) {
      res.status(400).json(this.#handleServiceError(error, 'create_inbound_route'));
    }
  }

  async updateInboundRoute(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      const route = await this.prisma.asteriskInboundRoute.update({
        where: { id },
        data: req.body
      });
      res.json({ success: true, data: route });
    } catch (error) {
      res.status(400).json(this.#handleServiceError(error, 'update_inbound_route'));
    }
  }

  async deleteInboundRoute(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      await this.prisma.asteriskInboundRoute.delete({ where: { id } });
      res.json({ success: true });
    } catch (error) {
      res.status(400).json(this.#handleServiceError(error, 'delete_inbound_route'));
    }
  }

  async listOutboundRoutes(req, res) {
    try {
      const ispId = req.ispId;
      const routes = await this.prisma.asteriskOutboundRoute.findMany({
        where: { ispId }
      });
      res.json({ success: true, data: routes });
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'list_outbound_routes'));
    }
  }

  async createOutboundRoute(req, res) {
    try {
      const ispId = req.ispId;
      const route = await this.prisma.asteriskOutboundRoute.create({
        data: { ...req.body, ispId }
      });
      res.status(201).json({ success: true, data: route });
    } catch (error) {
      res.status(400).json(this.#handleServiceError(error, 'create_outbound_route'));
    }
  }

  async updateOutboundRoute(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      const route = await this.prisma.asteriskOutboundRoute.update({
        where: { id },
        data: req.body
      });
      res.json({ success: true, data: route });
    } catch (error) {
      res.status(400).json(this.#handleServiceError(error, 'update_outbound_route'));
    }
  }

  async deleteOutboundRoute(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      await this.prisma.asteriskOutboundRoute.delete({ where: { id } });
      res.json({ success: true });
    } catch (error) {
      res.status(400).json(this.#handleServiceError(error, 'delete_outbound_route'));
    }
  }

  async simulateOutboundRoute(req, res) {
    try {
      const ispId = req.ispId;
      const { number, sourceExtension } = req.body;
      if (!number) {
        return res.status(400).json({ success: false, error: 'Destination number is required' });
      }
      const service = await AsteriskService.create(ispId, this.prisma);
      const simulation = await service.simulateOutboundRoute(number, sourceExtension);
      res.json(simulation);
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'simulate_outbound_route'));
    }
  }

  // ==================== CALL CONTROL ====================
  async makeCall(req, res) {
    try {
      const ispId = req.ispId;
      if (!req.body) {
        return res.status(400).json({
          success: false,
          error: 'Request body is required',
          message: 'Validation failed'
        });
      }

      let { extension, number } = req.body;
      extension = String(extension || '').trim();
      number = String(number || '').trim();

      const extPattern = /^[0-9]{2,10}$/;
      const destPattern = /^[0-9*#+]{2,30}$/;

      if (!extension || !number) {
        return res.status(400).json({
          success: false,
          error: 'Extension and destination number are required',
          message: 'Validation failed'
        });
      }

      if (!extPattern.test(extension)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid extension format. Must be 2-10 digits.',
          message: 'Validation failed'
        });
      }

      if (!destPattern.test(number)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid destination format. Must be 2-30 characters containing digits, *, #, or +.',
          message: 'Validation failed'
        });
      }

      const service = await AsteriskService.create(ispId, this.prisma);
      const result = await service.makeCall(extension, number);
      if (!result.success) {
        return res.status(400).json(result);
      }
      res.json(result);
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'make_call'));
    }
  }

  async hangupCall(req, res) {
    try {
      const ispId = req.ispId;
      if (!req.body) {
        return res.status(400).json({ success: false, error: 'Request body is required' });
      }

      let { channelid } = req.body;
      if (!channelid) {
        return res.status(400).json({ success: false, error: 'Channel ID is required' });
      }

      channelid = String(channelid).trim();
      if (channelid.length === 0 || channelid.length > 128) {
        return res.status(400).json({ success: false, error: 'Invalid Channel ID length' });
      }

      const service = await AsteriskService.create(ispId, this.prisma);
      const result = await service.hangupCall(channelid);
      if (!result.success) {
        return res.status(400).json(result);
      }
      res.json(result);
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'hangup_call'));
    }
  }

  async redirectCall(req, res) {
    try {
      const ispId = req.ispId;
      const { channelId, destination } = req.body;
      const service = await AsteriskService.create(ispId, this.prisma);
      const result = await service.redirectCall(channelId, destination);
      res.json(result);
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'redirect_call'));
    }
  }

  async muteCall(req, res) {
    try {
      const ispId = req.ispId;
      const { channelId } = req.body;
      const service = await AsteriskService.create(ispId, this.prisma);
      const result = await service.muteCall(channelId);
      res.json(result);
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'mute_call'));
    }
  }

  async unmuteCall(req, res) {
    try {
      const ispId = req.ispId;
      const { channelId } = req.body;
      const service = await AsteriskService.create(ispId, this.prisma);
      const result = await service.unmuteCall(channelId);
      res.json(result);
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'unmute_call'));
    }
  }

  async startRecording(req, res) {
    try {
      const ispId = req.ispId;
      const { channelId } = req.body;
      const service = await AsteriskService.create(ispId, this.prisma);
      const result = await service.startRecording(channelId);
      res.json(result);
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'start_recording'));
    }
  }

  async stopRecording(req, res) {
    try {
      const ispId = req.ispId;
      const { channelId } = req.body;
      const service = await AsteriskService.create(ispId, this.prisma);
      const result = await service.stopRecording(channelId);
      res.json(result);
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'stop_recording'));
    }
  }

  // ==================== ACTIVE CALL DETAILS ====================
  async getActiveCalls(req, res) {
    try {
      const ispId = req.ispId;
      const service = await AsteriskService.create(ispId, this.prisma);
      const result = await service.getActiveCalls();
      res.json(result);
    } catch (error) {
      res.json({
        success: true,
        connected: false,
        data: [],
        total: 0,
        message: 'Asterisk service not configured or connected'
      });
    }
  }

  async getActiveCallDetails(req, res) {
    try {
      const ispId = req.ispId;
      const { channelId } = req.params;
      const service = await AsteriskService.create(ispId, this.prisma);
      const calls = await service.getActiveCalls();
      const call = calls.data.find(c => c.channelId === channelId);
      if (!call) {
        return res.status(404).json({ success: false, error: 'Active channel not found' });
      }
      res.json({ success: true, data: call });
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'get_active_call_details'));
    }
  }

  // ==================== CALL DETAIL RECORDS ====================
  async getCallLogs(req, res) {
    try {
      const ispId = req.ispId;
      const service = await AsteriskService.create(ispId, this.prisma);
      const result = await service.listCallLogs(req.query);
      res.json(result);
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'get_call_logs'));
    }
  }

  // ==================== QUEUES, RING GROUPS, IVR ====================
  async listQueues(req, res) {
    try {
      const queues = await this.prisma.asteriskQueue.findMany({ where: { ispId: req.ispId } });
      res.json({ success: true, data: queues });
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'list_queues'));
    }
  }

  async createQueue(req, res) {
    try {
      const queue = await this.prisma.asteriskQueue.create({ data: { ...req.body, ispId: req.ispId } });
      res.status(201).json({ success: true, data: queue });
    } catch (error) {
      res.status(400).json(this.#handleServiceError(error, 'create_queue'));
    }
  }

  async updateQueue(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      const queue = await this.prisma.asteriskQueue.update({ where: { id }, data: req.body });
      res.json({ success: true, data: queue });
    } catch (error) {
      res.status(400).json(this.#handleServiceError(error, 'update_queue'));
    }
  }

  async deleteQueue(req, res) {
    try {
      await this.prisma.asteriskQueue.delete({ where: { id: parseInt(req.params.id, 10) } });
      res.json({ success: true });
    } catch (error) {
      res.status(400).json(this.#handleServiceError(error, 'delete_queue'));
    }
  }

  async listRingGroups(req, res) {
    try {
      const groups = await this.prisma.asteriskRingGroup.findMany({ where: { ispId: req.ispId } });
      res.json({ success: true, data: groups });
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'list_ring_groups'));
    }
  }

  async createRingGroup(req, res) {
    try {
      const group = await this.prisma.asteriskRingGroup.create({ data: { ...req.body, ispId: req.ispId } });
      res.status(201).json({ success: true, data: group });
    } catch (error) {
      res.status(400).json(this.#handleServiceError(error, 'create_ring_group'));
    }
  }

  async updateRingGroup(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      const group = await this.prisma.asteriskRingGroup.update({ where: { id }, data: req.body });
      res.json({ success: true, data: group });
    } catch (error) {
      res.status(400).json(this.#handleServiceError(error, 'update_ring_group'));
    }
  }

  async deleteRingGroup(req, res) {
    try {
      await this.prisma.asteriskRingGroup.delete({ where: { id: parseInt(req.params.id, 10) } });
      res.json({ success: true });
    } catch (error) {
      res.status(400).json(this.#handleServiceError(error, 'delete_ring_group'));
    }
  }

  async listIvrs(req, res) {
    try {
      const ivrs = await this.prisma.asteriskIvr.findMany({ where: { ispId: req.ispId } });
      res.json({ success: true, data: ivrs });
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'list_ivrs'));
    }
  }

  async createIvr(req, res) {
    try {
      const ivr = await this.prisma.asteriskIvr.create({ data: { ...req.body, ispId: req.ispId } });
      res.status(201).json({ success: true, data: ivr });
    } catch (error) {
      res.status(400).json(this.#handleServiceError(error, 'create_ivr'));
    }
  }

  async updateIvr(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      const ivr = await this.prisma.asteriskIvr.update({ where: { id }, data: req.body });
      res.json({ success: true, data: ivr });
    } catch (error) {
      res.status(400).json(this.#handleServiceError(error, 'update_ivr'));
    }
  }

  async deleteIvr(req, res) {
    try {
      await this.prisma.asteriskIvr.delete({ where: { id: parseInt(req.params.id, 10) } });
      res.json({ success: true });
    } catch (error) {
      res.status(400).json(this.#handleServiceError(error, 'delete_ivr'));
    }
  }

  // ==================== RECORDINGS ====================
  async listRecordings(req, res) {
    try {
      const recs = await this.prisma.asteriskRecording.findMany({ where: { ispId: req.ispId } });
      res.json({ success: true, data: recs });
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'list_recordings'));
    }
  }

  async downloadRecording(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      const rec = await this.prisma.asteriskRecording.findFirst({ where: { id, ispId: req.ispId } });
      if (!rec) {
        return res.status(404).json({ success: false, error: 'Recording not found' });
      }
      res.setHeader('Content-Disposition', `attachment; filename="${rec.fileName}"`);
      res.sendFile(rec.filePath);
    } catch (error) {
      res.status(500).json(this.#handleServiceError(error, 'download_recording'));
    }
  }

  async deleteRecording(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      await this.prisma.asteriskRecording.delete({ where: { id } });
      res.json({ success: true });
    } catch (error) {
      res.status(400).json(this.#handleServiceError(error, 'delete_recording'));
    }
  }
}

module.exports = AsteriskController;
