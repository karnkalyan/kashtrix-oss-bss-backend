const axios = require('axios');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// In-memory sessions cache for Unofficial QR WhatsApp
const qrSessions = new Map();
const whatsappClients = new Map();
const intentionalDisconnects = new Set();
const reconnectTimers = new Map();
const localAuthPath = path.resolve(__dirname, '../../.wwebjs_auth');

let isInstallingPuppeteerBrowser = false;

function resolveChromeExecutablePath() {
    // 1. Explicit environment overrides
    const envCandidate = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_BIN || process.env.CHROME_PATH;
    if (envCandidate) {
        try {
            if (fs.existsSync(envCandidate)) return envCandidate;
        } catch (_) {}
    }

    // 2. Linux / Docker common paths
    const linuxCandidates = [
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/snap/bin/chromium',
        '/snap/bin/google-chrome',
        '/usr/lib/chromium/chromium',
        '/usr/bin/brave-browser'
    ];
    for (const cand of linuxCandidates) {
        try {
            if (fs.existsSync(cand)) return cand;
        } catch (_) {}
    }

    // 3. Windows common paths
    const winCandidates = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : null
    ].filter(Boolean);
    for (const cand of winCandidates) {
        try {
            if (fs.existsSync(cand)) return cand;
        } catch (_) {}
    }

    return null;
}

function triggerBrowserInstall(onComplete) {
    if (isInstallingPuppeteerBrowser) return;
    isInstallingPuppeteerBrowser = true;
    console.log('[WhatsApp Service] Missing browser binary. Auto-executing: npx puppeteer browsers install chrome');
    exec('npx puppeteer browsers install chrome', { timeout: 180000 }, (error, stdout, stderr) => {
        isInstallingPuppeteerBrowser = false;
        if (error) {
            console.error('[WhatsApp Service] Puppeteer browser install failed:', error.message);
        } else {
            console.log('[WhatsApp Service] Puppeteer browser install succeeded:', stdout || stderr);
        }
        if (typeof onComplete === 'function') onComplete(error);
    });
}

class WhatsAppService {
    constructor() {
        this.inboundEventIds = new Map();
    }

    async normalizeIncomingMessage(client, message) {
        if (!message || message.fromMe || message.isStatus) return null;
        const sourceAddress = String(message.author || message.from || '');
        const chatAddress = String(message.from || '');
        // The inbox is for one-to-one customer chats. Group and broadcast events
        // must not be mixed into a customer's phone conversation.
        if (!sourceAddress || /@(g\.us|broadcast)$/i.test(chatAddress)) return null;
        if (!/@(c\.us|lid)$/i.test(sourceAddress)) return null;

        let phoneAddress = sourceAddress;
        if (/@lid$/i.test(sourceAddress) && typeof client?.getContactLidAndPhone === 'function') {
            try {
                const [mapping] = await client.getContactLidAndPhone([sourceAddress]);
                if (mapping?.pn) phoneAddress = mapping.pn;
            } catch (error) {
                console.warn('[WhatsApp Service] Could not map LID to phone number:', error.message);
            }
        }

        let displayName = '';
        try {
            const contact = await message.getContact();
            displayName = contact?.pushname || contact?.name || contact?.shortName || contact?.verifiedName || '';
            if (/@lid$/i.test(phoneAddress) && contact?.number) phoneAddress = String(contact.number);
        } catch (error) {
            console.warn('[WhatsApp Service] Could not resolve incoming contact:', error.message);
        }

        const phone = String(phoneAddress).replace(/@(?:c\.us|lid)$/i, '').replace(/[^0-9]/g, '');
        if (!phone) return null;
        const type = String(message.type || 'chat').toLowerCase();
        const mediaLabels = {
            image: '[Image]', video: '[Video]', audio: '[Audio]', ptt: '[Voice message]',
            document: '[Document]', sticker: '[Sticker]', location: '[Location]',
            vcard: '[Contact]', multi_vcard: '[Contacts]'
        };
        const body = String(message.body || '').trim() || mediaLabels[type] || `[${type.replace(/_/g, ' ')} message]`;
        return {
            phone,
            displayName,
            body,
            direction: 'INBOUND',
            provider: 'QR',
            messageId: message.id?._serialized || message.id?.id || null,
            status: 'RECEIVED',
            occurredAt: Number(message.timestamp) > 0 ? new Date(Number(message.timestamp) * 1000) : new Date()
        };
    }

