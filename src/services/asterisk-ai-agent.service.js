const net = require('net');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const AI_AGENT_TEMPLATES = [
  {
    name: 'General Assistant',
    description: 'General conversational voice assistant for handling standard customer inquiries.',
    prompt: 'You are a general voice assistant for Kashtrix. Speak naturally and help customers with basic information.'
  },
  {
    name: 'Kashtrix Sales',
    description: 'Sales assistant helping with package plans, billing options, and service signups.',
    prompt: 'You are the Kashtrix Sales Assistant. Promote our high-speed internet packages and assist with signup queries.'
  },
  {
    name: 'Kashtrix Technical Support',
    description: 'Technical support assistant assisting with ONT reboots, connection issues, and router setups.',
    prompt: 'You are the Kashtrix Technical Support Assistant. Guide users through troubleshooting connection issues.'
  },
  {
    name: 'Billing Assistant',
    description: 'Handles billing queries, payment status checks, and discount requests.',
    prompt: 'You are the Kashtrix Billing Assistant. Answer questions regarding bills, payments, and discounts.'
  },
  {
    name: 'NOC Assistant',
    description: 'Assists network operations staff with alarms, routes, and BNG/OLT connectivity states.',
    prompt: 'You are the NOC Assistant. Retrieve and report critical alarms or routing configurations.'
  },
  {
    name: 'OLT/ONT Assistant',
    description: 'Retrieves optical rx power, rebooting ONTs, and status summaries.',
    prompt: 'You are the OLT/ONT Assistant. Assist with retrieving optical info and rebooting subscriber ONTs.'
  },
  {
    name: 'Customer-Care Assistant',
    description: 'Customer care executive for routing support tickets and scheduling visits.',
    prompt: 'You are the Customer Care assistant. Open tickets, check status, and route to field operations.'
  },
  {
    name: 'Ticket Assistant',
    description: 'Dedicated ticket routing, creation, and dispatching agent.',
    prompt: 'You are the Ticket Assistant. Record user complaints, create tickets, and assign technician visits.'
  },
  {
    name: 'Field-Operations Assistant',
    description: 'Coordinates scheduling, tickets, and location metadata for field technicians.',
    prompt: 'You are the Field Operations Assistant. Coordinate visit scheduling and technician updates.'
  }
];

class AsteriskAiAgentService {
  #prisma = null;
  #ispId = null;

  constructor(ispId, prisma) {
    this.#ispId = ispId;
    this.#prisma = prisma;
  }

  static getTemplates() {
    return AI_AGENT_TEMPLATES;
  }

