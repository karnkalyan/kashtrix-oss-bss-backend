const tokenKeys = ['background','foreground','card','cardForeground','muted','mutedForeground','primary','primaryForeground','secondary','secondaryForeground','accent','accentForeground','border','input','ring','destructive','destructiveForeground','radius','fontSans','fontHeading','sidebar','sidebarForeground','sidebarIconStyle'];
const colorKeys = new Set(tokenKeys.filter(key => !['radius','fontSans','fontHeading','sidebarIconStyle'].includes(key)));
const safeColor = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const safeSize = /^(?:0|[0-9]+(?:\.[0-9]+)?)(?:px|rem|em|%)$/;
const safeFont = /^[a-z0-9 ,.'"-]{1,120}$/i;

// 1. Default UI (Kashtrix Classic Slate) - Kept as Default
const defaultLight = {
  background: '#f8fafc',
  foreground: '#0f172a',
  card: '#ffffff',
  cardForeground: '#0f172a',
  muted: '#f1f5f9',
  mutedForeground: '#64748b',
  primary: '#4f46e5',
  primaryForeground: '#ffffff',
  secondary: '#f1f5f9',
  secondaryForeground: '#334155',
  accent: '#e0e7ff',
  accentForeground: '#3730a3',
  border: '#e2e8f0',
  input: '#e2e8f0',
  ring: '#6366f1',
  destructive: '#ef4444',
  destructiveForeground: '#ffffff',
  radius: '0.625rem',
  fontSans: 'Inter, sans-serif',
  fontHeading: 'Sora, sans-serif',
  sidebar: '#ffffff',
  sidebarForeground: '#0f172a',
  sidebarIconStyle: 'colored'
};

const defaultDark = {
  ...defaultLight,
  background: '#0d1117',
  foreground: '#f0f6fc',
  card: '#161b22',
  cardForeground: '#f0f6fc',
  muted: '#21262d',
  mutedForeground: '#8b949e',
  primary: '#818cf8',
  primaryForeground: '#0d1117',
  secondary: '#21262d',
  secondaryForeground: '#f0f6fc',
  accent: '#1e1e38',
  accentForeground: '#a5b4fc',
  border: '#30363d',
  input: '#30363d',
  ring: '#6366f1',
  sidebar: '#0d1117',
  sidebarForeground: '#f0f6fc'
};

// 2. Kashtrix Intelligent Purple (AI Signature)
const purpleLight = {
  background: '#faf8fc',
  foreground: '#1b1024',
  card: '#ffffff',
  cardForeground: '#1b1024',
  muted: '#f4eeff',
  mutedForeground: '#6f6078',
  primary: '#7c3aed',
  primaryForeground: '#ffffff',
  secondary: '#f3e8ff',
  secondaryForeground: '#4a1b7a',
  accent: '#e11d72',
  accentForeground: '#ffffff',
  border: '#e8dff0',
  input: '#e8dff0',
  ring: '#8b5cf6',
  destructive: '#ef4444',
  destructiveForeground: '#ffffff',
  radius: '0.75rem',
  fontSans: 'Inter, sans-serif',
  fontHeading: 'Sora, sans-serif',
  sidebar: '#ffffff',
  sidebarForeground: '#1b1024',
  sidebarIconStyle: 'colored'
};

const purpleDark = {
  ...purpleLight,
  background: '#09050f',
  foreground: '#ffffff',
  card: '#1a0d24',
  cardForeground: '#ffffff',
  muted: '#2b0d3a',
  mutedForeground: '#b8a8c2',
  primary: '#a78bfa',
  primaryForeground: '#14091c',
  secondary: '#2a1736',
  secondaryForeground: '#f6effa',
  accent: '#ff4d8d',
  accentForeground: '#1b0710',
  border: '#342044',
  input: '#342044',
  ring: '#e11d72',
  sidebar: '#0d0613',
  sidebarForeground: '#ffffff'
};

// 3. Cyber Blue NOC (Telecom Operations)
const blueLight = {
  background: '#f0f9ff',
  foreground: '#082f49',
  card: '#ffffff',
  cardForeground: '#082f49',
  muted: '#e0f2fe',
  mutedForeground: '#0369a1',
  primary: '#0284c7',
  primaryForeground: '#ffffff',
  secondary: '#e0f2fe',
  secondaryForeground: '#075985',
  accent: '#06b6d4',
  accentForeground: '#082f49',
  border: '#bae6fd',
  input: '#bae6fd',
  ring: '#0284c7',
  destructive: '#ef4444',
  destructiveForeground: '#ffffff',
  radius: '0.5rem',
  fontSans: 'Inter, sans-serif',
  fontHeading: 'Space Grotesk, sans-serif',
  sidebar: '#ffffff',
  sidebarForeground: '#082f49',
  sidebarIconStyle: 'colored'
};

const blueDark = {
  ...blueLight,
  background: '#07101d',
  foreground: '#e0f2fe',
  card: '#0f1b2c',
  cardForeground: '#e0f2fe',
  muted: '#162a42',
  mutedForeground: '#7dd3fc',
  primary: '#38bdf8',
  primaryForeground: '#07101d',
  secondary: '#162a42',
  secondaryForeground: '#e0f2fe',
  accent: '#22d3ee',
  accentForeground: '#07101d',
  border: '#1e3a5f',
  input: '#1e3a5f',
  ring: '#38bdf8',
  sidebar: '#050c17',
  sidebarForeground: '#e0f2fe'
};

// 4. Emerald Fiber (High-Reliability Green)
const emeraldLight = {
  background: '#f0fdf4',
  foreground: '#052e16',
  card: '#ffffff',
  cardForeground: '#052e16',
  muted: '#dcfce7',
  mutedForeground: '#15803d',
  primary: '#059669',
  primaryForeground: '#ffffff',
  secondary: '#d1fae5',
  secondaryForeground: '#065f46',
  accent: '#10b981',
  accentForeground: '#ffffff',
  border: '#bbf7d0',
  input: '#bbf7d0',
  ring: '#059669',
  destructive: '#ef4444',
  destructiveForeground: '#ffffff',
  radius: '0.625rem',
  fontSans: 'Inter, sans-serif',
  fontHeading: 'Sora, sans-serif',
  sidebar: '#ffffff',
  sidebarForeground: '#052e16',
  sidebarIconStyle: 'colored'
};

const emeraldDark = {
  ...emeraldLight,
  background: '#04140d',
  foreground: '#ecfdf5',
  card: '#0a2217',
  cardForeground: '#ecfdf5',
  muted: '#133827',
  mutedForeground: '#6ee7b7',
  primary: '#34d399',
  primaryForeground: '#04140d',
  secondary: '#133827',
  secondaryForeground: '#ecfdf5',
  accent: '#10b981',
  accentForeground: '#04140d',
  border: '#1b4d37',
  input: '#1b4d37',
  ring: '#34d399',
  sidebar: '#020d08',
  sidebarForeground: '#ecfdf5'
};

// 5. Amber Gold Enterprise (Executive Billing)
const amberLight = {
  background: '#fffbeb',
  foreground: '#451a03',
  card: '#ffffff',
  cardForeground: '#451a03',
  muted: '#fef3c7',
  mutedForeground: '#b45309',
  primary: '#d97706',
  primaryForeground: '#ffffff',
  secondary: '#fef3c7',
  secondaryForeground: '#92400e',
  accent: '#f59e0b',
  accentForeground: '#451a03',
  border: '#fde68a',
  input: '#fde68a',
  ring: '#d97706',
  destructive: '#ef4444',
  destructiveForeground: '#ffffff',
  radius: '0.625rem',
  fontSans: 'Inter, sans-serif',
  fontHeading: 'Sora, sans-serif',
  sidebar: '#ffffff',
  sidebarForeground: '#451a03',
  sidebarIconStyle: 'colored'
};

const amberDark = {
  ...amberLight,
  background: '#140d04',
  foreground: '#fef3c7',
  card: '#21180b',
  cardForeground: '#fef3c7',
  muted: '#36240d',
  mutedForeground: '#fcd34d',
  primary: '#fbbf24',
  primaryForeground: '#140d04',
  secondary: '#36240d',
  secondaryForeground: '#fef3c7',
  accent: '#f59e0b',
  accentForeground: '#140d04',
  border: '#452b0d',
  input: '#452b0d',
  ring: '#fbbf24',
  sidebar: '#0f0a03',
  sidebarForeground: '#fef3c7'
};

// 6. Obsidian Crimson (Critical SOC / Security)
const crimsonLight = {
  background: '#fff1f2',
  foreground: '#4c0519',
  card: '#ffffff',
  cardForeground: '#4c0519',
  muted: '#ffe4e6',
  mutedForeground: '#be123c',
  primary: '#e11d48',
  primaryForeground: '#ffffff',
  secondary: '#ffe4e6',
  secondaryForeground: '#9f1239',
  accent: '#f43f5e',
  accentForeground: '#ffffff',
  border: '#fecdd3',
  input: '#fecdd3',
  ring: '#e11d48',
  destructive: '#b91c1c',
  destructiveForeground: '#ffffff',
  radius: '0.625rem',
  fontSans: 'Inter, sans-serif',
  fontHeading: 'Sora, sans-serif',
  sidebar: '#ffffff',
  sidebarForeground: '#4c0519',
  sidebarIconStyle: 'colored'
};

const crimsonDark = {
  ...crimsonLight,
  background: '#110609',
  foreground: '#ffe4e6',
  card: '#1f0b11',
  cardForeground: '#ffe4e6',
  muted: '#36111b',
  mutedForeground: '#fda4af',
  primary: '#fb7185',
  primaryForeground: '#110609',
  secondary: '#36111b',
  secondaryForeground: '#ffe4e6',
  accent: '#f43f5e',
  accentForeground: '#110609',
  border: '#4c111f',
  input: '#4c111f',
  ring: '#fb7185',
  sidebar: '#0c0406',
  sidebarForeground: '#ffe4e6'
};

const themed = (light, dark) => ({ light, dark });

const presets = [
  { name: 'Default UI', description: 'Clean enterprise Kashtrix Slate layout with light responsive sidebar.', tokens: themed(defaultLight, defaultDark) },
  { name: 'Kashtrix Intelligent Purple', description: 'Signature Kashtrix AI theme combining violet structure and focused magenta accents.', tokens: themed(purpleLight, purpleDark) },
  { name: 'Cyber Blue NOC', description: 'Telecom operations workspace optimized for high-speed fiber and core network monitoring.', tokens: themed(blueLight, blueDark) },
  { name: 'Emerald Fiber', description: 'High-availability green theme with high-contrast network status indicators.', tokens: themed(emeraldLight, emeraldDark) },
  { name: 'Amber Gold Enterprise', description: 'Executive revenue and subscriber billing workspace with rich amber tones.', tokens: themed(amberLight, amberDark) },
  { name: 'Obsidian Crimson', description: 'High-visibility security operations theme designed for urgent alert management.', tokens: themed(crimsonLight, crimsonDark) },
];

function validateMode(input, base) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('Theme tokens must be an object'), { status: 400 });
  const next = { ...base };
  for (const key of tokenKeys) {
    if (input[key] === undefined) continue;
    const value = String(input[key]).trim();
    const valid = colorKeys.has(key) ? safeColor.test(value) : key === 'radius' ? safeSize.test(value) : key === 'sidebarIconStyle' ? ['colored', 'theme', 'monochrome'].includes(value) : safeFont.test(value);
    if (!valid) throw Object.assign(new Error(`Invalid theme token: ${key}`), { status: 400 });
    next[key] = value;
  }
  return next;
}

function validateTokens(input, base = themed(defaultLight, defaultDark)) {
  const normalized = input?.light || input?.dark ? input : { light: input, dark: input };
  const normalizedBase = base?.light || base?.dark ? base : { light: base, dark: base };
  return {
    light: validateMode(normalized.light || {}, normalizedBase.light || defaultLight),
    dark: validateMode(normalized.dark || normalized.light || {}, normalizedBase.dark || defaultDark)
  };
}

let initialized = false;
async function ensureThemeTables(prisma) {
  if (initialized) return;
  initialized = true;
}

module.exports = { tokenKeys, presets, defaultTokens: themed(defaultLight, defaultDark), validateTokens, ensureThemeTables };
