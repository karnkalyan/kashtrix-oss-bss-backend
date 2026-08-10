const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { ServiceFactory } = require('../src/lib/clients/ServiceFactory');
const { syncDevices } = require('../src/controllers/tr069device.controller');

test('default TR-069 sync imports only customer-linked devices for the current ISP', async () => {
  const originalGetClient = ServiceFactory.getClient;
  const created = [];
  ServiceFactory.getClient = async () => ({
    getDevices: async () => [
      { _deviceId: { _SerialNumber: 'HWTCUST00001', _Manufacturer: 'Huawei' }, _lastInform: new Date().toISOString() },
      { _deviceId: { _SerialNumber: 'HWTOUTS00002', _Manufacturer: 'Huawei' }, _lastInform: new Date().toISOString() }
    ]
  });

  const prisma = {
    customerDevice: {
      findMany: async () => [{ serialNumber: 'HWTCUST00001', ponSerial: null, customer: { leadId: 44 } }]
    },
    tr069Device: {
      findUnique: async () => null,
      create: async ({ data }) => { created.push(data); return data; },
      update: async () => {},
      findMany: async () => [],
      updateMany: async () => ({ count: 0 })
    }
  };
  const req = { ispId: 7, prisma, get: () => '' };
  let payload;
  const res = { status() { return this; }, json(value) { payload = value; return value; } };

  try {
    await syncDevices(req, res, error => { throw error; });
  } finally {
    ServiceFactory.getClient = originalGetClient;
  }

  assert.equal(created.length, 1);
  assert.equal(created[0].serialNumber, 'HWTCUST00001');
  assert.equal(created[0].ispId, 7);
  assert.equal(payload.stats.scope, 'customer-linked');
  assert.equal(payload.stats.total, 1);
});

test('provider TR-069 sync never transfers a serial owned by another ISP', async () => {
  const originalGetClient = ServiceFactory.getClient;
  const secret = 'provider-test-secret';
  const created = [];
  ServiceFactory.getClient = async () => ({
    getDevices: async () => [
      { _deviceId: { _SerialNumber: 'FOREIGN00001' } },
      { _deviceId: { _SerialNumber: 'UNCLAIM00002' } }
    ]
  });
  const prisma = {
    iSPSettings: { findUnique: async () => ({ value: crypto.createHash('sha256').update(secret).digest('hex') }) },
    customerDevice: { findMany: async () => [] },
    tr069Device: {
      findUnique: async ({ where }) => where.serialNumber === 'FOREIGN00001' ? { id: 9, ispId: 99 } : null,
      create: async ({ data }) => { created.push(data); return data; },
      update: async () => {},
      findMany: async () => [],
      updateMany: async () => ({ count: 0 })
    }
  };
  const req = { ispId: 7, prisma, get: name => name === 'x-tr069-provider-secret' ? secret : '' };
  let payload;
  const res = { status() { return this; }, json(value) { payload = value; return value; } };

  try {
    await syncDevices(req, res, error => { throw error; });
  } finally {
    ServiceFactory.getClient = originalGetClient;
  }

  assert.deepEqual(created.map(device => device.serialNumber), ['UNCLAIM00002']);
  assert.equal(payload.stats.protectedTenantDevices, 1);
  assert.equal(payload.stats.scope, 'provider');
});