    async handleIncomingMessage(ispId, client, message) {
        try {
            const normalized = await this.normalizeIncomingMessage(client, message);
            if (!normalized) return null;
            if (normalized.messageId) {
                const eventKey = `${Number(ispId)}:${normalized.messageId}`;
                if (this.inboundEventIds.has(eventKey)) return null;
                this.inboundEventIds.set(eventKey, Date.now());
                const expiry = Date.now() - 10 * 60 * 1000;
                for (const [key, seenAt] of this.inboundEventIds) {
                    if (seenAt < expiry) this.inboundEventIds.delete(key);
                }
            }
            const saved = await this.recordChatMessage(ispId, normalized);
            // Both message_create and message can report the same inbound event.
            // Only the handler that persisted it may run automation or broadcast it.
            if (!saved) return null;
            if (global.wsManager?.broadcastToRoom) {
                global.wsManager.broadcastToRoom(`isp_${ispId}`, 'whatsapp.message.received', {
                    ...saved,
                    phone: normalized.phone,
                    displayName: normalized.displayName
                });
            }
            await this.runAutomation(ispId, normalized.phone, normalized.body);
            return saved;
        } catch (error) {
            console.error('[WhatsApp Incoming Message Error]:', error.message);
            return null;
        }
    }

    async isExplicitlyDisconnected(ispId) {
        const setting = await prisma.iSPSettings.findFirst({
            where: { ispId: Number(ispId), key: `whatsappQrExplicitlyDisconnected:${ispId}` },
            select: { value: true }
        });
        return String(setting?.value || '').toLowerCase() === 'true';
    }

    async setExplicitlyDisconnected(ispId, disconnected) {
        const key = `whatsappQrExplicitlyDisconnected:${ispId}`;
        await prisma.iSPSettings.upsert({
            where: { key },
            update: { value: String(Boolean(disconnected)), updatedAt: new Date() },
            create: { ispId: Number(ispId), key, value: String(Boolean(disconnected)), description: 'Whether the WhatsApp QR session was intentionally disconnected by a user', updatedAt: new Date() }
        });
    }

    async initializePersistedSessions() {
        const providerSettings = await prisma.iSPSettings.findMany({
            where: {
                OR: [
                    { key: 'whatsappProvider' },
                    { key: { startsWith: 'whatsappProvider:' } }
                ]
            },
            select: { ispId: true }
        });
        const ispIds = [...new Set(providerSettings.map(setting => Number(setting.ispId)).filter(Boolean))];
        const results = [];
        for (const ispId of ispIds) {
            const settings = await this.getSettings(ispId);
            if (settings.provider !== 'QR') continue;
            if (await this.isExplicitlyDisconnected(ispId)) {
                intentionalDisconnects.add(ispId);
                qrSessions.set(ispId, { sessionId: `session_${ispId}`, state: 'DISCONNECTED', qrCode: '', error: 'Disconnected by user', createdAt: Date.now() });
                results.push({ ispId, state: 'DISCONNECTED', skipped: true });
                continue;
            }
            intentionalDisconnects.delete(ispId);
            const session = await this.generateQrSession(ispId, { autoRestore: true });
            results.push({ ispId, state: session.state, skipped: false });
        }
        console.log(`[WhatsApp Service] Restoring ${results.filter(result => !result.skipped).length} persisted LocalAuth session(s)`);
        return results;
    }