  async syncDefaultAgents() {
    const defaults = [
      {
        extension: "5000",
        name: "Kisan Net ISP Support AI Agent",
        description: "Existing Kisan Net ISP Support AI Agent connecting via AudioSocket",
        provider: "gemini_live",
        model: "gemini-3.1-flash-live-preview",
        voice: "Kore",
        prompt: "You are the Kisan Net ISP Support AI Agent. Assist subscribers with support in Nepali.",
        audioSocketHost: "127.0.0.1",
        audioSocketPort: 9030,
        serviceName: "kisannet-voice-agent",
        systemdServiceName: "kisannet-voice-agent",
        runtimePath: "/opt/gemini-voice-agent/kisannet_agent.py",
        promptFilePath: "/opt/gemini-voice-agent/kisannet_prompt.txt",
        enabled: true,
        dialplanContext: "internal",
        managedByProvisioning: true,
        dialplanStatus: "deployed"
      },
      {
        extension: "800",
        name: "General Gemini Agent",
        description: "General-purpose Gemini Live voice assistant",
        provider: "gemini_live",
        model: "gemini-2.5-flash",
        voice: "Kore",
        prompt: "You are a general voice assistant for Kashtrix. Speak naturally and help customers with basic information.",
        audioSocketHost: "127.0.0.1",
        audioSocketPort: 9019,
        serviceName: "gemini-voice-agent",
        systemdServiceName: "gemini-voice-agent",
        enabled: true,
        dialplanContext: "internal",
        managedByProvisioning: true
      },
      {
        extension: "801",
        name: "Kashtrix AI Agent",
        description: "Kashtrix OSS/BSS sales and support voice assistant",
        provider: "gemini_live",
        model: "gemini-2.5-flash",
        voice: "Kore",
        prompt: "You are the Kashtrix AI Agent. Assist users with sales and technical support inquiries.",
        audioSocketHost: "127.0.0.1",
        audioSocketPort: 9020,
        serviceName: "kashtrix-voice-agent",
        systemdServiceName: "kashtrix-voice-agent",
        enabled: true,
        dialplanContext: "internal",
        managedByProvisioning: true
      }
    ];

    for (const item of defaults) {
      const existing = await this.#prisma.asteriskAiAgent.findFirst({
        where: { ispId: this.#ispId, extension: item.extension }
      });
      const dataPayload = {
        ispId: this.#ispId,
        extension: item.extension,
        name: item.name,
        description: item.description,
        provider: item.provider,
        model: item.model,
        voice: item.voice,
        prompt: item.prompt,
        promptVersion: 1,
        audioSocketHost: item.audioSocketHost,
        audioSocketPort: item.audioSocketPort,
        serviceName: item.serviceName,
        enabled: item.enabled,
        runtimeStatus: 'stopped',
        dialplanStatus: item.dialplanStatus || 'configured',
        extensionNumber: item.extension,
        agentName: item.name,
        systemPrompt: item.prompt,
        runtimeType: 'python',
        runtimePath: item.runtimePath || null,
        promptFilePath: item.promptFilePath || null,
        virtualEnvPath: item.virtualEnvPath || null,
        systemdServiceName: item.systemdServiceName || null,
        dialplanContext: item.dialplanContext || 'internal',
        managedByProvisioning: item.managedByProvisioning !== false
      };

      if (!existing) {
        const agent = await this.#prisma.asteriskAiAgent.create({
          data: dataPayload
        });
        await this.#prisma.asteriskAiAgentPromptVersion.create({
          data: {
            ispId: this.#ispId,
            agentId: agent.id,
            version: 1,
            prompt: item.prompt
          }
        });
      } else {
        // Reconcile missing field mappings for existing records without destroying
        await this.#prisma.asteriskAiAgent.update({
          where: { id: existing.id },
          data: {
            extensionNumber: existing.extensionNumber || item.extension,
            agentName: existing.agentName || item.name,
            systemPrompt: existing.systemPrompt || item.prompt,
            runtimePath: existing.runtimePath || item.runtimePath || null,
            promptFilePath: existing.promptFilePath || item.promptFilePath || null,
            virtualEnvPath: existing.virtualEnvPath || item.virtualEnvPath || null,
            systemdServiceName: existing.systemdServiceName || item.systemdServiceName || null,
            dialplanContext: existing.dialplanContext || item.dialplanContext || 'internal'
          }
        });
      }
    }
  }

  // CRUD
  async listAgents() {
    await this.syncDefaultAgents();
    return this.#prisma.asteriskAiAgent.findMany({
      where: { ispId: this.#ispId },
      orderBy: { extension: 'asc' }
    });
  }

  async getAgent(id) {
    return this.#prisma.asteriskAiAgent.findFirst({
      where: { id, ispId: this.#ispId }
    });
  }

  async createAgent(data) {
    const ext = String(data.extension || '').trim();
    if (!/^[0-9]{2,10}$/.test(ext)) {
      throw new Error('Invalid extension format. Must be 2-10 digits.');
    }

    const existing = await this.#prisma.asteriskAiAgent.findFirst({
      where: { ispId: this.#ispId, extension: ext }
    });
    if (existing) {
      throw new Error(`AI Agent extension ${ext} is already in use`);
    }

    const prov = await require('./asterisk-ai-agent-provisioning.service').getService(this.#ispId, this.#prisma);
    let provRes = null;
    if (prov.isConfigured()) {
      provRes = await prov.createAgentConfiguration({
        extension: ext,
        name: data.name || data.agentName,
        agentName: data.name || data.agentName,
        dialplanContext: data.context || data.dialplanContext || 'internal',
        audioSocketHost: data.audioSocketHost || '127.0.0.1',
        audioSocketPort: data.audioSocketPort,
        enabled: data.enabled !== false
      });
    }

    const agent = await this.#prisma.asteriskAiAgent.create({
      data: {
        ispId: this.#ispId,
        extension: ext,
        name: data.name || data.agentName || 'AI Voice Agent',
        description: data.description,
        provider: data.provider || 'gemini_live',
        model: data.model || 'gemini-2.5-flash',
        voice: data.voice || 'Kore',
        languageMode: data.languageMode || 'automatic',
        prompt: data.prompt || 'You are a helpful assistant.',
        promptVersion: 1,
        audioSocketHost: data.audioSocketHost || '127.0.0.1',
        audioSocketPort: parseInt(data.audioSocketPort, 10),
        serviceName: data.serviceName || `ai-agent-${ext}`,
        enabled: data.enabled !== false,
        runtimeStatus: 'stopped',
        dialplanStatus: provRes?.verified ? 'deployed' : (prov.isConfigured() ? 'configured' : 'unverified'),
        extensionNumber: ext,
        agentName: data.name || data.agentName || 'AI Voice Agent',
        systemPrompt: data.prompt || 'You are a helpful assistant.',
        runtimeType: 'python',
        systemdServiceName: data.serviceName || `ai-agent-${ext}`,
        dialplanContext: data.context || data.dialplanContext || 'internal',
        managedByProvisioning: true
      }
    });

    await this.#prisma.asteriskAiAgentPromptVersion.create({
      data: {
        ispId: this.#ispId,
        agentId: agent.id,
        version: 1,
        prompt: agent.prompt
      }
    });

    return agent;
  }

  async updateAgent(id, data) {
    const agent = await this.getAgent(id);
    if (!agent) {
      throw new Error('AI Agent not found');
    }

    const previousExtension = agent.extension;
    const newExtension = data.extension ? String(data.extension).trim() : agent.extension;

    let nextVersion = agent.promptVersion;
    if (data.prompt && data.prompt !== agent.prompt) {
      nextVersion += 1;
      await this.#prisma.asteriskAiAgentPromptVersion.create({
        data: {
          ispId: this.#ispId,
          agentId: agent.id,
          version: nextVersion,
          prompt: data.prompt
        }
      });
    }

    const updated = await this.#prisma.asteriskAiAgent.update({
      where: { id },
      data: {
        extension: newExtension,
        name: data.name || data.agentName || agent.name,
        description: data.description !== undefined ? data.description : agent.description,
        model: data.model || agent.model,
        voice: data.voice || agent.voice,
        prompt: data.prompt || agent.prompt,
        promptVersion: nextVersion,
        enabled: data.enabled !== undefined ? Boolean(data.enabled) : agent.enabled,
        audioSocketPort: data.audioSocketPort ? parseInt(data.audioSocketPort, 10) : agent.audioSocketPort,
        audioSocketHost: data.audioSocketHost || agent.audioSocketHost,
        extensionNumber: newExtension,
        agentName: data.name || data.agentName || agent.name,
        systemPrompt: data.prompt || agent.prompt,
        dialplanContext: data.context || data.dialplanContext || agent.dialplanContext || 'internal'
      }
    });

    const prov = await require('./asterisk-ai-agent-provisioning.service').getService(this.#ispId, this.#prisma);
    if (prov.isConfigured()) {
      await prov.updateAgentConfiguration(updated, previousExtension);
    }

    return updated;
  }

  async deleteAgent(id) {
    const agent = await this.getAgent(id);
    if (!agent) {
      throw new Error('AI Agent not found');
    }

    const prov = await require('./asterisk-ai-agent-provisioning.service').getService(this.#ispId, this.#prisma);
    if (prov.isConfigured()) {
      await prov.removeDialplanDestination(agent.extension);
    }

    await this.#prisma.asteriskAiAgent.delete({
      where: { id }
    });

    return { success: true };
  }

  async cloneAgent(id, newExtension) {
    const agent = await this.getAgent(id);
    if (!agent) {
      throw new Error('AI Agent not found');
    }
    const clonedData = {
      ...agent,
      id: undefined,
      extension: newExtension,
      name: `${agent.name} (Clone)`,
      createdAt: undefined,
      updatedAt: undefined
    };
    return this.createAgent(clonedData);
  }

  // Multi-layer server-side health checks
  async getAgentHealth(id) {
    const agent = await this.getAgent(id);
    if (!agent) {
      return {
        databaseStatus: 'missing',
        dialplanStatus: 'unavailable',
        socketStatus: 'unknown',
        serviceStatus: 'unknown',
        runtimeStatus: 'stopped',
        extensionStatus: 'offline',
        promptFileStatus: 'missing',
        runtimeFileStatus: 'missing',
        lastError: 'Agent not found in database',
        checkedAt: new Date().toISOString()
      };
    }

    const prov = await require('./asterisk-ai-agent-provisioning.service').getService(this.#ispId, this.#prisma);
    const adapter = prov.getAdapter();

    let databaseStatus = 'configured';
    if (!agent.extension || !agent.audioSocketPort) {
      databaseStatus = 'incomplete';
    }

    let dialplanStatus = 'unavailable';
    let socketStatus = 'unknown';
    let serviceStatus = 'unknown';
    let promptFileStatus = 'configured';
    let runtimeFileStatus = 'configured';
    let lastError = null;

    if (prov.isConfigured() && adapter) {
      try {
        const cmdRes = await adapter.runAsteriskCli(['dialplan', 'show', `${agent.extension}@${agent.dialplanContext || 'internal'}`]);
        if (cmdRes.includes('AudioSocket')) {
          if (cmdRes.includes(`:${agent.audioSocketPort}`)) {
            dialplanStatus = 'verified';
          } else {
            dialplanStatus = 'mismatch';
          }
        } else {
          dialplanStatus = 'missing';
        }
      } catch (err) {
        const isCliUnavailable = err.message.includes('not found') || 
                                 err.message.includes('not recognized') || 
                                 err.message.includes('ENOENT') || 
                                 process.platform === 'win32';
        dialplanStatus = isCliUnavailable ? 'unavailable' : 'missing';
        lastError = err.message;
      }
    }

    if (prov.isConfigured() && adapter) {
      try {
        const isListening = await adapter.isPortListening(agent.audioSocketHost || '127.0.0.1', agent.audioSocketPort);
        socketStatus = isListening ? 'listening' : 'stopped';
      } catch (err) {
        socketStatus = 'unreachable';
      }
    } else {
      const isListening = (await this.checkPortStatus(agent.audioSocketHost || '127.0.0.1', agent.audioSocketPort)) === 'running';
      socketStatus = isListening ? 'listening' : 'stopped';
    }

    const targetService = agent.systemdServiceName || agent.serviceName;
    if (!targetService) {
      serviceStatus = 'service mapping required';
    } else if (prov.isConfigured() && adapter) {
      try {
        const status = await adapter.getServiceStatus(targetService);
        if (status === 'active' || status === 'running') {
          serviceStatus = 'running';
        } else if (status === 'inactive' || status === 'stopped') {
          serviceStatus = 'stopped';
        } else if (status === 'failed') {
          serviceStatus = 'failed';
        } else {
          serviceStatus = socketStatus === 'listening' ? 'running' : 'stopped';
        }
      } catch (err) {
        serviceStatus = socketStatus === 'listening' ? 'running' : 'stopped';
      }
    } else {
      serviceStatus = socketStatus === 'listening' ? 'running' : 'stopped';
    }

    if (prov.isConfigured() && adapter) {
      if (agent.promptFilePath) {
        try {
          const exists = await adapter.fileExists(agent.promptFilePath);
          promptFileStatus = exists ? 'verified' : 'missing';
        } catch (e) {
          promptFileStatus = 'missing';
        }
      }
      if (agent.runtimePath) {
        try {
          const exists = await adapter.fileExists(agent.runtimePath);
          runtimeFileStatus = exists ? 'verified' : 'missing';
        } catch (e) {
          runtimeFileStatus = 'missing';
        }
      }
    }

    let extensionStatus = 'offline';
    try {
      const asterService = await require('./asterisk.service').create(this.#ispId, this.#prisma);
      const extInfo = await asterService.getExtension(agent.extension);
      if (extInfo && extInfo.status === 'Registered') {
        extensionStatus = 'online';
      }
    } catch (e) {}

    let runtimeStatus = 'degraded';
    if (serviceStatus === 'service mapping required') {
      runtimeStatus = 'misconfigured';
    } else if (promptFileStatus === 'missing' || runtimeFileStatus === 'missing') {
      runtimeStatus = 'misconfigured';
    } else if (socketStatus === 'listening' && (serviceStatus === 'running' || serviceStatus === 'active') && (dialplanStatus === 'verified' || dialplanStatus === 'unavailable')) {
      runtimeStatus = 'healthy';
    } else if (socketStatus === 'listening' && (dialplanStatus === 'verified' || dialplanStatus === 'unavailable')) {
      runtimeStatus = 'healthy';
    } else if (socketStatus === 'stopped' && (serviceStatus === 'stopped' || serviceStatus === 'inactive') && !agent.enabled) {
      runtimeStatus = 'stopped';
    }

    return {
      databaseStatus,
      dialplanStatus,
      socketStatus,
      serviceStatus,
      runtimeStatus,
      extensionStatus,
      promptFileStatus,
      runtimeFileStatus,
      lastError,
      checkedAt: new Date().toISOString()
    };
  }

  // Runtime Controls
  async startService(id) {
    const agent = await this.getAgent(id);
    if (!agent) throw new Error('Agent not found');

    const prov = await require('./asterisk-ai-agent-provisioning.service').getService(this.#ispId, this.#prisma);
    if (!prov.isConfigured()) {
      const err = new Error('AI-agent provisioning is not configured for this ISP');
      err.code = 'PROVISIONING_NOT_CONFIGURED';
      throw err;
    }
    const targetService = agent.systemdServiceName || agent.serviceName;
    if (!targetService) throw new Error('Service mapping required');
    return prov.startRuntime(targetService);
  }

  async stopService(id) {
    const agent = await this.getAgent(id);
    if (!agent) throw new Error('Agent not found');

    const prov = await require('./asterisk-ai-agent-provisioning.service').getService(this.#ispId, this.#prisma);
    if (!prov.isConfigured()) {
      const err = new Error('AI-agent provisioning is not configured for this ISP');
      err.code = 'PROVISIONING_NOT_CONFIGURED';
      throw err;
    }
    const targetService = agent.systemdServiceName || agent.serviceName;
    if (!targetService) throw new Error('Service mapping required');
    return prov.stopRuntime(targetService);
  }

  async restartService(id) {
    const agent = await this.getAgent(id);
    if (!agent) throw new Error('Agent not found');

    const prov = await require('./asterisk-ai-agent-provisioning.service').getService(this.#ispId, this.#prisma);
    if (!prov.isConfigured()) {
      const err = new Error('AI-agent provisioning is not configured for this ISP');
      err.code = 'PROVISIONING_NOT_CONFIGURED';
      throw err;
    }
    const targetService = agent.systemdServiceName || agent.serviceName;
    if (!targetService) throw new Error('Service mapping required');
    return prov.restartRuntime(targetService);
  }

  async checkPortStatus(host, port) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(1000);
      socket.connect(port, host, () => {
        socket.destroy();
        resolve('running');
      });
      socket.on('error', () => {
        resolve('stopped');
      });
      socket.on('timeout', () => {
        socket.destroy();
        resolve('stopped');
      });
    });
  }
}

module.exports = AsteriskAiAgentService;
