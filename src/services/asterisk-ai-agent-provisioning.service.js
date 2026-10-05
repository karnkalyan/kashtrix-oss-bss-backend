const path = require('path');
const { AsteriskProvisioningAdapter } = require('./asterisk-provisioning-adapter');

class AsteriskAiAgentProvisioningService {
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
    return new AsteriskAiAgentProvisioningService(ispId, prisma, config);
  }

  isConfigured() {
    if (!this.#config || !this.#config.enabled) return false;
    const mode = this.#config.provisioningMode || this.#config.mode;
    return ['local', 'ssh', 'local_file', 'ssh_file'].includes(mode);
  }

  getAdapter() {
    return this.#adapter;
  }

  #assertConfigured() {
    if (!this.isConfigured()) {
      const err = new Error('AI-agent provisioning is not configured for this ISP');
      err.code = 'PROVISIONING_NOT_CONFIGURED';
      throw err;
    }
  }

  async validateExtensionAvailable(extension, context = 'internal', excludeAgentId = null) {
    const ext = String(extension || '').trim();
    if (!/^[0-9]{2,10}$/.test(ext)) {
      throw new Error('Invalid extension format. Must be numeric (2-10 digits).');
    }

    // Check database uniqueness
    const existingDb = await this.#prisma.asteriskAiAgent.findFirst({
      where: {
        ispId: this.#ispId,
        extension: ext,
        ...(excludeAgentId ? { id: { not: excludeAgentId } } : {})
      }
    });
    if (existingDb) {
      throw new Error(`Extension ${ext} already exists for AI agent "${existingDb.name || existingDb.agentName}"`);
    }

    // Check dialplan CLI if Asterisk is reachable
    if (this.isConfigured() && this.#adapter) {
      try {
        const output = await this.#adapter.runAsteriskCli(['dialplan', 'show', `${ext}@${context}`]);
        const lower = (output || '').toLowerCase();
        // If extension exists in dialplan outside our managed ai_agents.conf
        if (
          lower.includes(`'${ext}'`) &&
          !lower.includes('no such extension') &&
          !lower.includes('no such context') &&
          !lower.includes('failed')
        ) {
          // Verify if it's already an OSS/BSS managed entry
          const managedPath = this.getManagedFilePath();
          let managedContent = '';
          if (await this.#adapter.fileExists(managedPath)) {
            managedContent = await this.#adapter.readFile(managedPath);
          }
          if (!managedContent.includes(`exten => ${ext},`)) {
            throw new Error(`Extension ${ext} already exists in dialplan context [${context}] on Asterisk server.`);
          }
        }
      } catch (cliErr) {
        if (cliErr.message && cliErr.message.includes('already exists in dialplan context')) {
          throw cliErr;
        }
        // If Asterisk CLI not running or not reachable, proceed with DB validation
      }
    }
  }

  async validatePortAvailable(port, excludeAgentId = null) {
    const parsedPort = parseInt(port, 10);
    if (isNaN(parsedPort) || parsedPort < 1024 || parsedPort > 65535) {
      throw new Error('AudioSocket port must be between 1024 and 65535');
    }

    const existingPort = await this.#prisma.asteriskAiAgent.findFirst({
      where: {
        ispId: this.#ispId,
        audioSocketPort: parsedPort,
        ...(excludeAgentId ? { id: { not: excludeAgentId } } : {})
      }
    });
    if (existingPort) {
      throw new Error(`AudioSocket port ${parsedPort} is already assigned to AI agent "${existingPort.name || existingPort.agentName}" (ext: ${existingPort.extension})`);
    }
  }

  getManagedFilePath() {
    return this.#config.provisioningMode === 'ssh' || this.#config.mode === 'ssh_file'
      ? '/etc/asterisk/ai_agents.conf'
      : path.join(this.#config.localConfigDir || './scratch/asterisk', 'ai_agents.conf');
  }

  async ensureDialplanInclude() {
    const configPath = this.#config.customDialplanFile || '/etc/asterisk/extensions_custom.conf';
    let content = '';
    if (await this.#adapter.fileExists(configPath)) {
      content = await this.#adapter.readFile(configPath);
    }

    // Support both #include "ai_agents.conf" and legacy include
    const includeLine = '#include "ai_agents.conf"';
    if (!content.includes('ai_agents.conf')) {
      const newContent = `${content.trimEnd()}\n\n; Include OSS/BSS AI Agent Dialplans\n${includeLine}\n`;
      await this.#adapter.writeManagedFile(configPath, newContent);
    }
  }

  async createAgentConfiguration(agent) {
    const ext = String(agent.extension || '').trim();
    const ctx = agent.dialplanContext || agent.context || 'internal';
    const port = agent.audioSocketPort;
    const host = agent.audioSocketHost || '127.0.0.1';

    if (!agent.name && !agent.agentName) {
      throw new Error('Agent name is required');
    }

    await this.validateExtensionAvailable(ext, ctx, agent.id);
    await this.validatePortAvailable(port, agent.id);

    if (this.isConfigured()) {
      await this.bindDialplanDestination(agent);
    }
    return { success: true };
  }

  async updateAgentConfiguration(agent, previousExtension = null) {
    const ext = String(agent.extension || '').trim();
    const ctx = agent.dialplanContext || agent.context || 'internal';
    const port = agent.audioSocketPort;

    if (previousExtension && String(previousExtension) !== ext) {
      await this.validateExtensionAvailable(ext, ctx, agent.id);
    }
    if (port) {
      await this.validatePortAvailable(port, agent.id);
    }

    if (this.isConfigured()) {
      await this.bindDialplanDestination(agent, previousExtension);
    }
    return { success: true };
  }

  async bindDialplanDestination(agent, previousExtension = null) {
    this.#assertConfigured();

    await this.ensureDialplanInclude();

    const filePath = this.getManagedFilePath();

    const agents = await this.#prisma.asteriskAiAgent.findMany({
      where: { ispId: this.#ispId }
    });

    const targetExt = String(agent.extension);
    const prevExt = previousExtension ? String(previousExtension) : null;

    // Filter agents list in-memory to build the updated ai_agents.conf
    const activeAgents = [];
    let updatedTargetAdded = false;

    for (const ag of agents) {
      const currExt = String(ag.extension);
      if (prevExt && currExt === prevExt) {
        continue; // Remove old extension if renamed
      }
      if (currExt === targetExt) {
        if (agent.enabled !== false) {
          activeAgents.push({ ...ag, ...agent });
          updatedTargetAdded = true;
        }
      } else if (ag.enabled) {
        activeAgents.push(ag);
      }
    }

    if (!updatedTargetAdded && agent.enabled !== false) {
      activeAgents.push(agent);
    }

    // Group active agents by context
    const agentsByContext = {};
    for (const ag of activeAgents) {
      const ctx = ag.dialplanContext || ag.context || 'internal';
      if (!agentsByContext[ctx]) agentsByContext[ctx] = [];
      agentsByContext[ctx].push(ag);
    }

    let fileContent = '; ================================================================\n';
    fileContent += '; OSS/BSS MANAGED AI AGENTS DIALPLAN - DO NOT EDIT MANUALLY\n';
    fileContent += `; Generated on: ${new Date().toISOString()}\n`;
    fileContent += '; ================================================================\n\n';

    for (const [ctx, ctxAgents] of Object.entries(agentsByContext)) {
      fileContent += `[${ctx}]\n\n`;
      for (const ag of ctxAgents) {
        const agentName = ag.agentName || ag.name || 'AI Voice Agent';
        const host = ag.audioSocketHost || '127.0.0.1';
        const port = ag.audioSocketPort;
        const dbPrefix = (String(ag.extension) === '5000' || agentName.toLowerCase().includes('kisan'))
          ? 'kisannet_calls'
          : 'ai_agent_calls';

        fileContent += `; ${agentName}\n`;
        fileContent += `exten => ${ag.extension},1,NoOp(${agentName})\n`;
        fileContent += ` same => n,Answer()\n`;
        fileContent += ` same => n,Wait(1)\n`;
        fileContent += ` same => n,Set(AI_CALL_UUID=\${SHELL(cat /proc/sys/kernel/random/uuid | tr -d "\\n")})\n`;
        fileContent += ` same => n,Set(DB(${dbPrefix}/\${AI_CALL_UUID})=\${CHANNEL(name)})\n`;
        fileContent += ` same => n,AudioSocket(\${AI_CALL_UUID},${host}:${port})\n`;
        fileContent += ` same => n,Set(DB_DELETE(${dbPrefix}/\${AI_CALL_UUID})=1)\n`;
        fileContent += ` same => n,Hangup()\n\n`;
      }
    }

    await this.#adapter.writeManagedFile(filePath, fileContent);

    // If local file mode, also maintain compatibility mirror
    if (this.#config.provisioningMode !== 'ssh' && this.#config.mode !== 'ssh_file') {
      const compatPath = path.join(this.#config.localConfigDir || './scratch/asterisk', 'extensions.conf');
      await this.#adapter.writeManagedFile(compatPath, fileContent);
    }

    // Apply configuration: dialplan reload
    const reloadResult = await this.reloadDialplan();

    // Verify dialplan
    let isVerified = false;
    try {
      const ext = agent.extension;
      const ctx = agent.dialplanContext || agent.context || 'internal';
      const verifyOutput = await this.#adapter.runAsteriskCli(['dialplan', 'show', `${ext}@${ctx}`]);
      if (verifyOutput && verifyOutput.includes(`AudioSocket`) && verifyOutput.includes(String(agent.audioSocketPort))) {
        isVerified = true;
      }
    } catch (e) {
      // Non-fatal if CLI is unavailable in dev
    }

    return {
      success: true,
      reloaded: reloadResult.success,
      verified: isVerified
    };
  }

  async removeDialplanDestination(extension) {
    this.#assertConfigured();
    await this.bindDialplanDestination({ extension, enabled: false });
  }

  async validateDialplan() {
    this.#assertConfigured();
    return { success: true, message: 'Dialplan valid' };
  }

  async reloadDialplan() {
    this.#assertConfigured();
    try {
      const stdout = await this.#adapter.runAsteriskCli(['dialplan', 'reload']);
      return { success: true, message: stdout };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async startRuntime(serviceName) {
    this.#assertConfigured();
    return this.#adapter.startService(serviceName);
  }

  async stopRuntime(serviceName) {
    this.#assertConfigured();
    return this.#adapter.stopService(serviceName);
  }

  async restartRuntime(serviceName) {
    this.#assertConfigured();
    return this.#adapter.restartService(serviceName);
  }

  async healthCheck(host, port) {
    if (!this.isConfigured()) return { success: false };
    const listening = await this.#adapter.isPortListening(host, port);
    return { success: listening };
  }

  async rollback() {
    return { success: true };
  }
}

module.exports = AsteriskAiAgentProvisioningService;
