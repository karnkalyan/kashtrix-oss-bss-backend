// src/controllers/apiToken.controller.js
const crypto = require('crypto');
const net = require('net');
const { API_SCOPE_CATALOG, EXTERNAL_API_ROUTES } = require('../lib/externalApiCatalog');
const ALLOWED_SCOPES = new Set(API_SCOPE_CATALOG.map(scope => scope.value));

function hashToken(rawToken) {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function generateRawToken() {
    const bytes = crypto.randomBytes(32).toString('hex');
    return `ks_live_${bytes}`;
}

function parseScopes(value) {
    if (Array.isArray(value)) return value.map(String);
    try {
        const parsed = JSON.parse(value || '[]');
        if (Array.isArray(parsed)) return parsed.map(String);
    } catch { /* fall through to comma-separated format */ }
    return String(value || '').split(',').map(scope => scope.trim()).filter(Boolean);
}

function validateScopes(value) {
    const scopes = [...new Set(parseScopes(value))];
    if (!scopes.length) return { error: 'At least one API scope is required' };
    const invalid = scopes.filter(scope => scope !== '*' && !ALLOWED_SCOPES.has(scope));
    if (invalid.length) return { error: `Unsupported API scopes: ${invalid.join(', ')}` };
    return { scopes };
}

function validateIpRestrictions(value) {
    if (!value) return { normalized: null };
    const items = [...new Set(String(value).split(',').map(item => item.trim()).filter(Boolean))];
    const invalid = items.filter(item => item !== '*' && !net.isIP(item));
    if (invalid.length) return { error: `Invalid allowed IP addresses: ${invalid.join(', ')}` };
    return { normalized: items.join(',') || null };
}

function requireApiScope(...required) {
    return (req, res, next) => {
        const scopes = parseScopes(req.apiToken?.scopes);
        if (scopes.includes('*') || required.some(scope => scopes.includes(scope))) return next();
        return res.status(403).json({ error: 'Forbidden: API token scope is insufficient', requiredScopes: required });
    };
}

async function listTokens(req, res, next) {
    try {
        const ispId = Number(req.ispId);
        const tokens = await req.prisma.apiToken.findMany({
            where: { ispId, isRevoked: false },
            select: {
                id: true,
                tokenPrefix: true,
                name: true,
                description: true,
                scopes: true,
                ipRestrictions: true,
                branchId: true,
                resellerId: true,
                lastUsedAt: true,
                expiresAt: true,
                createdAt: true,
            },
            orderBy: { createdAt: 'desc' }
        });
        return res.json({ success: true, data: tokens });
    } catch (err) {
        return next(err);
    }
}

async function createToken(req, res, next) {
    try {
        const ispId = Number(req.ispId);
        const { name, description, scopes, ipRestrictions, expiresInDays, branchId, resellerId } = req.body;

        if (!String(name || '').trim()) {
            return res.status(400).json({ success: false, error: 'Token name is required' });
        }
        const scopeResult = validateScopes(scopes);
        if (scopeResult.error) return res.status(400).json({ success: false, error: scopeResult.error });
        const ipResult = validateIpRestrictions(ipRestrictions);
        if (ipResult.error) return res.status(400).json({ success: false, error: ipResult.error });
        if (branchId && resellerId) {
            return res.status(400).json({ success: false, error: 'A token can be restricted to a branch or reseller, not both' });
        }
        const effectiveBranchId = req.branchId ? Number(req.branchId) : (branchId ? Number(branchId) : null);
        const effectiveResellerId = req.user?.resellerId ? Number(req.user.resellerId) : (resellerId ? Number(resellerId) : null);
        if (branchId && req.branchId && Number(branchId) !== Number(req.branchId)) {
            return res.status(403).json({ success: false, error: 'Cannot create a token for another branch' });
        }
        if (resellerId && req.user?.resellerId && Number(resellerId) !== Number(req.user.resellerId)) {
            return res.status(403).json({ success: false, error: 'Cannot create a token for another reseller' });
        }
        if (effectiveBranchId) {
            const branch = await req.prisma.branch.findFirst({ where: { id: effectiveBranchId, ispId } });
            if (!branch) return res.status(400).json({ success: false, error: 'Branch restriction is invalid' });
        }
        if (effectiveResellerId) {
            const reseller = await req.prisma.reseller.findFirst({ where: { id: effectiveResellerId, ispId, isDeleted: false } });
            if (!reseller) return res.status(400).json({ success: false, error: 'Reseller restriction is invalid' });
        }

        const rawToken = generateRawToken();
        const tokenHash = hashToken(rawToken);
        const tokenPrefix = rawToken.slice(0, 13) + '...';

        let expiresAt = null;
        if (expiresInDays && Number(expiresInDays) > 0) {
            const days = Math.min(3650, Math.max(1, Math.floor(Number(expiresInDays))));
            expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
        }

        const token = await req.prisma.apiToken.create({
            data: {
                tokenHash,
                tokenPrefix,
                name: String(name).trim().slice(0, 100),
                description: description || null,
                scopes: JSON.stringify(scopeResult.scopes),
                ipRestrictions: ipResult.normalized,
                branchId: effectiveBranchId,
                resellerId: effectiveResellerId,
                createdById: req.user?.id || 1,
                ispId,
                expiresAt
            }
        });

        // Audit log
        await req.prisma.auditLog.create({
            data: {
                ispId,
                userId: req.user?.id || 1,
                action: 'API_TOKEN_CREATED',
                details: `Created API token '${name}' (${tokenPrefix})`,
                ip: req.ip || '127.0.0.1'
            }
        }).catch(() => { });

        return res.status(201).json({
            success: true,
            message: 'API token created successfully. Copy this token now as it will not be displayed again!',
            rawToken, // Full raw token shown ONLY ONCE
            token: {
                id: token.id,
                name: token.name,
                tokenPrefix: token.tokenPrefix,
                scopes: scopeResult.scopes,
                expiresAt: token.expiresAt
            }
        });
    } catch (err) {
        return next(err);
    }
}

async function getApiDocumentation(req, res) {
    const origin = `${req.protocol}://${req.get('host')}`;
    return res.json({
        success: true,
        data: {
            title: 'Kashtrix OSS/BSS External API',
            version: 'v1',
            baseUrl: `${origin}/api/v1`,
            authentication: {
                scheme: 'Bearer',
                header: 'Authorization: Bearer ks_live_your_token',
                note: 'The full token is displayed only once when it is created or rotated.',
            },
            scopes: API_SCOPE_CATALOG,
            routes: EXTERNAL_API_ROUTES,
            examples: {
                curl: `curl -H "Authorization: Bearer ks_live_your_token" "${origin}/api/v1/customers?page=1&limit=20"`,
                javascript: `const response = await fetch("${origin}/api/v1/customers", { headers: { Authorization: "Bearer ks_live_your_token" } });\nconst result = await response.json();`,
            },
        },
    });
}

async function revokeToken(req, res, next) {
    try {
        const id = Number(req.params.id);
        const ispId = Number(req.ispId);

        const token = await req.prisma.apiToken.findFirst({
            where: { id, ispId }
        });
        if (!token) {
            return res.status(404).json({ success: false, error: 'Token not found' });
        }

        await req.prisma.apiToken.update({
            where: { id },
            data: { isRevoked: true }
        });

        // Audit log
        await req.prisma.auditLog.create({
            data: {
                ispId,
                userId: req.user?.id || 1,
                action: 'API_TOKEN_REVOKED',
                details: `Revoked API token '${token.name}' (${token.tokenPrefix})`,
                ip: req.ip || '127.0.0.1'
            }
        }).catch(() => { });

        return res.json({ success: true, message: 'Token revoked successfully' });
    } catch (err) {
        return next(err);
    }
}

async function rotateToken(req, res, next) {
    try {
        const id = Number(req.params.id);
        const ispId = Number(req.ispId);

        const oldToken = await req.prisma.apiToken.findFirst({
            where: { id, ispId, isRevoked: false }
        });
        if (!oldToken) {
            return res.status(404).json({ success: false, error: 'Token not found or already revoked' });
        }

        const rawToken = generateRawToken();
        const tokenHash = hashToken(rawToken);
        const tokenPrefix = rawToken.slice(0, 13) + '...';

        await req.prisma.apiToken.update({
            where: { id },
            data: {
                tokenHash,
                tokenPrefix,
                updatedAt: new Date()
            }
        });
        await req.prisma.auditLog.create({
            data: {
                ispId,
                userId: req.user?.id || oldToken.createdById,
                action: 'API_TOKEN_ROTATED',
                details: `Rotated API token '${oldToken.name}' (${tokenPrefix})`,
                ip: req.ip || '127.0.0.1'
            }
        }).catch(() => { });

        return res.json({
            success: true,
            message: 'Token rotated successfully. Copy the new token below.',
            rawToken
        });
    } catch (err) {
        return next(err);
    }
}

/**
 * Bearer Token Middleware for Third-Party API Endpoints
 */
function authenticateApiToken(prisma) {
    return async (req, res, next) => {
        try {
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return res.status(401).json({ error: 'Unauthorized: Bearer token required' });
            }

            const rawToken = authHeader.split(' ')[1];
            if (!rawToken || !rawToken.startsWith('ks_')) {
                return res.status(401).json({ error: 'Unauthorized: Invalid token format' });
            }

            const hashed = hashToken(rawToken);
            const tokenRecord = await prisma.apiToken.findFirst({
                where: { tokenHash: hashed, isRevoked: false }
            });

            if (!tokenRecord) {
                return res.status(401).json({ error: 'Unauthorized: Invalid or revoked API token' });
            }

            if (tokenRecord.expiresAt && tokenRecord.expiresAt < new Date()) {
                return res.status(401).json({ error: 'Unauthorized: API token has expired' });
            }

            // IP restriction check
            if (tokenRecord.ipRestrictions) {
                const allowedIps = tokenRecord.ipRestrictions.split(',').map(i => i.trim().replace(/^::ffff:/, ''));
                const clientIp = String(req.ip || req.connection.remoteAddress || '').replace(/^::ffff:/, '');
                if (!allowedIps.includes(clientIp) && !allowedIps.includes('*')) {
                    return res.status(403).json({ error: 'Forbidden: IP address not allowed' });
                }
            }

            // Touch lastUsedAt asynchronously
            prisma.apiToken.update({
                where: { id: tokenRecord.id },
                data: { lastUsedAt: new Date() }
            }).catch(() => { });

            req.apiToken = tokenRecord;
            req.ispId = tokenRecord.ispId;
            req.branchId = tokenRecord.branchId;
            req.resellerId = tokenRecord.resellerId;
            req.apiScopes = parseScopes(tokenRecord.scopes);

            prisma.auditLog.create({ data: {
                ispId: tokenRecord.ispId,
                userId: tokenRecord.createdById,
                action: 'API_TOKEN_USED',
                details: JSON.stringify({ tokenId: tokenRecord.id, method: req.method, path: req.originalUrl }),
                ip: clientIp || null,
            } }).catch(() => {});

            next();
        } catch (err) {
            return next(err);
        }
    };
}

module.exports = {
    listTokens,
    createToken,
    revokeToken,
    rotateToken,
    getApiDocumentation,
    authenticateApiToken,
    requireApiScope,
    parseScopes,
    validateScopes,
    validateIpRestrictions,
    hashToken,
    generateRawToken
};
