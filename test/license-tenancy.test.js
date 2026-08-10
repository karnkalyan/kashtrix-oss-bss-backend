const test = require('node:test');
const assert = require('node:assert/strict');

const { getHardwareFingerprint } = require('../src/services/license.service');

test('hardware IDs are stable per ISP and distinct across ISP tenants', async () => {
  const writes = new Map();
  const prisma = {
    iSPSettings: {
      async upsert({ where, create, update }) {
        const record = writes.has(where.key) ? { ...writes.get(where.key), ...update } : create;
        writes.set(where.key, record);
        return record;
      }
    }
  };

  const tenantOneFirst = await getHardwareFingerprint(prisma, 101);
  const tenantOneRefresh = await getHardwareFingerprint(prisma, 101);
  const tenantTwo = await getHardwareFingerprint(prisma, 202);

  assert.equal(tenantOneFirst, tenantOneRefresh);
  assert.notEqual(tenantOneFirst, tenantTwo);
  assert.match(tenantOneFirst, /^[a-f0-9]{64}$/);
  assert.deepEqual([...writes.keys()].sort(), ['appHardwareFingerprint:101', 'appHardwareFingerprint:202']);
});
