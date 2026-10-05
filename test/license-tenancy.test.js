const test = require('node:test');
const assert = require('node:assert/strict');
const { SecureLicenseRuntime } = require('../src/services/license/secureLicenseRuntime');
const { normalizeModules, normalizeEntitlements, toUiFeatures, hasModule } = require('../src/services/license/licensePolicy');

test('SecureLicenseRuntime generates scoped HWID and stable hardware IDs', async () => {
  const runtime = new SecureLicenseRuntime();
  const hwid1 = await runtime.getHardwareId();
  const hwid2 = await runtime.getHardwareId();

  assert.equal(hwid1, hwid2);
  assert.ok(typeof hwid1 === 'string' && hwid1.length === 64, 'HWID should be a 64-character SHA-256 hash');
});

test('Different tenants on the same hardware produce unique, isolated HWIDs', async () => {
  const runtime = new SecureLicenseRuntime();
  const hwidTenant1 = await runtime.getHardwareId('fb86704e-69a7-46fb-8e6d-50b8aa9cec6b');
  const hwidTenant2 = await runtime.getHardwareId('512eb440-cc57-4842-8c6d-51ff83e87adf');

  assert.ok(hwidTenant1);
  assert.ok(hwidTenant2);
  assert.notEqual(hwidTenant1, hwidTenant2, 'HWID must be strictly unique per tenant on the same physical host');
});

test('SecureLicenseRuntime produces a valid provisioning identity', async () => {
  const runtime = new SecureLicenseRuntime();
  await runtime.getHardwareId();
  await runtime.getClientId();

  const provisioningId = runtime.getProvisioningId();
  assert.ok(provisioningId.startsWith('KTX1.'), 'Provisioning ID must begin with KTX1 prefix');

  const payloadJson = Buffer.from(provisioningId.slice(5), 'base64url').toString('utf8');
  const payload = JSON.parse(payloadJson);

  assert.equal(payload.v, 1);
  assert.ok(payload.tenantId, 'Provisioning payload contains tenantId');
  assert.ok(payload.applicationId, 'Provisioning payload contains applicationId');
  assert.ok(payload.clientId, 'Provisioning payload contains clientId');
  assert.ok(payload.hwid, 'Provisioning payload contains hwid');
  assert.ok(Array.isArray(payload.modules), 'Provisioning payload contains supported modules list');
});

test('License policy normalizes modules, entitlements, and features', () => {
  const rawModules = ['billing', 'RADIUS', 'voip', 'tr_069', 'ai'];
  const normalized = normalizeModules(rawModules);

  assert.deepEqual(normalized, ['AI_AGENTS', 'BILLING', 'RADIUS', 'TR069', 'VOIP']);
  assert.equal(hasModule(normalized, 'billing'), true);
  assert.equal(hasModule(normalized, 'BILLING'), true);
  assert.equal(hasModule(normalized, 'inventory'), false);

  const entitlements = normalizeEntitlements({
    max_subscribers: 5000,
    max_devices: 50,
    invalid_prop: 'not_a_number',
  });
  assert.equal(entitlements.MAX_SUBSCRIBERS, 5000);
  assert.equal(entitlements.MAX_DEVICES, 50);
  assert.equal(entitlements.INVALID_PROP, undefined);

  const features = toUiFeatures(normalized);
  assert.ok(features.includes('billing'));
  assert.ok(features.includes('radius'));
  assert.ok(features.includes('tr069'));
  assert.ok(features.includes('voip'));
  assert.ok(features.includes('ai-agents'));
});
