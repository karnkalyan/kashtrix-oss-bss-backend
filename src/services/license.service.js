const path = require('path');
const { SecureLicenseRuntime, getSupportedModules } = require('./license/secureLicenseRuntime');

const EXPIRED_MESSAGE = 'Valid license activation required. Please activate with your license key or provisioning ID.';

// Singleton secure license runtime
const secureLicense = new SecureLicenseRuntime({
  baseDir: path.resolve(__dirname, '../..'),
  env: process.env,
});

async function getStatus() {
  return secureLicense.getPublicStatus();
}

async function getHardwareFingerprint(prisma, tenantId) {
  return secureLicense.getHardwareId(tenantId);
}

async function saveToken(prisma, ispId, token) {
  return secureLicense.activate(token);
}

async function deleteToken(prisma, ispId) {
  return secureLicense.deactivate();
}

function isLicenseRoute(pathname) {
  return (
    pathname.startsWith('/license') ||
    pathname.startsWith('/api/license') ||
    pathname === '/isp/public' ||
    pathname === '/api/isp/public' ||
    pathname.startsWith('/auth') ||
    pathname.startsWith('/api/auth')
  );
}

function licenseGuard(prisma) {
  return async (req, res, next) => {
    if (isLicenseRoute(req.path) || req.path.startsWith('/uploads') || req.method === 'OPTIONS') {
      return next();
    }

    const status = secureLicense.getPublicStatus();
    if (!status.active) {
      return res.status(402).json({
        success: false,
        licenseExpired: true,
        message: status.reason || EXPIRED_MESSAGE,
        hwid: status.hardwareId,
        provisioningId: status.provisioningId,
        status: status.status,
      });
    }

    req.license = status;
    return next();
  };
}

module.exports = {
  secureLicense,
  EXPIRED_MESSAGE,
  getHardwareFingerprint,
  getStatus,
  saveToken,
  deleteToken,
  licenseGuard,
  getSupportedModules,
};
