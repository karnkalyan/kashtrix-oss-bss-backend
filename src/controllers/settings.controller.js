const whatsappService = require('../services/whatsapp.service');
const databaseBackupService = require('../services/database-backup.service');

/**
 * Get all ISP settings
 */
function isSystemAdmin(req) {
    const role = String(typeof req.user?.role === 'object' ? req.user.role?.name : req.user?.role || '').toLowerCase();
    return role === 'administrator' || role === 'admin' || role === 'super admin' || role === 'super_admin' || role.startsWith('global');
}

function canManageDatabaseBackups(req) {
    // A full SQL dump contains every tenant, so ISP-scoped admins must not access it.
    const role = String(typeof req.user?.role === 'object' ? req.user.role?.name : req.user?.role || '').trim().toLowerCase();
    return ['administrator', 'admin', 'super admin', 'super_admin'].includes(role) || role.startsWith('global');
}

const SENSITIVE_SETTING_KEYS = new Set([
    'appLicenseToken',
    'appHardwareFingerprint',
    'smtpPass',
    'imapPass',
    'freeCustomerSecretKey'
]);

const REDACTED_SETTING_VALUE = '********';

function sanitizeSettingsForResponse(settingsObj) {
    return Object.entries(settingsObj).reduce((acc, [key, value]) => {
        if (SENSITIVE_SETTING_KEYS.has(key)) {
            if (value) acc[`${key}Configured`] = 'true';
            return acc;
        }
        acc[key] = value;
        return acc;
    }, {});
}

function shouldSkipSensitiveWrite(key, value) {
    return SENSITIVE_SETTING_KEYS.has(key) && (!String(value || '').trim() || String(value) === REDACTED_SETTING_VALUE);
}

function normalizeSettingsInput(settings = []) {
    const normalized = [];
    const push = (key, value, description) => {
        if (shouldSkipSensitiveWrite(key, value)) return;
        normalized.push({ key, value: String(value), description });
    };

    settings.forEach((setting) => {
        push(setting.key, setting.value, setting.description);
        if (setting.key === 'emailNotifications') {
            push('enableMailNotifications', setting.value, 'Synced email notification setting');
        }
        if (setting.key === 'enableMailNotifications') {
            push('emailNotifications', setting.value, 'Synced email notification setting');
        }
        if (setting.key === 'smsNotifications') {
            push('enableSmsService', setting.value, 'Synced SMS notification setting');
        }
        if (setting.key === 'enableSmsService') {
            push('smsNotifications', setting.value, 'Synced SMS notification setting');
        }
    });

    const deduped = new Map();
    normalized.forEach((setting) => deduped.set(setting.key, setting));
    return Array.from(deduped.values());
}

async function getSettings(req, res, next) {
    try {
        const ispId = req.ispId;
        const settings = await req.prisma.iSPSettings.findMany({
            where: { ispId }
        });

        // Convert array to a key-value object for easier frontend use
        const settingsObj = settings.reduce((acc, s) => {
            acc[s.key] = s.value;
            return acc;
        }, {});

        res.json(sanitizeSettingsForResponse(settingsObj));
    } catch (err) {
        next(err);
    }
}

async function getCalendarSystem(req, res, next) {
    try {
        const setting = await req.prisma.iSPSettings.findFirst({
            where: { ispId: req.ispId, key: 'defaultCalendarSystem' },
            select: { value: true }
        });
        const system = String(setting?.value || 'AD').toUpperCase() === 'BS' ? 'BS' : 'AD';
        res.json({ system });
    } catch (err) {
        next(err);
    }
}

/**
 * Update or create a setting
 */
async function updateSetting(req, res, next) {
    try {
        if (!isSystemAdmin(req)) {
            return res.status(403).json({ error: 'Only system administrators can update master settings.' });
        }
        const { key, value, description } = req.body;
        const ispId = req.ispId;
        const normalizedSettings = normalizeSettingsInput([{ key, value, description }]);

        if (normalizedSettings.length === 0) {
            return res.json({ key, skipped: true, message: 'Sensitive setting was left unchanged.' });
        }

        const operations = normalizedSettings.map(setting =>
            req.prisma.iSPSettings.upsert({
                where: { key: setting.key },
                update: { value: setting.value, description: setting.description, updatedAt: new Date() },
                create: { key: setting.key, value: setting.value, description: setting.description, ispId, updatedAt: new Date() }
            })
        );

        const [updated] = await req.prisma.$transaction(operations);

        res.json(updated);
    } catch (err) {
        next(err);
    }
}

