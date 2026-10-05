const MODULES = Object.freeze({
  OSS_BSS: 'OSS_BSS',
  CUSTOMERS: 'CUSTOMERS',
  BILLING: 'BILLING',
  PACKAGES: 'PACKAGES',
  RADIUS: 'RADIUS',
  NETWORK: 'NETWORK',
  TR069: 'TR069',
  VOIP: 'VOIP',
  AI_AGENTS: 'AI_AGENTS',
  TICKETS: 'TICKETS',
  INVENTORY: 'INVENTORY',
  MAX_SUBSCRIBERS: 'MAX_SUBSCRIBERS',
  MAX_DEVICES: 'MAX_DEVICES',
  MAX_OLTS: 'MAX_OLTS',
  MAX_BRANCHES: 'MAX_BRANCHES',
  // Compatibility with media modules if shared
  STREAMOPS: 'STREAMOPS',
  CHANNELS: 'CHANNELS',
  LIVE_SERVER: 'LIVE_SERVER',
  INGEST_SERVER: 'INGEST_SERVER',
  TRANSCODE: 'TRANSCODE',
  VOD_PLAYOUT: 'VOD_PLAYOUT',
  MPTS_MUX: 'MPTS_MUX',
});

const canonicalModule = value => {
  const norm = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (norm === 'ACS' || norm === 'TR_069') return 'TR069';
  if (norm === 'AI' || norm === 'AGENTS') return 'AI_AGENTS';
  if (norm === 'LEADS' || norm === 'CRM' || norm === 'SUBSCRIBERS') return 'CUSTOMERS';
  if (norm === 'PAYMENT' || norm === 'INVOICE') return 'BILLING';
  if (norm === 'DEVICES' || norm === 'OLT') return 'NETWORK';
  return norm;
};

const normalizeModules = modules => [...new Set(
  (Array.isArray(modules) ? modules : []).map(canonicalModule).filter(Boolean)
)].sort();

const hasModule = (modules, moduleCode) => normalizeModules(modules).includes(canonicalModule(moduleCode));

const normalizeEntitlements = entitlements => Object.fromEntries(Object.entries(
  entitlements && typeof entitlements === 'object' && !Array.isArray(entitlements) ? entitlements : {}
).map(([code, value]) => [canonicalModule(code), value]).filter(([code, value]) => code && (typeof value === 'boolean' || (Number.isInteger(value) && value >= 0))));

const getEntitlementLimit = (entitlements, code) => {
  const value = normalizeEntitlements(entitlements)[canonicalModule(code)];
  return Number.isInteger(value) && value >= 0 ? value : 0;
};

const toUiFeatures = modules => {
  const normalized = normalizeModules(modules);
  const features = [];
  if (normalized.includes(MODULES.OSS_BSS) || normalized.length === 0) features.push('oss-bss');
  if (normalized.includes(MODULES.CUSTOMERS)) features.push('customers');
  if (normalized.includes(MODULES.BILLING)) features.push('billing');
  if (normalized.includes(MODULES.PACKAGES)) features.push('packages');
  if (normalized.includes(MODULES.RADIUS)) features.push('radius');
  if (normalized.includes(MODULES.NETWORK)) features.push('network');
  if (normalized.includes(MODULES.TR069)) features.push('tr069');
  if (normalized.includes(MODULES.VOIP)) features.push('voip');
  if (normalized.includes(MODULES.AI_AGENTS)) features.push('ai-agents');
  if (normalized.includes(MODULES.TICKETS)) features.push('tickets');
  if (normalized.includes(MODULES.INVENTORY)) features.push('inventory');
  return features;
};

module.exports = {
  MODULES,
  canonicalModule,
  getEntitlementLimit,
  hasModule,
  normalizeModules,
  normalizeEntitlements,
  toUiFeatures,
};
