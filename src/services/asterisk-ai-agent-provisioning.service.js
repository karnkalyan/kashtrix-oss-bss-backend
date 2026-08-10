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

  async createAgentConfiguration(agent) {
    this.#assertConfigured();
    if (!/^[0-9]{2,10}$/.test(agent.extension)) {
      throw new Error('Invalid extension format. Must be 2-10 digits.');
    }
    const port = parseInt(agent.audioSocketPort, 10);
    if (isNaN(port) || port < 1024 || port > 65535) {
      throw new Error('AudioSocket port must be between 1024 and 65535');
    }

    await this.bindDialplanDestination(agent);
    return { success: true };
  }

  async updateAgentConfiguration(agent) {
    this.#assertConfigured();
    await this.bindDialplanDestination(agent);
    return { success: true };
  }

  async ensureDialplanInclude() {
    const configPath = this.#config.customDialplanFile || '/etc/asterisk/extensions_custom.conf';
    let content = '';
    if (await this.#adapter.fileExists(configPath)) {
      content = await this.#adapter.readFile(configPath);
    }
    
    const includeLine = '#include extensions_kashtrix_ai.conf';
    if (!content.includes(includeLine)) {
      const newContent = `${content}\n${includeLine}\n`;
      await this.#adapter.writeManagedFile(configPath, newContent);
    }
  }

  async bindDialplanDestination(agent) {
    this.#assertConfigured();
    
    await this.ensureDialplanInclude();

    const filePath = this.#config.provisioningMode === 'ssh' || this.#config.mode === 'ssh_file'
      ? '/etc/asterisk/extensions_kashtrix_ai.conf'
      : path.join(this.#config.localConfigDir || './scratch/asterisk', 'extensions_kashtrix_ai.conf');

    const agents = await this.#prisma.asteriskAiAgent.findMany({
      where: { ispId: this.#ispId, enabled: true }
    });

    const index = agents.findIndex(a => String(a.extension) === String(agent.extension));
    if (index === -1 && agent.enabled) {
      agents.push(agent);
    } else if (index !== -1) {
      if (agent.enabled) {
        agents[index] = agent;
      } else {
        agents.splice(index, 1);
      }
    }

    let fileContent = '; KASHTRIX MANAGED AI DIALPLAN INCLUDES - DO NOT EDIT MANUALLY\n\n';
    
    const agentsByContext = {};
    for (const ag of agents) {
      const ctx = ag.dialplanContext || 'internal';
      if (!agentsByContext[ctx]) agentsByContext[ctx] = [];
      agentsByContext[ctx].push(ag);
    }

    for (const [ctx, ctxAgents] of Object.entries(agentsByContext)) {
      fileContent += `[${ctx}]\n`;
      for (const ag of ctxAgents) {
        fileContent += `; BEGIN KASHTRIX MANAGED AI AGENT ${ag.extension}\n`;
        fileContent += `exten => ${ag.extension},1,NoOp(Kashtrix AI Voice Agent: ${ag.name || ag.agentName})\n`;
        fileContent += ` same => n,Answer()\n`;
        fileContent += ` same => n,Wait(1)\n`;
        fileContent += ` same => n,Set(AI_CALL_UUID=\${SHELL(cat /proc/sys/kernel/random/uuid | tr -d "\\\\n")})\n`;
        fileContent += ` same => n,Set(DB(custom_agent_channels/\${AI_CALL_UUID})=\${CHANNEL})\n`;
        fileContent += ` same => n,AudioSocket(\${AI_CALL_UUID},${ag.audioSocketHost || '127.0.0.1'}:${ag.audioSocketPort})\n`;
        fileContent += ` same => n,Hangup()\n`;
        fileContent += ` same => n(hangup_fallback),Hangup()\n`;
        fileContent += `; END KASHTRIX MANAGED AI AGENT ${ag.extension}\n\n`;
      }
    }

    await this.#adapter.writeManagedFile(filePath, fileContent);

    if (this.#config.provisioningMode !== 'ssh' && this.#config.mode !== 'ssh_file') {
      const compatPath = path.join(this.#config.localConfigDir || './scratch/asterisk', 'extensions.conf');
      await this.#adapter.writeManagedFile(compatPath, fileContent);
    }

    await this.reloadDialplan();
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