/**
 * Batch update settings
 */
async function batchUpdateSettings(req, res, next) {
    try {
        if (!isSystemAdmin(req)) {
            return res.status(403).json({ error: 'Only system administrators can update master settings.' });
        }
        const { settings } = req.body; // Expecting [{key, value, description}]
        const ispId = req.ispId;
        const normalizedSettings = normalizeSettingsInput(Array.isArray(settings) ? settings : []);

        const operations = normalizedSettings.map(s =>
            req.prisma.iSPSettings.upsert({
                where: { key: s.key }, // Note: key must be unique per ISP if we want this simple, or scoped
                update: { value: String(s.value), description: s.description, updatedAt: new Date() },
                create: { key: s.key, value: String(s.value), description: s.description, ispId, updatedAt: new Date() }
            })
        );

        if (operations.length > 0) {
            await req.prisma.$transaction(operations);
        }
        res.json({ message: 'Settings updated successfully' });
    } catch (err) {
        next(err);
    }
}

/**
 * Encode the plaintext credentials required by eSewa's access-token request.
 * Values are intentionally not persisted or logged.
 */
async function generateEsewaBase64(req, res, next) {
    try {
        if (!isSystemAdmin(req)) {
            return res.status(403).json({ error: 'Only system administrators can generate eSewa credentials.' });
        }

        const password = typeof req.body?.password === 'string' ? req.body.password : '';
        const clientSecret = typeof req.body?.clientSecret === 'string' ? req.body.clientSecret : '';

        if (!password || !clientSecret) {
            return res.status(400).json({ error: 'password and clientSecret are required' });
        }
        if (Buffer.byteLength(password, 'utf8') < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 bytes long' });
        }
        const secretLength = Buffer.byteLength(clientSecret, 'utf8');
        if (secretLength < 32 || secretLength > 64) {
            return res.status(400).json({ error: 'Client secret must be between 32 and 64 bytes long' });
        }

        return res.json({
            passwordBase64: Buffer.from(password, 'utf8').toString('base64'),
            clientSecretBase64: Buffer.from(clientSecret, 'utf8').toString('base64')
        });
    } catch (err) {
        next(err);
    }
}

async function getEsewaConfiguration(req, res, next) {
    try {
        const [tokenConfig, service] = await Promise.all([
            req.prisma.eSewaConfiguration.findUnique({ where: { ispId: req.ispId } }),
            req.prisma.iSPService.findFirst({
                where: { ispId: req.ispId, service: { code: 'ESEWA' }, isDeleted: false },
                select: { config: true, isActive: true, isEnabled: true }
            })
        ]);
        const serviceConfig = service?.config && typeof service.config === 'object' ? service.config : {};
        res.json({
            tokenEnabled: Boolean(tokenConfig?.isActive),
            epayEnabled: serviceConfig.epayEnabled !== false,
            username: tokenConfig?.username || 'esewa-client',
            passwordConfigured: Boolean(tokenConfig?.passwordHash),
            clientSecretConfigured: Boolean(tokenConfig?.clientSecret),
            serviceEnabled: Boolean(service?.isActive && service?.isEnabled)
        });
    } catch (err) { next(err); }
}

async function saveEsewaConfiguration(req, res, next) {
    try {
        if (!isSystemAdmin(req)) {
            return res.status(403).json({ error: 'Only system administrators can configure eSewa.' });
        }
        const { tokenEnabled, epayEnabled, username, password, clientSecret } = req.body || {};
        const cleanUsername = String(username || 'esewa-client').trim();
        const existing = await req.prisma.eSewaConfiguration.findUnique({ where: { ispId: req.ispId } });
        if (tokenEnabled && !existing && (!password || !clientSecret)) {
            return res.status(400).json({ error: 'Password and client secret are required when enabling token payment for the first time' });
        }
        if (clientSecret) {
            const length = Buffer.byteLength(String(clientSecret), 'utf8');
            if (length < 32 || length > 64) return res.status(400).json({ error: 'Client secret must be between 32 and 64 bytes long' });
        }
        if (password && Buffer.byteLength(String(password), 'utf8') < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 bytes long' });
        }

        const service = await req.prisma.iSPService.findFirst({
            where: { ispId: req.ispId, service: { code: 'ESEWA' }, isDeleted: false }
        });
        if (!service) return res.status(400).json({ error: 'Enable eSewa in the service catalog first' });
        const currentServiceConfig = service.config && typeof service.config === 'object' ? service.config : {};

        await req.prisma.$transaction(async tx => {
            await tx.iSPService.update({
                where: { id: service.id },
                data: { config: { ...currentServiceConfig, integrationMode: 'TOKEN_BASED', tokenEnabled: Boolean(tokenEnabled), epayEnabled: Boolean(epayEnabled) } }
            });
            const data = {
                username: cleanUsername,
                isActive: Boolean(tokenEnabled),
                authMethod: 'BEARER',
                ...(password ? { passwordHash: await bcrypt.hash(String(password), 10) } : {}),
                ...(clientSecret ? { clientSecret: String(clientSecret) } : {})
            };
            if (existing) {
                await tx.eSewaConfiguration.update({ where: { ispId: req.ispId }, data });
            } else if (password && clientSecret) {
                await tx.eSewaConfiguration.create({ data: { ispId: req.ispId, ...data } });
            }
        });
        res.json({ success: true, tokenEnabled: Boolean(tokenEnabled), epayEnabled: Boolean(epayEnabled), username: cleanUsername });
    } catch (err) { next(err); }
}

