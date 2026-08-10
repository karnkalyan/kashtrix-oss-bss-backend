function finitePower(value) {
  const raw = value && typeof value === 'object' && '_value' in value ? value._value : value;
  const number = Number.parseFloat(String(raw ?? '').replace(/[^\d+.-]/g, ''));
  return Number.isFinite(number) ? number : null;
}

function findNamedPower(node, names, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 10) return null;
  for (const [key, value] of Object.entries(node)) {
    if (names.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''))) {
      const parsed = finitePower(value);
      if (parsed !== null) return parsed;
    }
  }
  for (const value of Object.values(node)) {
    const found = findNamedPower(value, names, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function extractOltRxPower(ont) {
  const names = new Set(['oltrxpower', 'oltreceivepower', 'rxpoweratolt']);
  for (let source of [ont?.rawData, ont?.ontDetails?.opticalDiagnostics]) {
    if (typeof source === 'string') {
      try { source = JSON.parse(source); } catch { continue; }
    }
    const found = findNamedPower(source, names);
    if (found !== null) return found;
  }
  return null;
}

module.exports = { finitePower, extractOltRxPower };
