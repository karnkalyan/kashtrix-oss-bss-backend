const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const EXTERNAL_PAYMENT_JWT_SECRET = process.env.EXTERNAL_PAYMENT_JWT_SECRET || 'KisanNet@EXTERNALPAYMENT2025AUTH';

async function generateExternalPaymentTokens(prisma, configId) {
  const accessTokenExpiry = 86400; // 24 hours (86400 seconds)
  const refreshTokenExpiry = 604800; // 7 days (604800 seconds)

  const accessToken = jwt.sign(
    {
      configId: Number(configId),
      ispId: Number(configId),
      type: 'access',
      service: 'EXTERNAL_PAYMENT',
      iat: Math.floor(Date.now() / 1000)
    },
    EXTERNAL_PAYMENT_JWT_SECRET,
    { expiresIn: accessTokenExpiry }
  );

  const refreshToken = jwt.sign(
    {
      configId: Number(configId),
      ispId: Number(configId),
      type: 'refresh',
      service: 'EXTERNAL_PAYMENT',
      iat: Math.floor(Date.now() / 1000)
    },
    EXTERNAL_PAYMENT_JWT_SECRET,
    { expiresIn: refreshTokenExpiry }
  );

  const accessTokenExpiresAt = new Date(Date.now() + (accessTokenExpiry * 1000));
  const refreshTokenExpiresAt = new Date(Date.now() + (refreshTokenExpiry * 1000));

  await prisma.$transaction([
    prisma.externalPaymentToken.create({
      data: {
        token: accessToken,
        configId: Number(configId),
        type: 'access',
        expiresAt: accessTokenExpiresAt,
        isRevoked: false
      }
    }),
    prisma.externalPaymentToken.create({
      data: {
        token: refreshToken,
        configId: Number(configId),
        type: 'refresh',
        expiresAt: refreshTokenExpiresAt,
        isRevoked: false
      }
    })
  ]);

  return {
    accessToken,
    refreshToken,
    expiresIn: accessTokenExpiry,
    refreshExpiresIn: refreshTokenExpiry
  };
}

function decodeMaybeBase64(val) {
  if (!val || typeof val !== 'string') return '';
  // Check if string looks like base64 and decode, fallback to original string
  try {
    const decoded = Buffer.from(val, 'base64').toString('utf8');
    // If decoded string re-encodes to same, or if it's plain ascii, use decoded if plausible
    if (Buffer.from(decoded, 'utf8').toString('base64') === val) {
      return decoded;
    }
  } catch (e) {}
  return val;
}

const getAccessToken = async (req, res) => {
  const prisma = req.prisma || require('../../../backend/prisma/client');

  try {
    const { grant_type = 'password', client_secret, api_key, username, password, refresh_token } = req.body;

    if (grant_type === 'refresh_token') {
      if (!refresh_token) {
        return res.status(400).json({ error: 'refresh_token is required' });
      }

      let decodedRefresh;
      try {
        decodedRefresh = jwt.verify(refresh_token, EXTERNAL_PAYMENT_JWT_SECRET);
      } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired refresh token' });
      }

      const tokenRecord = await prisma.externalPaymentToken.findFirst({
        where: {
          token: refresh_token,
          type: 'refresh',
          isRevoked: false,
          expiresAt: { gt: new Date() }
        }
      });

      if (!tokenRecord) {
        return res.status(401).json({ error: 'Refresh token expired or revoked' });
      }

      await prisma.externalPaymentToken.update({
        where: { id: tokenRecord.id },
        data: { isRevoked: true }
      });

      const tokens = await generateExternalPaymentTokens(prisma, decodedRefresh.configId);

      return res.json({
        access_token: tokens.accessToken,
        token_type: 'Bearer',
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refreshToken,
        refresh_token_expires_in: tokens.refreshExpiresIn
      });
    }

    // Default: password or client credentials
    if (!username || !password) {
      return res.status(400).json({
        error: 'username and password are required'
      });
    }

    const cleanUsername = String(username).trim();
    const cleanPassword = decodeMaybeBase64(String(password).trim());

    // Find configuration by username
    const config = await prisma.externalPaymentConfiguration.findFirst({
      where: {
        username: cleanUsername,
        isActive: true
      }
    });

    if (!config) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check password
    let isValidPassword = await bcrypt.compare(cleanPassword, config.passwordHash);
    if (!isValidPassword && cleanPassword !== config.passwordHash) {
      // Also test with raw password if user sent base64 decoded or vice versa
      isValidPassword = await bcrypt.compare(password, config.passwordHash);
    }

    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Optional API key / client secret check if configured and provided
    const providedSecret = decodeMaybeBase64(client_secret || api_key || '');
    if (config.apiKey && providedSecret && providedSecret !== config.apiKey) {
      return res.status(401).json({ error: 'Invalid client secret or API key' });
    }

    // Generate tokens
    const tokens = await generateExternalPaymentTokens(prisma, config.ispId);

    return res.json({
      access_token: tokens.accessToken,
      token_type: 'Bearer',
      expires_in: tokens.expiresIn,
      refresh_token: tokens.refreshToken,
      refresh_token_expires_in: tokens.refreshExpiresIn,
      isp_id: config.ispId
    });

  } catch (error) {
    console.error('❌ External payment auth error:', error);
    return res.status(500).json({ error: 'Authentication failed: ' + error.message });
  }
};

const login = async (req, res) => {
  return getAccessToken(req, res);
};

module.exports = {
  getAccessToken,
  login,
  generateExternalPaymentTokens,
  EXTERNAL_PAYMENT_JWT_SECRET
};