    /**
     * Get WhatsApp settings for an ISP
     */
    async getSettings(ispId) {
        const settings = await prisma.iSPSettings.findMany({
            where: { ispId }
        });
        
        const tenantSuffix = `:${ispId}`;
        const settingsObj = settings.reduce((acc, s) => {
            const scoped = s.key.endsWith(tenantSuffix);
            const key = scoped ? s.key.slice(0, -tenantSuffix.length) : s.key;
            if (scoped || acc[key] === undefined) acc[key] = s.value;
            return acc;
        }, {});
        const provider = settingsObj.whatsappProvider || 'META';
        const explicitlyDisconnected = String(settingsObj.whatsappQrExplicitlyDisconnected || '').toLowerCase() === 'true';
        if (provider === 'QR' && !qrSessions.has(Number(ispId))) {
            if (explicitlyDisconnected) {
                intentionalDisconnects.add(Number(ispId));
                qrSessions.set(Number(ispId), { sessionId: `session_${ispId}`, state: 'DISCONNECTED', qrCode: '', error: 'Disconnected by user', createdAt: Date.now() });
            } else {
                await this.generateQrSession(Number(ispId), { autoRestore: true });
            }
        }
        const qrSession = qrSessions.get(Number(ispId));
        
        return {
            provider, // META or QR
            metaPhoneId: settingsObj.whatsappPhoneNumberId || '',
            metaAccountId: settingsObj.whatsappBusinessAccountId || '',
            metaToken: settingsObj.whatsappAccessTokenConfigured ? '********' : (settingsObj.whatsappAccessToken || ''),
            metaTokenRaw: settingsObj.whatsappAccessToken || '',
            qrSessionId: settingsObj.whatsappQrSessionId || `session_${ispId}`,
            qrState: qrSession?.state || 'DISCONNECTED',
            qrCode: qrSession?.qrCode || '',
            qrError: qrSession?.error || '',
            explicitlyDisconnected
        };
    }

    /**
     * Update WhatsApp settings
     */
    async updateSettings(ispId, config) {
        const settingsToSave = [];
        const scopedKey = (key) => `${key}:${ispId}`;
        
        if (config.provider !== undefined) {
            settingsToSave.push({ key: scopedKey('whatsappProvider'), value: String(config.provider), description: 'WhatsApp provider: META or QR' });
        }
        if (config.metaPhoneId !== undefined) {
            settingsToSave.push({ key: scopedKey('whatsappPhoneNumberId'), value: String(config.metaPhoneId), description: 'Meta WhatsApp Phone Number ID' });
        }
        if (config.metaAccountId !== undefined) {
            settingsToSave.push({ key: scopedKey('whatsappBusinessAccountId'), value: String(config.metaAccountId), description: 'Meta WhatsApp Business Account ID' });
        }
        if (config.metaToken !== undefined && config.metaToken !== '********') {
            settingsToSave.push({ key: scopedKey('whatsappAccessToken'), value: String(config.metaToken), description: 'Meta WhatsApp Access Token' });
        }

        const operations = settingsToSave.map(s =>
            prisma.iSPSettings.upsert({
                where: { key: s.key },
                update: { value: s.value, updatedAt: new Date() },
                create: { key: s.key, value: s.value, ispId, updatedAt: new Date() }
            })
        );

        if (operations.length > 0) {
            await prisma.$transaction(operations);
        }

        return this.getSettings(ispId);
    }

