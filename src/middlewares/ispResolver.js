const jwt = require('jsonwebtoken');

/**
 * Middleware to resolve and attach req.ispId early in the Express pipeline
 * before licenseGuard and route handlers execute.
 * 
 * Supports:
 * 1. Explicit Header ('x-isp-id')
 * 2. Generated Username Pattern ('ext_isp<id>_...') in request body or Basic auth
 * 3. JWT Bearer Token payload (ispId, configId, esewaConfigId)
 * 4. Database configuration lookup for external payment / eSewa credentials
 */
function ispResolver(prisma) {
  return async (req, res, next) => {
    try {
      if (req.ispId) {
        return next();
      }

      // 1. Explicit header 'x-isp-id'
      const headerIsp = Number(req.headers['x-isp-id']);
      if (headerIsp && !isNaN(headerIsp)) {
        req.ispId = headerIsp;
        return next();
      }

      // 2. Authorization Header inspection
      const authHeader = req.headers.authorization;
      if (authHeader) {
        // Bearer Token
        if (authHeader.startsWith('Bearer ')) {
          const rawToken = authHeader.substring(7).trim();
          if (rawToken) {
            const decoded = jwt.decode(rawToken);
            if (decoded && typeof decoded === 'object') {
              const tokenIsp = Number(decoded.ispId || decoded.configId || decoded.esewaConfigId);
              if (tokenIsp && !isNaN(tokenIsp)) {
                req.ispId = tokenIsp;
                return next();
              }
            }
          }
        }

        // Basic Auth
        if (authHeader.startsWith('Basic ')) {
          try {
            const credentials = Buffer.from(authHeader.substring(6), 'base64').toString('utf8');
            const [basicUser] = credentials.split(':');
            if (basicUser) {
              const cleanUser = basicUser.trim();
              const match = cleanUser.match(/^ext_isp(\d+)_/i);
              if (match) {
                req.ispId = Number(match[1]);
                return next();
              }

              if (prisma?.externalPaymentConfiguration) {
                const config = await prisma.externalPaymentConfiguration.findFirst({
                  where: { username: cleanUser, isActive: true },
                  select: { ispId: true }
                });
                if (config?.ispId) {
                  req.ispId = Number(config.ispId);
                  return next();
                }
              }
            }
          } catch (e) {}
        }
      }

      // 3. Request Body inspection (for /login, /access-token, /inquiry, /payment)
      const bodyUser = req.body?.username || req.body?.auth_username || req.body?.gateway_username || req.body?.api_username;
      if (bodyUser && typeof bodyUser === 'string') {
        const cleanUser = bodyUser.trim();

        // Check if username has embedded ISP ID: ext_isp<id>_...
        const match = cleanUser.match(/^ext_isp(\d+)_/i);
        if (match) {
          req.ispId = Number(match[1]);
          return next();
        }

        // Check database for external payment configuration
        if (prisma?.externalPaymentConfiguration) {
          const config = await prisma.externalPaymentConfiguration.findFirst({
            where: { username: cleanUser, isActive: true },
            select: { ispId: true }
          });
          if (config?.ispId) {
            req.ispId = Number(config.ispId);
            return next();
          }
        }

        // Check database for eSewa configuration
        if (prisma?.eSewaConfiguration) {
          const esewaConfig = await prisma.eSewaConfiguration.findFirst({
            where: { username: cleanUser, isActive: true },
            select: { ispId: true }
          });
          if (esewaConfig?.ispId) {
            req.ispId = Number(esewaConfig.ispId);
            return next();
          }
        }
      }

      // 4. Check cookie token
      const cookieToken = req.cookies?.access_token;
      if (cookieToken) {
        const decoded = jwt.decode(cookieToken);
        if (decoded && typeof decoded === 'object') {
          const tokenIsp = Number(decoded.ispId || decoded.configId);
          if (tokenIsp && !isNaN(tokenIsp)) {
            req.ispId = tokenIsp;
            return next();
          }
        }
      }

    } catch (err) {
      // Non-blocking: If resolution fails, proceed to next middleware
    }
    next();
  };
}

module.exports = ispResolver;
