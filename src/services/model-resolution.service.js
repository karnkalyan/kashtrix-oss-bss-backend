/**
 * ModelResolutionService
 * 
 * Ensures consistent AI model selection across chat, tasks, and agent operations.
 * Enforces the fallback hierarchy:
 *   1. Task-specific model override (e.g. from task.input.modelOverride)
 *   2. Agent-selected model (agent.modelName)
 *   3. Tenant AI default model (from ISPService GEMINI/OpenAI config)
 *   4. Provider default model (from env vars)
 *   5. Fallback model (safe-fallback if tenant policy permits)
 * 
 * Also logs token usage, costs, and fallback selections.
 */

const MODEL_DEFAULTS = {
  gemini: 'gemini-2.5-flash',
  openai: 'gpt-4.1-mini',
  'safe-fallback': 'verified-local-v1'
};

const PROVIDER_PRIORITY = ['gemini', 'openai', 'safe-fallback'];

/**
 * Resolve the AI model to use for a given request context.
 * @param {object} options
 * @param {object} options.prisma - Prisma client
 * @param {number} options.ispId - Tenant ISP ID
 * @param {object} [options.agent] - AI Agent record (may have modelProvider, modelName)
 * @param {object} [options.task] - AI Agent Task record (may have input.modelOverride)
 * @param {string} [options.context] - 'chat' | 'task' | 'intent' | 'tool-call'
 * @returns {{ provider: string, model: string, source: string, fallbackReason?: string }}
 */
async function resolveModel({ prisma, ispId, agent, task, context = 'chat' }) {
  // 1. Task-specific model override
  if (task?.input?.modelOverride) {
    const override = task.input.modelOverride;
    if (typeof override === 'string' && override.trim() && override !== 'default') {
      return {
        provider: detectProviderFromModel(override),
        model: override.trim(),
        source: 'task-override'
      };
    }
  }

  // 2. Agent-selected model
  if (agent?.modelName && agent.modelName !== 'default') {
    const provider = agent.modelProvider || detectProviderFromModel(agent.modelName);
    return {
      provider,
      model: agent.modelName,
      source: 'agent-config'
    };
  }

  // 3. Tenant AI default model (from ISPService configuration)
  const tenantConfig = await getTenantAiConfig(prisma, ispId);
  if (tenantConfig) {
    return {
      provider: tenantConfig.provider,
      model: tenantConfig.model,
      source: 'tenant-config'
    };
  }

  // 4. Provider default model (from environment variables)
  const envProvider = getEnvProvider();
  if (envProvider) {
    return {
      provider: envProvider.provider,
      model: envProvider.model,
      source: 'env-default'
    };
  }

  // 5. Fallback model
  return {
    provider: 'safe-fallback',
    model: MODEL_DEFAULTS['safe-fallback'],
    source: 'fallback',
    fallbackReason: 'No configured AI provider found'
  };
}

/**
 * Detect provider type from model name string.
 */
function detectProviderFromModel(modelName) {
  const name = String(modelName || '').toLowerCase();
  if (/^gemini/i.test(name)) return 'gemini';
  if (/^gpt|^o[1-4]|^chatgpt/i.test(name)) return 'openai';
  if (/^claude/i.test(name)) return 'anthropic';
  if (/^llama|^mixtral|^mistral/i.test(name)) return 'openai'; // served via OpenAI-compatible API
  return 'openai'; // default to OpenAI-compatible for unknown models
}

/**
 * Get tenant-level AI configuration from ISPService records.
 */
async function getTenantAiConfig(prisma, ispId) {
  if (!prisma || !ispId) return null;
  try {
    // Check for active Gemini service first
    const geminiService = await prisma.iSPService.findFirst({
      where: {
        ispId,
        isDeleted: false,
        isActive: true,
        isEnabled: true,
        service: { code: 'GEMINI', isActive: true, isDeleted: false }
      },
      select: { config: true }
    });
    if (geminiService?.config && typeof geminiService.config === 'object') {
      const config = geminiService.config;
      if (config.model) {
        return { provider: 'gemini', model: config.model };
      }
    }

    // Check for OpenAI service
    const openaiService = await prisma.iSPService.findFirst({
      where: {
        ispId,
        isDeleted: false,
        isActive: true,
        isEnabled: true,
        service: { code: { in: ['OPENAI', 'OPENAI_COMPATIBLE'] }, isActive: true, isDeleted: false }
      },
      select: { config: true }
    });
    if (openaiService?.config && typeof openaiService.config === 'object') {
      const config = openaiService.config;
      if (config.model) {
        return { provider: 'openai', model: config.model };
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Get provider from environment variables.
 */
function getEnvProvider() {
  const openAiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_COMPATIBLE_API_KEY;
  if (openAiKey) {
    return {
      provider: 'openai',
      model: process.env.OPENAI_MODEL || MODEL_DEFAULTS.openai
    };
  }
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (geminiKey) {
    return {
      provider: 'gemini',
      model: MODEL_DEFAULTS.gemini
    };
  }
  return null;
}

/**
 * Log model usage for auditing and cost tracking.
 */
async function logModelUsage(prisma, { ispId, agentId, userId, resolution, usage, durationMs, context }) {
  try {
    await prisma.aiAgentUsage.create({
      data: {
        ispId,
        agentId: agentId || 0,
        userId: userId || 0,
        modelProvider: resolution.provider,
        modelName: resolution.model,
        inputTokens: usage?.inputTokens || 0,
        outputTokens: usage?.outputTokens || 0,
        totalTokens: usage?.totalTokens || 0,
        estimatedCost: usage?.estimatedCost || 0,
        durationMs: durationMs || 0
      }
    });
  } catch (error) {
    console.error('[ModelResolutionService] Failed to log usage:', error.message);
  }
}

/**
 * Validate that a provider+model combination is available.
 * Returns { available: boolean, reason?: string }
 */
async function validateModelAvailability(prisma, ispId, provider, model) {
  if (provider === 'safe-fallback') {
    return { available: true };
  }

  if (provider === 'gemini') {
    const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (key) return { available: true };
    
    const tenantConfig = await getTenantAiConfig(prisma, ispId);
    if (tenantConfig?.provider === 'gemini') return { available: true };
    
    return { available: false, reason: 'No Gemini API key configured' };
  }

  if (provider === 'openai') {
    const key = process.env.OPENAI_API_KEY || process.env.OPENAI_COMPATIBLE_API_KEY;
    if (key) return { available: true };
    return { available: false, reason: 'No OpenAI API key configured' };
  }

  return { available: false, reason: `Unknown provider: ${provider}` };
}

module.exports = {
  resolveModel,
  detectProviderFromModel,
  getTenantAiConfig,
  getEnvProvider,
  logModelUsage,
  validateModelAvailability,
  MODEL_DEFAULTS,
  PROVIDER_PRIORITY
};