    /**
     * Start/Generate QR Code Session for Unofficial QR WhatsApp
     */
    async generateQrSession(ispId, options = {}) {
        ispId = Number(ispId);
        const sessionId = `session_${ispId}`;
        const currentSession = qrSessions.get(ispId);
        if (!options.force && whatsappClients.has(ispId) && ['CONNECTING', 'QR_READY', 'CONNECTED'].includes(currentSession?.state)) {
            return currentSession;
        }

        if (!options.autoRestore) {
            intentionalDisconnects.delete(ispId);
            await this.setExplicitlyDisconnected(ispId, false);
        }
        
        // Destroy existing client if any
        if (whatsappClients.has(ispId)) {
            try {
                await whatsappClients.get(ispId).destroy();
            } catch (e) {}
            whatsappClients.delete(ispId);
        }

        const session = {
            sessionId,
            state: 'CONNECTING',
            qrCode: '',
            error: '',
            createdAt: Date.now()
        };
        qrSessions.set(ispId, session);

        try {
            const { Client, LocalAuth } = require('whatsapp-web.js');
            const client = new Client({
                authStrategy: new LocalAuth({
                    clientId: sessionId,
                    dataPath: localAuthPath
                }),
                puppeteer: {
                    headless: true,
                    executablePath: resolveChromeExecutablePath() || undefined,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-gpu',
                        '--no-first-run',
                        '--no-zygote',
                        '--single-process',
                        '--disable-extensions'
                    ]
                }
            });

            client.on('qr', async (qr) => {
                try {
                    const dataUrl = await QRCode.toDataURL(qr);
                    const current = qrSessions.get(ispId);
                    if (current) {
                        current.state = 'QR_READY';
                        current.qrCode = dataUrl;
                        current.error = '';
                    }
                } catch (e) {
                    console.error('[WhatsApp Service] QR Generation Error:', e);
                }
            });

            client.on('ready', () => {
                intentionalDisconnects.delete(ispId);
                const current = qrSessions.get(ispId);
                if (current) {
                    current.state = 'CONNECTED';
                    current.qrCode = '';
                }
                console.log(`[WhatsApp Service] Unofficial Client ready for ISP ${ispId}`);
            });

            const receiveMessage = (message) => this.handleIncomingMessage(ispId, client, message);
            client.on('message', receiveMessage);
            // message_create is also observed because recent multi-device builds can
            // emit it before/without the narrower message event. The DB message ID
            // uniqueness constraint safely removes duplicate delivery.
            client.on('message_create', receiveMessage);

            client.on('auth_failure', (msg) => {
                console.error('[WhatsApp Service] Auth Failure:', msg);
                const current = qrSessions.get(ispId);
                if (current) {
                    current.state = 'DISCONNECTED';
                    current.qrCode = '';
                    current.error = String(msg || 'WhatsApp authentication failed');
                }
            });

            client.on('disconnected', (reason) => {
                console.log('[WhatsApp Service] Client disconnected:', reason);
                const current = qrSessions.get(ispId);
                if (current) {
                    current.state = 'DISCONNECTED';
                    current.qrCode = '';
                    current.error = String(reason || 'WhatsApp disconnected');
                }
                whatsappClients.delete(ispId);
                if (!intentionalDisconnects.has(ispId) && !reconnectTimers.has(ispId)) {
                    const timer = setTimeout(async () => {
                        reconnectTimers.delete(ispId);
                        if (await this.isExplicitlyDisconnected(ispId)) return;
                        console.log(`[WhatsApp Service] Reconnecting persisted LocalAuth session for ISP ${ispId}`);
                        await this.generateQrSession(ispId, { autoRestore: true, force: true });
                    }, 5000);
                    timer.unref?.();
                    reconnectTimers.set(ispId, timer);
                }
            });

            const handlePuppeteerError = (err) => {
                const msg = String(err?.message || err || '');
                if (msg.includes('Could not find Chrome') || msg.includes('Failed to launch the browser process') || msg.includes('browser revision')) {
                    triggerBrowserInstall((installErr) => {
                        if (!installErr) {
                            console.log(`[WhatsApp Service] Chrome install finished. Auto-retrying session for ISP ${ispId} in 3s...`);
                            setTimeout(() => {
                                this.generateQrSession(ispId, { force: true }).catch(() => {});
                            }, 3000);
                        }
                    });
                    return 'Chrome browser binary was missing. Installation started automatically in the background (npx puppeteer browsers install chrome). Please wait 30 seconds and click "Retry Session".';
                }
                return msg;
            };

            // Start initialization
            client.initialize().catch(err => {
                console.error('[WhatsApp Service] Client initialization failed:', err.message);
                const current = qrSessions.get(ispId);
                if (current) {
                    current.state = 'ERROR';
                    current.qrCode = '';
                    current.error = handlePuppeteerError(err);
                }
                whatsappClients.delete(ispId);
            });

            whatsappClients.set(ispId, client);
        } catch (err) {
            session.state = 'ERROR';
            const msg = String(err?.message || err || '');
            if (msg.includes('Could not find Chrome') || msg.includes('browser revision')) {
                triggerBrowserInstall();
                session.error = 'Chrome browser binary was missing. Installation started in the background. Please wait 30 seconds and click "Retry Session".';
            } else {
                session.error = `WhatsApp Web client could not start: ${msg}`;
            }
            console.error('[WhatsApp Service] whatsapp-web.js startup error:', msg);
        }

