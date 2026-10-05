const tokenKeys = ['background','foreground','card','cardForeground','muted','mutedForeground','primary','primaryForeground','secondary','secondaryForeground','accent','accentForeground','border','input','ring','destructive','destructiveForeground','radius','fontSans','fontHeading','sidebar','sidebarForeground','sidebarIconStyle'];
const colorKeys = new Set(tokenKeys.filter(key => !['radius','fontSans','fontHeading','sidebarIconStyle'].includes(key)));
const safeColor = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const safeSize = /^(?:0|[0-9]+(?:\.[0-9]+)?)(?:px|rem|em|%)$/;
const safeFont = /^[a-z0-9 ,.'"-]{1,120}$/i;

const plum = {background:'#f8f7fa',foreground:'#1b1024',card:'#ffffff',cardForeground:'#1b1024',muted:'#f4eeff',mutedForeground:'#6f6078',primary:'#7c3aed',primaryForeground:'#ffffff',secondary:'#eee7f5',secondaryForeground:'#2b1836',accent:'#06b6d4',accentForeground:'#06151a',border:'#e8dff0',input:'#e8dff0',ring:'#8b5cf6',destructive:'#ef4444',destructiveForeground:'#ffffff',radius:'0.75rem',fontSans:'Inter, sans-serif',fontHeading:'Sora, sans-serif',sidebar:'#16091f',sidebarForeground:'#f8f4fb',sidebarIconStyle:'colored'};
const plumDark = {...plum,background:'#09050f',foreground:'#ffffff',card:'#1a0d24',cardForeground:'#ffffff',muted:'#2b0d3a',mutedForeground:'#b8a8c2',secondary:'#2a1736',secondaryForeground:'#f6effa',border:'#342044',input:'#342044',primary:'#a78bfa',primaryForeground:'#14091c',accent:'#22d3ee',accentForeground:'#071317',sidebar:'#0d0613',sidebarForeground:'#ffffff'};
const themed=(light,dark={})=>({light,dark:{...plumDark,...dark}});
const presets = [
  {name:'Kashtrix Plum',description:'Warm plum surfaces with cyan operational accents.',tokens:themed(plum)},
  {name:'Kashtrix Premium NOC',description:'Premium charcoal OSS/BSS operations theme with restrained cyan telemetry accents.',tokens:themed({...plum,background:'#f4f7f9',foreground:'#17202a',card:'#ffffff',cardForeground:'#17202a',muted:'#eaf1f5',mutedForeground:'#5d6b78',primary:'#173f49',primaryForeground:'#ffffff',secondary:'#dceff3',secondaryForeground:'#173f49',accent:'#0891b2',accentForeground:'#ffffff',border:'#d4dde4',input:'#d4dde4',ring:'#6cc7d9',sidebar:'#20262e',sidebarForeground:'#f3f6f8'},{background:'#1b2027',foreground:'#f3f6f8',card:'#212831',cardForeground:'#f3f6f8',muted:'#2a333e',mutedForeground:'#b9c2cb',primary:'#6cc7d9',primaryForeground:'#10252b',secondary:'#173f49',secondaryForeground:'#dceff3',accent:'#6cc7d9',accentForeground:'#10252b',border:'#3a444f',input:'#4b5865',ring:'#6cc7d9',sidebar:'#252c35',sidebarForeground:'#f3f6f8'})},
  {name:'Kashtrix Signature AI',description:'Premium Kashtrix brand theme combining deep plum, intelligent purple, and a focused AI magenta accent.',tokens:themed({...plum,primary:'#2b0d3a',primaryForeground:'#ffffff',secondary:'#f4eeff',secondaryForeground:'#4a1b7a',accent:'#e11d72',accentForeground:'#ffffff',ring:'#4a1b7a',sidebar:'#2b0d3a',sidebarForeground:'#ffffff'},{background:'#09050f',foreground:'#ffffff',card:'#1a0d24',cardForeground:'#ffffff',muted:'#2b0d3a',mutedForeground:'#b8a8c2',primary:'#dccbff',primaryForeground:'#1b1024',secondary:'#351147',secondaryForeground:'#ffffff',accent:'#ff4d8d',accentForeground:'#1b0710',border:'#342044',input:'#4a2b5c',ring:'#e11d72',sidebar:'#120819',sidebarForeground:'#ffffff'})},
  {name:'Network Ocean',description:'Cool blue and cyan operations workspace.',tokens:themed({...plum,primary:'#0284c7',secondary:'#e0f2fe',accent:'#14b8a6',ring:'#0ea5e9',sidebar:'#071827'},{primary:'#38bdf8',accent:'#2dd4bf',ring:'#0ea5e9',sidebar:'#04111d'})},
  {name:'Emerald NOC',description:'High-clarity green network operations theme.',tokens:themed({...plum,primary:'#059669',secondary:'#d1fae5',accent:'#84cc16',ring:'#10b981',sidebar:'#071b16'},{primary:'#34d399',accent:'#a3e635',ring:'#10b981',sidebar:'#03120e'})},
  {name:'Slate Professional',description:'Neutral enterprise palette.',tokens:themed({...plum,primary:'#334155',secondary:'#e2e8f0',accent:'#6366f1',ring:'#64748b',sidebar:'#0f172a'},{primary:'#94a3b8',accent:'#818cf8',ring:'#64748b',sidebar:'#020617'})}
];

function validateMode(input, base) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('Theme tokens must be an object'),{status:400});
  const next={...base};
  for(const key of tokenKeys){
    if(input[key]===undefined)continue;
    const value=String(input[key]).trim();
    const valid=colorKeys.has(key)?safeColor.test(value):key==='radius'?safeSize.test(value):key==='sidebarIconStyle'?['colored','theme','monochrome'].includes(value):safeFont.test(value);
    if(!valid)throw Object.assign(new Error(`Invalid theme token: ${key}`),{status:400});
    next[key]=value;
  }
  return next;
}

function validateTokens(input, base = themed(plum)) {
  const normalized=input?.light||input?.dark?input:{light:input,dark:input};
  const normalizedBase=base?.light||base?.dark?base:{light:base,dark:base};
  return {light:validateMode(normalized.light||{},normalizedBase.light||plum),dark:validateMode(normalized.dark||normalized.light||{},normalizedBase.dark||plumDark)};
}

let initialized=false;
async function ensureThemeTables(prisma){
  if(initialized)return;
  // Tables are managed by Prisma (AppTheme, AppThemeVersion, AppThemeAssignment models)
  initialized=true;
}

module.exports={tokenKeys,presets,defaultTokens:themed(plum),validateTokens,ensureThemeTables};
