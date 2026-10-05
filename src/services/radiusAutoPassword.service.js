const bcrypt = require('bcrypt');
const { ServiceFactory } = require('../lib/clients/ServiceFactory');
const { SERVICE_CODES } = require('../lib/serviceConstants');

const AUTO_UPDATE_SETTING_KEYS = ['auto_update_radius_password', 'autoUpdateRadiusPassword'];

/**
 * Check if the auto update radius password setting is enabled in Master Settings (ISPSettings)
 */
async function isAutoRadiusPasswordEnabled(ispId, prisma) {
  try {
    const setting = await prisma.iSPSettings.findFirst({
      where: {
        ispId: Number(ispId) || 1,
        key: { in: AUTO_UPDATE_SETTING_KEYS }
      }
    });

    if (!setting) return false;
    const val = String(setting.value || '').trim().toLowerCase();
    return val === 'true' || val === '1' || val === 'enable' || val === 'enabled';
  } catch (error) {
    console.error(`[RADIUS AUTO-PWD] Failed to check master setting for ISP ${ispId}:`, error.message);
    return false;
  }
}

/**
 * Sync & update customer passwords from recent rejected dial-in attempts in FreeRADIUS (radpostauth)
 */
async function syncRejectedDialInPasswords(ispId, prisma) {
  const targetIspId = Number(ispId) || 1;
  const enabled = await isAutoRadiusPasswordEnabled(targetIspId, prisma);

  if (!enabled) {
    return {
      success: true,
      enabled: false,
      message: 'Auto-update RADIUS password option is disabled in Master Settings.',
      updatedUsersCount: 0,
      updatedUsers: []
    };
  }

  try {
    const radiusClient = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, targetIspId).catch(() => null);
    if (!radiusClient) {
      return {
        success: false,
        enabled: true,
        message: `Radius service is not configured or reachable for ISP #${targetIspId}`,
        updatedUsersCount: 0,
        updatedUsers: []
      };
    }

    // Fetch recent 200 radpostauth records
    const postAuthLogs = await radiusClient.getRadpostauthlimit(200).catch(() => []);
    if (!Array.isArray(postAuthLogs) || postAuthLogs.length === 0) {
      return {
        success: true,
        enabled: true,
        message: 'No postauth records found to reconcile.',
        updatedUsersCount: 0,
        updatedUsers: []
      };
    }

    // Filter only rejected logs that contain a dialed password and username
    const rejectedLogs = postAuthLogs.filter(log => {
      const reply = String(log.reply || '').toLowerCase();
      const pass = String(log.pass || '').trim();
      const user = String(log.username || '').trim();
      return (reply.includes('reject') || reply === 'access-reject') && pass.length > 0 && user.length > 0;
    });

    if (rejectedLogs.length === 0) {
      return {
        success: true,
        enabled: true,
        message: 'No rejected authentication records with dialed passwords found.',
        updatedUsersCount: 0,
        updatedUsers: []
      };
    }

    // Group by username and take the newest attempt (highest ID or latest authdate)
    const latestRejectionByUser = new Map();
    for (const log of rejectedLogs) {
      const username = String(log.username).trim();
      const existing = latestRejectionByUser.get(username);
      if (!existing || (log.id && (!existing.id || log.id > existing.id))) {
        latestRejectionByUser.set(username, log);
      }
    }

    const updatedUsers = [];

    for (const [username, log] of latestRejectionByUser.entries()) {
      const dialedPassword = String(log.pass).trim();
      if (!dialedPassword) continue;

      // Check if ConnectionUser exists in CMS database
      const connectionUser = await prisma.ConnectionUser.findFirst({
        where: {
          username: username,
          ...(targetIspId ? { ispId: targetIspId } : {}),
          isDeleted: false
        },
        include: { customer: true }
      });

      if (!connectionUser) {
        continue;
      }

      // If password in CMS or RADIUS differs from dialed password, update it!
      if (connectionUser.password !== dialedPassword) {
        console.log(`[RADIUS AUTO-PWD] Capturing new password for user '${username}' (Old: '${connectionUser.password}' -> Dialed: '${dialedPassword}')`);

        // 1. Update ConnectionUser in DB
        await prisma.ConnectionUser.update({
          where: { id: connectionUser.id },
          data: {
            password: dialedPassword,
            updatedAt: new Date()
          }
        });

        // 2. Update FreeRADIUS radcheck password
        await radiusClient.updateUserPassword(username, dialedPassword).catch(err => {
          console.warn(`[RADIUS AUTO-PWD] Note: radcheck update for '${username}':`, err.message);
        });

        // 3. Update Portal User password hash if exists
        try {
          if (connectionUser.customerId) {
            const portalUser = await prisma.User.findFirst({
              where: { customerId: connectionUser.customerId }
            });
            if (portalUser) {
              const passwordHash = await bcrypt.hash(dialedPassword, 10);
              await prisma.User.update({
                where: { id: portalUser.id },
                data: {
                  passwordHash,
                  updatedAt: new Date()
                }
              });
            }
          }
        } catch (usrErr) {
          console.warn(`[RADIUS AUTO-PWD] Portal password update note for '${username}':`, usrErr.message);
        }

        updatedUsers.push({
          username,
          customerId: connectionUser.customerId,
          customerUniqueId: connectionUser.customer?.customerUniqueId || null,
          dialedPassword,
          updatedAt: new Date().toISOString()
        });
      }
    }

    return {
      success: true,
      enabled: true,
      totalRejectionsScanned: rejectedLogs.length,
      updatedUsersCount: updatedUsers.length,
      updatedUsers
    };
  } catch (error) {
    console.error('[RADIUS AUTO-PWD] Error during auto reconciliation:', error);
    return {
      success: false,
      enabled: true,
      error: error.message
    };
  }
}

