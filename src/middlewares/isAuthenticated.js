// src/middleware/authenticate.js
const jwt = require('jsonwebtoken');

if (!process.env.ACCESS_SECRET) {
  throw new Error('ACCESS_SECRET is not defined');
}

const ACCESS_SECRET = process.env.ACCESS_SECRET;

// In-memory cache for high-frequency user/role auth resolution
const userAuthCache = new Map();
const USER_CACHE_TTL_MS = 20000; // 20 seconds TTL

function getCachedUser(userId) {
  const cached = userAuthCache.get(userId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.user;
  }
  return null;
}

function setCachedUser(userId, user) {
  if (userAuthCache.size > 2000) {
    userAuthCache.clear();
  }
  userAuthCache.set(userId, { user, expiresAt: Date.now() + USER_CACHE_TTL_MS });
}

function invalidateUserAuthCache(userId) {
  if (userId) {
    userAuthCache.delete(userId);
  } else {
    userAuthCache.clear();
  }
}

module.exports = (prisma) => {
  const authMiddleware = async (req, res, next) => {
    req.prisma = prisma;

    // 1) Get token (cookie > header)
    let token = req.cookies?.access_token;

    if (!token && req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.slice(7).trim();
    }

    if (!token) {
      return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }

    // 2) Verify token
    let payload;
    try {
      payload = jwt.verify(token, ACCESS_SECRET);
    } catch (err) {
      return res.status(403).json({ error: 'Unauthorized: Invalid token' });
    }

    // 3) Load user + role + permissions (Cached with fast fallback)
    let user = getCachedUser(payload.userId);
    if (!user) {
      user = await prisma.user.findUnique({
        where: { id: payload.userId },
        select: {
          id: true,
          email: true,
          ispId: true,
          branchId: true,
          resellerId: true,
          isDeleted: true,
          yeastarExt: true,
          customerId: true,
          branch: {
            select: { id: true, parentId: true }
          },
          userBranches: {
            select: { branchId: true }
          },
          role: {
            select: {
              name: true,
              isActive: true,
              permissions: {
                select: { name: true }
              }
            }
          }
        }
      });

      if (user && !user.isDeleted && user.role?.isActive !== false) {
        setCachedUser(payload.userId, user);
      }
    }

    if (!user || user.isDeleted) {
      return res.status(401).json({ error: 'Unauthorized: User not found or deleted' });
    }

    if (user.role && user.role.isActive === false) {
      return res.status(403).json({ error: 'Unauthorized: Your role is currently deactivated' });
    }

    // 4) Branch Validation & Isolation
    const headerBranchId = req.headers['x-selected-branch-id'] || req.headers['x-branch-id'];
    let selectedBranchId = headerBranchId ? parseInt(headerBranchId) : user.branchId;

    // Admin bypasses branch checks; others must have explicit access
    const roleName = user.role?.name?.toLowerCase() || '';
    const isGlobal = roleName === 'administrator' || roleName === 'global manager' || roleName.startsWith('global ');
    const isHQ = user.branch && user.branch.parentId === null;
    const isAllAccess = isGlobal || isHQ;
    let hasAccess = isAllAccess || 
                     user.branchId === selectedBranchId || 
                     user.userBranches.some(ub => ub.branchId === selectedBranchId);

    // Fast bottom-up parent check for sub-branches
    if (selectedBranchId && !hasAccess) {
      const assignedIds = new Set();
      if (user.branchId) assignedIds.add(user.branchId);
      user.userBranches.forEach(ub => assignedIds.add(ub.branchId));

      let currentBranchId = selectedBranchId;
      while (currentBranchId && !hasAccess) {
        if (assignedIds.has(currentBranchId)) {
          hasAccess = true;
          break;
        }
        const b = await prisma.branch.findUnique({ where: { id: currentBranchId }, select: { parentId: true } });
        currentBranchId = b ? b.parentId : null;
      }
    }

    if (selectedBranchId && !hasAccess) {
      return res.status(403).json({ error: 'Access denied: You do not have permission for this branch' });
    }

    // 5) Attach normalized auth context
    req.user = {
      id: user.id,
      email: user.email,
      role: user.role?.name ?? null,
      permissions: user.role?.permissions.map(p => p.name) ?? [],
      ispId: user.ispId,
      branchId: user.branchId,
      selectedBranchId: selectedBranchId,
      extId: user.yeastarExt,
      customerId: user.customerId,
      resellerId: user.resellerId
    };

    req.ispId = user.ispId;
    req.selectedBranchId = selectedBranchId;
    req.branchId = isAllAccess ? null : selectedBranchId;
    req.extId = user.yeastarExt;

    next();
  };

  authMiddleware.invalidateUserAuthCache = invalidateUserAuthCache;
  return authMiddleware;
};

module.exports.invalidateUserAuthCache = invalidateUserAuthCache;