        return session;
    }

    /**
     * Simulation is disabled: authentication must come from a real WhatsApp scan.
     */
    async simulateQrScan(ispId) {
        throw new Error('Simulated WhatsApp login is disabled. Scan the real QR code from WhatsApp Linked Devices.');
    }

    /**
     * Disconnect QR Session
     */
    async disconnectQrSession(ispId) {
        ispId = Number(ispId);
        intentionalDisconnects.add(ispId);
        await this.setExplicitlyDisconnected(ispId, true);
        if (reconnectTimers.has(ispId)) {
            clearTimeout(reconnectTimers.get(ispId));
            reconnectTimers.delete(ispId);
        }
        if (whatsappClients.has(ispId)) {
            try {
                const client = whatsappClients.get(ispId);
                await client.logout().catch(() => {});
                await client.destroy().catch(() => {});
            } catch (e) {}
            whatsappClients.delete(ispId);
        }
        qrSessions.set(ispId, {
            sessionId: `session_${ispId}`,
            state: 'DISCONNECTED',
            qrCode: '',
            error: 'Disconnected by user',
            createdAt: Date.now()
        });
        return {
            sessionId: `session_${ispId}`,
            state: 'DISCONNECTED',
            qrCode: ''
        };
    }

    /**
     * Send message using WhatsApp
     */
    async sendMessage(ispId, to, text, options = {}) {
        const settings = await this.getSettings(ispId);
        const cleanPhone = String(to).replace(/[^0-9]/g, '');

        if (settings.provider === 'META') {
            if (!settings.metaPhoneId || !settings.metaTokenRaw) {
                throw new Error('Meta WhatsApp is not fully configured (missing Phone Number ID or Access Token).');
            }
            
            const url = `https://graph.facebook.com/v20.0/${settings.metaPhoneId}/messages`;
            
            // Build body based on template request or text fallback
            const body = {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: cleanPhone
            };

            if (options.template) {
                body.type = 'template';
                body.template = {
                    name: options.template,
                    language: { code: options.languageCode || 'en' },
                    components: options.components || []
                };
            } else {
                body.type = 'text';
                body.text = { body: text };
            }

            try {
                console.log(`[Meta WhatsApp API] Sending message to: ${cleanPhone}`);
                const response = await axios.post(url, body, {
                    headers: {
                        Authorization: `Bearer ${settings.metaTokenRaw}`,
                        'Content-Type': 'application/json'
                    }
                });
                
                await prisma.serviceLog.create({
                    data: {
                        ispId,
                        serviceCode: 'WHATSAPP_META',
                        operation: 'sendMessage',
                        status: 'success',
                        message: `Sent to: ${cleanPhone}`,
                        data: response.data
                    }
                }).catch(() => {});

                const messageId = response.data?.messages?.[0]?.id || null;
                await this.recordChatMessage(ispId, { phone: cleanPhone, body: text, direction: 'OUTBOUND', provider: 'META', messageId, automated: Boolean(options.automated), sentByUserId: options.sentByUserId });
                return { success: true, messageId };
            } catch (error) {
                const errorMsg = error.response?.data?.error?.message || error.message;
                console.error('[Meta WhatsApp API Error]:', errorMsg);
                
                await prisma.serviceLog.create({
                    data: {
                        ispId,
                        serviceCode: 'WHATSAPP_META',
                        operation: 'sendMessage',
                        status: 'failed',
                        message: String(errorMsg),
                        data: { to: cleanPhone, errorResponse: error.response?.data || null }
                    }
                }).catch(() => {});

                throw new Error(`Meta API error: ${errorMsg}`);
            }
        } else {
            // Unofficial QR Code based message delivery
            let session = qrSessions.get(ispId);
            if (!session || !whatsappClients.has(ispId) || ['DISCONNECTED', 'ERROR'].includes(session.state)) {
                await this.generateQrSession(ispId);
                session = qrSessions.get(ispId);
            }
            if (session?.state === 'CONNECTING') {
                const deadline = Date.now() + 30000;
                while (Date.now() < deadline && qrSessions.get(ispId)?.state === 'CONNECTING') {
                    await new Promise((resolve) => setTimeout(resolve, 500));
                }
                session = qrSessions.get(ispId);
            }
            if (!session || session.state !== 'CONNECTED') {
                const detail = session?.state === 'QR_READY'
                    ? 'Scan the QR code in settings first.'
                    : (session?.error || 'Open settings and reconnect the WhatsApp session.');
                throw new Error(`Unofficial WhatsApp is not connected. ${detail}`);
            }

            if (whatsappClients.has(ispId)) {
                try {
                    const client = whatsappClients.get(ispId);
                    const chatId = `${cleanPhone}@c.us`;
                    const response = await client.sendMessage(chatId, text);
                    const messageId = response?.id?._serialized || response?.id?.id || response?._data?.id?._serialized || null;
                    
                    await prisma.serviceLog.create({
                        data: {
                            ispId,
                            serviceCode: 'WHATSAPP_QR',
                            operation: 'sendMessage',
                            status: 'success',
                            message: `Sent via real WhatsApp Web Client to: ${cleanPhone}`,
                            data: { to: cleanPhone, messageId }
                        }
                    }).catch(() => {});
                    
                    await this.recordChatMessage(ispId, { phone: cleanPhone, body: text, direction: 'OUTBOUND', provider: 'QR', messageId, automated: Boolean(options.automated), sentByUserId: options.sentByUserId });
                    return { success: true, messageId };
                } catch (err) {
                    console.error('[WhatsApp QR Send Error]:', err.message);
                    throw new Error(`WhatsApp Web JS send failed: ${err.message}`);
                }
            }
            throw new Error('WhatsApp reports connected but no live client is available. Generate and scan a new QR code.');
        }
    }

    async recordChatMessage(ispId, message) {
        const phone = String(message.phone || '').replace(/[^0-9]/g, '');
        if (!phone || !message.body) return null;
        try {
            if (message.messageId) {
                const existing = await prisma.whatsAppChatMessage.findUnique({
                    where: { ispId_messageId: { ispId: Number(ispId), messageId: String(message.messageId) } },
                    select: { id: true }
                });
                if (existing) return null;
            }
            const inbound = message.direction === 'INBOUND';
            const occurredAt = message.occurredAt instanceof Date && !Number.isNaN(message.occurredAt.getTime())
                ? message.occurredAt
                : new Date();
            const conversation = await prisma.whatsAppConversation.upsert({
                where: { ispId_phone: { ispId: Number(ispId), phone } },
                update: {
                    displayName: message.displayName || undefined,
                    lastMessage: String(message.body),
                    lastMessageAt: occurredAt,
                    unreadCount: inbound ? { increment: 1 } : undefined
                },
                create: {
                    ispId: Number(ispId),
                    phone,
                    displayName: message.displayName || null,
                    lastMessage: String(message.body),
                    lastMessageAt: occurredAt,
                    unreadCount: inbound ? 1 : 0
                }
            });
            return await prisma.whatsAppChatMessage.create({
                data: {
                    ispId: Number(ispId),
                    conversationId: conversation.id,
                    direction: message.direction || 'OUTBOUND',
                    provider: message.provider || 'QR',
                    messageId: message.messageId || null,
                    body: String(message.body),
                    status: message.status || 'SENT',
                    automated: Boolean(message.automated),
                    sentByUserId: message.sentByUserId || null,
                    createdAt: occurredAt
                }
            });
        } catch (error) {
            if (error.code === 'P2002') return null;
            console.error('[WhatsApp Chat Persistence Error]:', error.message);
            return null;
        }
    }

    async listConversations(ispId) {
        return prisma.whatsAppConversation.findMany({
            where: { ispId: Number(ispId) },
            orderBy: [{ lastMessageAt: 'desc' }, { updatedAt: 'desc' }],
            take: 200
        });
    }

    async getConversationMessages(ispId, phone) {
        const cleanPhone = String(phone || '').replace(/[^0-9]/g, '');
        const conversation = await prisma.whatsAppConversation.findUnique({
            where: { ispId_phone: { ispId: Number(ispId), phone: cleanPhone } }
        });
        if (!conversation) return [];
        await prisma.whatsAppConversation.update({ where: { id: conversation.id }, data: { unreadCount: 0 } });
        return prisma.whatsAppChatMessage.findMany({
            where: { ispId: Number(ispId), conversationId: conversation.id },
            orderBy: { createdAt: 'asc' },
            take: 500
        });
    }

    async sendChatMessage(ispId, phone, body, sentByUserId) {
        if (!String(body || '').trim()) throw new Error('Message is required');
        return this.sendMessage(ispId, phone, String(body).trim(), { sentByUserId });
    }

    async listAutomationRules(ispId) {
        return prisma.whatsAppAutomationRule.findMany({
            where: { ispId: Number(ispId) },
            orderBy: [{ priority: 'asc' }, { id: 'asc' }]
        });
    }

    async saveAutomationRule(ispId, input) {
        const data = {
            name: String(input.name || '').trim(),
            triggerType: String(input.triggerType || 'KEYWORD').toUpperCase(),
            keywords: Array.isArray(input.keywords) ? input.keywords.map(String).filter(Boolean) : [],
            response: String(input.response || '').trim(),
            enabled: input.enabled !== false,
            priority: Number(input.priority) || 100,
            businessHoursOnly: Boolean(input.businessHoursOnly)
        };
        if (!data.name || !data.response) throw new Error('Rule name and response are required');
        if (input.id) {
            const existing = await prisma.whatsAppAutomationRule.findFirst({ where: { id: Number(input.id), ispId: Number(ispId) } });
            if (!existing) throw new Error('Automation rule not found for this ISP');
            return prisma.whatsAppAutomationRule.update({ where: { id: existing.id }, data });
        }
        return prisma.whatsAppAutomationRule.create({ data: { ...data, ispId: Number(ispId) } });
    }

    async deleteAutomationRule(ispId, id) {
        const result = await prisma.whatsAppAutomationRule.deleteMany({ where: { id: Number(id), ispId: Number(ispId) } });
        if (!result.count) throw new Error('Automation rule not found for this ISP');
        return { success: true };
    }

    async runAutomation(ispId, phone, incomingText) {
        const rules = await this.listAutomationRules(ispId);
        const text = String(incomingText || '').trim().toLowerCase();
        const hour = new Date().getHours();
        const active = rules.filter((rule) => rule.enabled && (!rule.businessHoursOnly || (hour >= 9 && hour < 18)));
        const rule = active.find((candidate) => {
            const words = Array.isArray(candidate.keywords) ? candidate.keywords.map((word) => String(word).toLowerCase().trim()).filter(Boolean) : [];
            if (candidate.triggerType === 'DEFAULT') return false;
            if (candidate.triggerType === 'EXACT') return words.some((word) => text === word);
            if (candidate.triggerType === 'CONTAINS' || candidate.triggerType === 'KEYWORD') return words.some((word) => text.includes(word));
            return false;
        }) || active.find((candidate) => candidate.triggerType === 'DEFAULT');
        if (!rule) return null;
        return this.sendMessage(ispId, phone, rule.response, { automated: true });
    }
}

module.exports = new WhatsAppService();
module.exports.WhatsAppService = WhatsAppService;