/**
 * Handle live real-time FreeRADIUS REST webhook (rlm_rest authorize / post-auth)
 */
async function handleLiveRadiusAuthHook(payload, prisma) {
  const {
    username,
    password,
    pass,
    reply,
    callingStationId,
    nasIp,
    ispId = 1
  } = payload || {};

  const dialedPassword = String(password || pass || '').trim();
  const rawUsername = String(username || '').trim();

  if (!rawUsername || !dialedPassword) {
    return {
      success: false,
      status: 'error',
      message: 'Username and dialed password are required'
    };
  }

  const enabled = await isAutoRadiusPasswordEnabled(ispId, prisma);
  if (!enabled) {
    return {
      success: true,
      enabled: false,
      status: 'ignored',
      message: 'Auto-update RADIUS password option is disabled in Master Settings.'
    };
  }

  const connectionUser = await prisma.ConnectionUser.findFirst({
    where: {
      username: rawUsername,
      isDeleted: false
    },
    include: {
      customer: {
        include: {
          subscribedPkg: {
            include: { packagePlanDetails: true }
          }
        }
      }
    }
  });

  if (!connectionUser) {
    return {
      success: false,
      status: 'not_found',
      message: `Connection user '${rawUsername}' not found in database.`
    };
  }

  // Update password in DB & RADIUS
  if (connectionUser.password !== dialedPassword) {
    await prisma.ConnectionUser.update({
      where: { id: connectionUser.id },
      data: {
        password: dialedPassword,
        updatedAt: new Date()
      }
    });

    const radiusClient = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, connectionUser.ispId || ispId).catch(() => null);
    if (radiusClient) {
      await radiusClient.updateUserPassword(rawUsername, dialedPassword).catch(() => {});
    }

    try {
      if (connectionUser.customerId) {
        const portalUser = await prisma.User.findFirst({
          where: { customerId: connectionUser.customerId }
        });
        if (portalUser) {
          const passwordHash = await bcrypt.hash(dialedPassword, 10);
          await prisma.User.update({
            where: { id: portalUser.id },
            data: {
              passwordHash,
              updatedAt: new Date()
            }
          });
        }
      }
    } catch (_) {}

    console.log(`[RADIUS AUTO-PWD HOOK] Real-time updated password for '${rawUsername}' to '${dialedPassword}'`);
  }

  // Return FreeRADIUS rlm_rest response allowing immediate connection
  const planCode = connectionUser.customer?.subscribedPkg?.packagePlanDetails?.planCode || 'DEFAULT';
  return {
    success: true,
    status: 'accepted',
    control: {
      'Auth-Type': 'Accept'
    },
    reply: {
      'Mikrotik-Group': planCode,
      'Filter-Id': planCode
    },
    message: `User '${rawUsername}' password synchronized and authenticated.`
  };
}

/**
 * Start periodic background sync worker
 */
let pollerIntervalId = null;

function startAutoRadiusPasswordPoller(prisma, intervalMs = 15000) {
  if (pollerIntervalId) {
    clearInterval(pollerIntervalId);
  }

  pollerIntervalId = setInterval(async () => {
    try {
      const isps = await prisma.iSP.findMany({
        where: { isActive: true, isDeleted: false },
        select: { id: true }
      }).catch(() => [{ id: 1 }]);

      for (const isp of isps) {
        const enabled = await isAutoRadiusPasswordEnabled(isp.id, prisma);
        if (enabled) {
          await syncRejectedDialInPasswords(isp.id, prisma).catch(() => {});
        }
      }
    } catch (err) {
      // Quiet poll error
    }
  }, intervalMs);

  pollerIntervalId.unref();
  console.log(`[RADIUS AUTO-PWD] Background auto-update sync service initialized (interval: ${intervalMs}ms)`);
}

module.exports = {
  isAutoRadiusPasswordEnabled,
  syncRejectedDialInPasswords,
  handleLiveRadiusAuthHook,
  startAutoRadiusPasswordPoller
};
