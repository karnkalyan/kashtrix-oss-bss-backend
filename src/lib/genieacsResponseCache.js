const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

function cacheKey(ispId, serialNumber, type) { return `${ispId}:${String(serialNumber).trim().toUpperCase()}:${type}`; }
function getCachedGenieACSResponse(ispId, serialNumber, type) {
  const key = cacheKey(ispId, serialNumber, type);
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) { cache.delete(key); return null; }
  return entry.value;
}
function setCachedGenieACSResponse(ispId, serialNumber, type, value) {
  cache.set(cacheKey(ispId, serialNumber, type), { value, expiresAt: Date.now() + CACHE_TTL_MS });
}
function invalidateGenieACSResponseCache(ispId, serialNumber) {
  cache.delete(cacheKey(ispId, serialNumber, 'deviceinfo'));
  cache.delete(cacheKey(ispId, serialNumber, 'waninfo'));
}
module.exports = { CACHE_TTL_MS, getCachedGenieACSResponse, setCachedGenieACSResponse, invalidateGenieACSResponseCache };
