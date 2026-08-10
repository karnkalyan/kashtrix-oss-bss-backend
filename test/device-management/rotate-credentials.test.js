const { test } = require('node:test');
const assert = require('node:assert');

process.env.DEVICE_CREDENTIAL_KEY = 'test-encryption-key-for-rotation-tests';
const { encrypt, saveCredentials, loadCredentials } = require('../../src/services/device-management/device-credential.service');

// Mock prisma client for credentials
const mockPrisma = {
  managedDeviceCredential: {
    dataStore: new Map(),
    findUnique({ where: { deviceId } }) {
      return Promise.resolve(this.dataStore.get(deviceId) || null);
    },
    delete({ where: { deviceId } }) {
      this.dataStore.delete(deviceId);
      return Promise.resolve(null);
    },
    upsert({ where: { deviceId }, update, create }) {
      const existing = this.dataStore.get(deviceId) || {};
      const merged = {
        id: existing.id || 1,
        deviceId,
        ...create,
        ...update,
        lastRotatedAt: new Date()
      };
      this.dataStore.set(deviceId, merged);
      return Promise.resolve(merged);
    }
  }
};

test('saveCredentials clears the requiresRotation flag and updates the payload', async () => {
  const deviceId = 42;
  
  // Set initial state
  mockPrisma.managedDeviceCredential.dataStore.set(deviceId, {
    id: 1,
    deviceId,
    encryptedPayload: encrypt({ sshPassword: 'old-password' }),
    requiresRotation: true
  });

  const payload = { sshPassword: 'new-password' };
  const updated = await saveCredentials(mockPrisma, deviceId, payload);
  
  assert.ok(updated);
  assert.equal(updated.requiresRotation, false);
  
  const decrypted = await loadCredentials(mockPrisma, deviceId);
  assert.equal(decrypted.sshPassword, 'new-password');
});