const RADIUS_POOLS_KEY = (ispId) => `isp:${ispId}:radiusPools`;

function normalizePool(input) {
    const value = String(input?.value || input?.name || '').trim();
    if (!value) return null;
    return {
        id: value,
        name: String(input?.name || value).trim(),
        value,
        description: String(input?.description || '').trim(),
        type: String(input?.type || 'ipv4').trim().toLowerCase(),
        isActive: input?.isActive === undefined ? true : Boolean(input.isActive),
    };
}

async function readRadiusPools(prisma, ispId) {
    const setting = await prisma.iSPSettings.findUnique({ where: { key: RADIUS_POOLS_KEY(ispId) } });
    if (!setting?.value) return [];
    try {
        const parsed = JSON.parse(setting.value);
        return Array.isArray(parsed) ? parsed.map(normalizePool).filter(Boolean) : [];
    } catch {
        return [];
    }
}

async function writeRadiusPools(prisma, ispId, pools) {
    const value = JSON.stringify(pools.map(normalizePool).filter(Boolean));
    return prisma.iSPSettings.upsert({
        where: { key: RADIUS_POOLS_KEY(ispId) },
        update: { value, description: 'RADIUS framed pool values', updatedAt: new Date() },
        create: { key: RADIUS_POOLS_KEY(ispId), value, description: 'RADIUS framed pool values', ispId, updatedAt: new Date() }
    });
}

async function listRadiusPools(req, res, next) {
    try {
        res.json({ success: true, data: await readRadiusPools(req.prisma, req.ispId) });
    } catch (err) {
        next(err);
    }
}

async function upsertRadiusPool(req, res, next) {
    try {
        if (!isSystemAdmin(req)) {
            return res.status(403).json({ error: 'Only system administrators can update RADIUS pools.' });
        }
        const pool = normalizePool(req.body);
        if (!pool) return res.status(400).json({ error: 'Pool value is required' });

        const pools = await readRadiusPools(req.prisma, req.ispId);
        const nextPools = pools.filter((item) => item.value !== pool.value);
        nextPools.push(pool);
        nextPools.sort((a, b) => a.name.localeCompare(b.name));
        await writeRadiusPools(req.prisma, req.ispId, nextPools);
        res.json({ success: true, data: pool, pools: nextPools });
    } catch (err) {
        next(err);
    }
}

async function deleteRadiusPool(req, res, next) {
    try {
        if (!isSystemAdmin(req)) {
            return res.status(403).json({ error: 'Only system administrators can update RADIUS pools.' });
        }
        const value = String(req.params.value || '').trim();
        const pools = await readRadiusPools(req.prisma, req.ispId);
        const nextPools = pools.filter((pool) => pool.value !== value);
        await writeRadiusPools(req.prisma, req.ispId, nextPools);
        res.json({ success: true, pools: nextPools });
    } catch (err) {
        next(err);
    }
}

async function getWhatsAppSettings(req, res, next) {
    try {
        const data = await whatsappService.getSettings(req.ispId);
        res.json(data);
    } catch (err) {
        next(err);
    }
}

async function updateWhatsAppSettings(req, res, next) {
    try {
        if (!isSystemAdmin(req)) {
            return res.status(403).json({ error: 'Only system administrators can update WhatsApp configurations.' });
        }
        const data = await whatsappService.updateSettings(req.ispId, req.body);
        res.json(data);
    } catch (err) {
        next(err);
    }
}

