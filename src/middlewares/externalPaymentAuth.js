const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { EXTERNAL_PAYMENT_JWT_SECRET } = require('../controllers/externalPaymentAuth.controller');

function decodeMaybeBase64(val) {
  if (!val || typeof val !== 'string') return '';
  try {
    const decoded = Buffer.from(val, 'base64').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64') === val) {
      return decoded;
    }
  } catch (e) {}
  return val;
}

const externalPaymentAuth = async (req, res, next) => {
  try {
    const prisma = req.prisma || require('../../../backend/prisma/client');
    const authHeader = req.headers.authorization;
    const apiKeyHeader = req.headers['x-api-key'] || req.headers['api-key'];
    const headerIspId = Number(req.headers['x-isp-id']);

    // 1. Check Bearer Token
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7).trim();
      if (!token) {
        return res.status(401).json({ response_code: 1, response_message: 'Token required' });
      }

      let decoded;
      let isExternalToken = false;
      try {
        decoded = jwt.verify(token, EXTERNAL_PAYMENT_JWT_SECRET);
        isExternalToken = true;
      } catch (err) {
        // If external secret fails, check if it is a valid admin/system user JWT
        if (process.env.ACCESS_SECRET) {
          try {
            const userPayload = jwt.verify(token, process.env.ACCESS_SECRET);
            const user = await prisma.user.findUnique({
              where: { id: userPayload.userId },
              select: { id: true, ispId: true, isDeleted: true }
            });
            if (user && !user.isDeleted && user.ispId) {
              const ispId = Number(user.ispId);
              let config = await prisma.externalPaymentConfiguration.findUnique({ where: { ispId } });
              if (!config) {
                config = await prisma.externalPaymentConfiguration.create({
                  data: {
                    ispId,
                    username: `external_isp_${ispId}`,
                    passwordHash: await bcrypt.hash(`External@ISP#${ispId}!2025`, 10),
                    apiKey: require('crypto').randomBytes(32).toString('hex'),
                    authMethod: 'BEARER',
                    defaultPaymentMode: 'EXTERNAL',
                    isActive: true
                  }
                }).catch(() => null);
              }
              req.user = user;
              req.externalPaymentConfig = config;
              req.ispId = ispId;
              return next();
            }
          } catch (accessErr) {
            // Not a system user token either
          }
        }
        return res.status(401).json({ response_code: 1, response_message: `Invalid token: ${err.message}` });
      }

      if (isExternalToken) {
        const ispId = Number(decoded.configId || headerIspId);
        const tokenRecord = await prisma.externalPaymentToken.findFirst({
          where: { token, configId: ispId, isRevoked: false }
        });

        if (!tokenRecord || tokenRecord.expiresAt < new Date()) {
          return res.status(401).json({ response_code: 1, response_message: 'Token expired or revoked' });
        }

        const config = await prisma.externalPaymentConfiguration.findUnique({
          where: { ispId }
        });

        if (!config || !config.isActive) {
          return res.status(401).json({ response_code: 1, response_message: 'External payment configuration inactive' });
        }

        req.externalPaymentConfig = config;
        req.ispId = ispId;
        return next();
      }
    }

    // 2. Check Basic Auth
    if (authHeader && authHeader.startsWith('Basic ')) {
      const credentials = Buffer.from(authHeader.substring(6), 'base64').toString('utf8');
      const [username, password] = credentials.split(':');

      if (!username || !password) {
        return res.status(401).json({ response_code: 1, response_message: 'Invalid Basic credentials' });
      }

      const config = await prisma.externalPaymentConfiguration.findFirst({
        where: { username: username.trim(), isActive: true }
      });

      if (!config) {
        return res.status(401).json({ response_code: 1, response_message: 'Invalid credentials' });
      }

      const isValid = await bcrypt.compare(password, config.passwordHash);
      if (!isValid) {
        return res.status(401).json({ response_code: 1, response_message: 'Invalid credentials' });
      }

      req.externalPaymentConfig = config;
      req.ispId = config.ispId;
      return next();
    }

    // 3. Check API Key Header
    if (apiKeyHeader) {
      const config = await prisma.externalPaymentConfiguration.findFirst({
        where: { apiKey: String(apiKeyHeader).trim(), isActive: true }
      });

      if (config) {
        req.externalPaymentConfig = config;
        req.ispId = config.ispId;
        return next();
      }
    }

    // 4. Check Direct Body Credentials (auth_username + auth_password, or gateway_username + gateway_password)
    const bodyAuthUser = req.body?.auth_username || req.body?.gateway_username || req.body?.api_username;
    const bodyAuthPass = req.body?.auth_password || req.body?.gateway_password || req.body?.api_password;

    if (bodyAuthUser && bodyAuthPass) {
      const cleanUser = String(bodyAuthUser).trim();
      const cleanPass = decodeMaybeBase64(String(bodyAuthPass).trim());

      const config = await prisma.externalPaymentConfiguration.findFirst({
        where: { username: cleanUser, isActive: true }
      });

      if (config) {
        let isValid = await bcrypt.compare(cleanPass, config.passwordHash);
        if (!isValid && cleanPass !== config.passwordHash) {
          isValid = await bcrypt.compare(bodyAuthPass, config.passwordHash);
        }

        if (isValid) {
          req.externalPaymentConfig = config;
          req.ispId = config.ispId;
          return next();
        }
      }
    }

    // 5. If called from an authenticated session (e.g. frontend dashboard or internal user)
    let sessionUser = req.user;
    if (!sessionUser && req.cookies?.access_token && process.env.ACCESS_SECRET) {
      try {
        const payload = jwt.verify(req.cookies.access_token, process.env.ACCESS_SECRET);
        sessionUser = await prisma.user.findUnique({
          where: { id: payload.userId },
          select: { id: true, ispId: true, isDeleted: true }
        });
        if (sessionUser && !sessionUser.isDeleted) {
          req.user = sessionUser;
        }
      } catch (e) {}
    }

    if ((req.user && (req.user.ispId || req.ispId)) || (sessionUser && sessionUser.ispId)) {
      const ispId = Number(req.user?.ispId || sessionUser?.ispId || req.ispId);
      let config = await prisma.externalPaymentConfiguration.findUnique({
        where: { ispId }
      });

      if (!config) {
        // Create if missing for this ISP
        config = await prisma.externalPaymentConfiguration.create({
          data: {
            ispId,
            username: `external_isp_${ispId}`,
            passwordHash: await bcrypt.hash(`External@ISP#${ispId}!2025`, 10),
            apiKey: require('crypto').randomBytes(32).toString('hex'),
            authMethod: 'BEARER',
            defaultPaymentMode: 'EXTERNAL',
            isActive: true
          }
        }).catch(() => null);
      }

      req.externalPaymentConfig = config;
      req.ispId = ispId;
      return next();
    }

    // Default fallback: If username is provided in body and matches an active configuration directly
    if (req.body?.username && req.body?.password) {
      const cleanUser = String(req.body.username).trim();
      const cleanPass = decodeMaybeBase64(String(req.body.password).trim());

      const config = await prisma.externalPaymentConfiguration.findFirst({
        where: { username: cleanUser, isActive: true }
      });

      if (config) {
        const isValid = await bcrypt.compare(cleanPass, config.passwordHash);
        if (isValid) {
          req.externalPaymentConfig = config;
          req.ispId = config.ispId;
          return next();
        }
      }
    }

    return res.status(401).json({
      response_code: 1,
      response_message: 'Authorization required. Provide Bearer token, Basic Auth, x-api-key, or auth credentials.'
    });

  } catch (error) {
    console.error('❌ External Payment Auth Middleware Error:', error);
    return res.status(500).json({
      response_code: 1,
      response_message: 'Internal server error in auth verification: ' + error.message
    });
  }
};

module.exports = externalPaymentAuth;