async function generateWhatsAppQr(req, res, next) {
    try {
        if (!isSystemAdmin(req)) {
            return res.status(403).json({ error: 'Only system administrators can manage WhatsApp sessions.' });
        }
        const data = await whatsappService.generateQrSession(req.ispId);
        res.json(data);
    } catch (err) {
        next(err);
    }
}

async function disconnectWhatsAppQr(req, res, next) {
    try {
        if (!isSystemAdmin(req)) {
            return res.status(403).json({ error: 'Only system administrators can manage WhatsApp sessions.' });
        }
        const data = await whatsappService.disconnectQrSession(req.ispId);
        res.json(data);
    } catch (err) {
        next(err);
    }
}

async function simulateWhatsAppQrScan(req, res, next) {
    try {
        if (!isSystemAdmin(req)) {
            return res.status(403).json({ error: 'Only system administrators can manage WhatsApp sessions.' });
        }
        const data = await whatsappService.simulateQrScan(req.ispId);
        res.json(data);
    } catch (err) {
        next(err);
    }
}

async function listWhatsAppChats(req, res, next) {
    try {
        res.json(await whatsappService.listConversations(req.ispId));
    } catch (err) { next(err); }
}

async function getWhatsAppChatMessages(req, res, next) {
    try {
        res.json(await whatsappService.getConversationMessages(req.ispId, req.params.phone));
    } catch (err) { next(err); }
}

async function sendWhatsAppChatMessage(req, res, next) {
    try {
        const data = await whatsappService.sendChatMessage(req.ispId, req.params.phone, req.body?.body, req.user?.id);
        res.json(data);
    } catch (err) { next(err); }
}

async function listWhatsAppAutomationRules(req, res, next) {
    try {
        res.json(await whatsappService.listAutomationRules(req.ispId));
    } catch (err) { next(err); }
}

async function saveWhatsAppAutomationRule(req, res, next) {
    try {
        if (!isSystemAdmin(req)) return res.status(403).json({ error: 'Only system administrators can manage WhatsApp automation.' });
        res.json(await whatsappService.saveAutomationRule(req.ispId, req.body));
    } catch (err) { next(err); }
}

async function deleteWhatsAppAutomationRule(req, res, next) {
    try {
        if (!isSystemAdmin(req)) return res.status(403).json({ error: 'Only system administrators can manage WhatsApp automation.' });
        res.json(await whatsappService.deleteAutomationRule(req.ispId, req.params.id));
    } catch (err) { next(err); }
}

async function getDatabaseBackupSettings(req, res, next) {
    try {
        if (!canManageDatabaseBackups(req)) {
            return res.status(403).json({ error: 'Only system administrators can access full database backups.' });
        }
        res.json(await databaseBackupService.getConfig(req.ispId));
    } catch (err) { next(err); }
}

async function updateDatabaseBackupSettings(req, res, next) {
    try {
        if (!canManageDatabaseBackups(req)) {
            return res.status(403).json({ error: 'Only system administrators can configure full database backups.' });
        }
        res.json(await databaseBackupService.saveConfig(req.ispId, req.body));
    } catch (err) {
        if (/valid|must|between|required/i.test(err.message)) return res.status(400).json({ error: err.message });
        next(err);
    }
}

async function runDatabaseBackupNow(req, res, next) {
    try {
        if (!canManageDatabaseBackups(req)) {
            return res.status(403).json({ error: 'Only system administrators can run full database backups.' });
        }
        const data = await databaseBackupService.runBackup(req.ispId, { trigger: 'manual' });
        res.json({ success: true, message: 'Database backup created and emailed successfully.', data });
    } catch (err) {
        if (/already running|configure a valid/i.test(err.message)) return res.status(409).json({ error: err.message });
        next(err);
    }
}

module.exports = {
    getSettings,
    getCalendarSystem,
    updateSetting,
    batchUpdateSettings,
    generateEsewaBase64,
    getEsewaConfiguration,
    saveEsewaConfiguration,
    listRadiusPools,
    upsertRadiusPool,
    deleteRadiusPool,
    getWhatsAppSettings,
    updateWhatsAppSettings,
    generateWhatsAppQr,
    disconnectWhatsAppQr,
    simulateWhatsAppQrScan,
    listWhatsAppChats,
    getWhatsAppChatMessages,
    sendWhatsAppChatMessage,
    listWhatsAppAutomationRules,
    saveWhatsAppAutomationRule,
    deleteWhatsAppAutomationRule,
    getDatabaseBackupSettings,
    updateDatabaseBackupSettings,
    runDatabaseBackupNow
};
const bcrypt = require('bcrypt');
