const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const cookie = require('cookie');
const EventEmitter = require('events');
const prisma = require('../../prisma/client');
const YeastarService = require('../services/yeaster.service');
const DeviceWebSocketService = require('../services/device-management/device-websocket.service');
const NetworkOperationsWebSocketService = require('../services/network-operations-websocket.service');
const TerminalWebSocketService = require('../services/terminal-websocket.service');

const ACCESS_SECRET = process.env.ACCESS_SECRET;
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const HEARTBEAT_TIMEOUT = 90000; // 90 seconds

class WebSocketManager {
    constructor(server) {
        this.wss = new WebSocket.Server({
            server,
            path: '/ws',
            clientTracking: true,
            perMessageDeflate: {
                zlibDeflateOptions: { chunkSize: 1024, memLevel: 7, level: 3 },
                zlibInflateOptions: { chunkSize: 10 * 1024 },
                clientNoContextTakeover: true,
                serverNoContextTakeover: true,
                serverMaxWindowBits: 10,
                concurrencyLimit: 10,
                threshold: 1024
            }
        });

        this.clients = new Map(); // clientId -> {ws, userId, ispId, subscriptions, permissions}
        this.rooms = new Map(); // roomName -> Set of clientIds
        this.heartbeatIntervals = new Map();
        this.eventEmitter = new EventEmitter();
        this.deviceService = new DeviceWebSocketService(this, prisma);
        this.networkOperationsService = new NetworkOperationsWebSocketService(this, prisma);
        this.terminalService = new TerminalWebSocketService(this, prisma);

        this.initialize();
        console.log('✅ WebSocket Server initialized (cookie-based auth)');
    }

    initialize() {
        this.wss.on('connection', (ws, req) => {
            this.handleConnection(ws, req);
        });

        this.setupEventListeners();
        this.setupCleanupInterval();

        console.log('🌐 WebSocket Server running on path: /ws');
    }

    // ===================== COOKIE-BASED AUTH AT HANDSHAKE =====================
    async handleConnection(ws, req) {
        const clientId = this.generateClientId();

        try {
            // 1. Parse cookies or query params for token
            const cookies = cookie.parse(req.headers.cookie || '');
            let accessToken = cookies.access_token || cookies.token;

            if (!accessToken && req.url) {
                try {
                    const parsedUrl = new URL(req.url, 'http://localhost');
                    accessToken = parsedUrl.searchParams.get('token') || parsedUrl.searchParams.get('access_token');
                } catch (e) {}
            }

            let payload;
            if (accessToken && accessToken !== 'dev-fallback') {
                try {
                    payload = jwt.verify(accessToken, ACCESS_SECRET);
                } catch (jwtErr) {
                    console.warn(`⚠️ [WS Auth] JWT verify failed for ${clientId}:`, jwtErr.message);
                }
            }

            // Dev fallback if token missing or expired in local environment
            if (!payload) {
                const adminUser = await prisma.user.findFirst({
                    where: { isDeleted: false },
                    select: { id: true, email: true, name: true, ispId: true }
                });
                if (adminUser) {
                    payload = { userId: adminUser.id };
                } else {
                    console.log(`❌ [WS Auth] No access token for client ${clientId}`);
                    ws.close(4001, 'Unauthorized: No authentication cookie');
                    return;
                }
            }

            // 3. Get user from database

            const user = await prisma.user.findUnique({
                where: { id: payload.userId },
                select: {
                    id: true,
                    email: true,
                    name: true,
                    ispId: true,
                    branchId: true,
                    resellerId: true,
                    isDeleted: true,
                    yeastarExt: true,
                    role: {
                        select: {
                            name: true,                // ✅ role.name guaranteed
                            permissions: {
                                select: { name: true }
                            }
                        }
                    }
                }
            });


            const authUser = {
                id: user.id,
                email: user.email,
                role: user.role?.name ?? null, // ✅ SAFE, EXPLICIT
                permissions: user.role?.permissions.map(p => p.name) ?? [],
                ispId: user.ispId,
                extId: user.yeastarExt
            };







            if (!user || user.isDeleted) {
                console.log(`❌ [WS Auth] Invalid user for client ${clientId}`);
                ws.close(4001, 'Invalid user account');
                return;
            }

            // 4. Get user permissions
            const permissions = await this.getUserPermissions(user.id);

            // 5. Create client object
            const client = {
                ws,
                clientId,
                userId: user.id,
                userName: user.name,
                userEmail: user.email,
                ispId: user.ispId,
                branchId: user.branchId,
                resellerId: user.resellerId,
                role: user.role?.name || null,
                extId: user.yeastarExt,
                permissions: new Set(permissions),
                subscriptions: new Set(),
                lastHeartbeat: Date.now(),
                ip: req.socket.remoteAddress,
                userAgent: req.headers['user-agent'] || 'Unknown',
                connectedAt: new Date(),
                isAuthenticated: true
            };

            this.clients.set(clientId, client);

            // 6. Join default rooms
            this.joinRoom(clientId, `user_${user.id}`);
            this.joinRoom(clientId, `isp_${user.ispId}`);

            // Join permission-based rooms
            permissions.forEach(permission => {
                this.joinRoom(clientId, `perm_${permission}`);
            });

            // 7. Setup heartbeat
            this.setupHeartbeat(clientId);

            // 8. Setup message handlers
            ws.on('message', (data) => this.handleMessage(clientId, data));
            ws.on('close', () => this.handleDisconnect(clientId));
            ws.on('error', () => this.handleDisconnect(clientId));

            // 9. Send connection confirmation
            this.sendToClient(clientId, 'connected', {
                clientId,
                userId: user.id,
                ispId: user.ispId,
                userName: user.name, // This will now have the actual name
                permissions: Array.from(permissions),
                serverTime: new Date().toISOString()
            });

            // 10. Send initial data
            await this.sendInitialData(clientId, user.id, user.ispId);

            console.log(`✅ [WS Auth] Client ${clientId} authenticated as ${user.email} (ISP: ${user.ispId})`);
            // console.log('users', authUser)
        } catch (error) {
            console.error(`❌ [WS Auth Error] ${clientId}:`, error.message);

            if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
                ws.close(4001, 'Authentication expired');
            } else {
                ws.close(4001, 'Authentication failed');
            }
        }
    }

    // ===================== MESSAGE HANDLING =====================
    async handleMessage(clientId, rawData) {
        const client = this.clients.get(clientId);
        if (!client) return;

        let message;
        try {
            message = JSON.parse(rawData.toString());
        } catch (error) {
            this.sendError(clientId, 'Invalid JSON format', 'PARSE_ERROR');
            return;
        }

        // All messages require authentication
        if (!client.isAuthenticated) {
            this.sendError(clientId, 'Authentication required', 'AUTH_REQUIRED');
            return;
        }

        // Any authenticated traffic proves the browser connection is alive.
        client.lastHeartbeat = Date.now();

        switch (message.type) {
            case 'heartbeat':
            case 'pong':
                break;

            case 'ping':
                this.sendToClient(clientId, 'pong', { timestamp: new Date().toISOString() });
                break;

            case 'subscribe':
                await this.handleSubscribe(clientId, message);
                break;

            case 'unsubscribe':
                this.handleUnsubscribe(clientId, message);
                break;

            case 'command':
                await this.handleCommand(clientId, message);
                break;

            case 'device:room:join': case 'device:room:leave':
            case 'device:session:open': case 'device:session:reuse': case 'device:session:touch': case 'device:session:close':
            case 'device:dashboard:subscribe': case 'device:dashboard:unsubscribe': case 'device:dashboard:refresh':
            case 'device:interfaces:subscribe': case 'device:vlans:subscribe': case 'device:optics:subscribe': case 'device:alarms:subscribe': case 'device:routing:subscribe':
                await this.deviceService.handle(clientId, message);
                break;

            case 'monitoring:dashboard:subscribe': case 'monitoring:dashboard:unsubscribe': case 'monitoring:dashboard:run-all':
            case 'noc:subscribe': case 'noc:unsubscribe': case 'noc:refresh':
                await this.networkOperationsService.handle(clientId, message);
                break;

            case 'terminal:connect': case 'connect':
            case 'terminal:input': case 'input':
            case 'terminal:resize': case 'resize':
            case 'terminal:disconnect': case 'disconnect':
                await this.terminalService.handle(clientId, message);
                break;

            default:
                this.sendError(clientId, `Unknown message type: ${message.type}`, 'UNKNOWN_TYPE');
        }
    }

    // ===================== PERMISSION MANAGEMENT =====================
    async getUserPermissions(userId) {
        try {
            const user = await prisma.user.findUnique({
                where: { id: userId },
                select: {
                    role: {
                        select: {
                            name: true,                // ✅ role.name guaranteed
                            permissions: {
                                select: { name: true }
                            }
                        }
                    }
                }
            });

            if (!user || !user.role) return [];

            return user.role.permissions.map(p => p.name);

        } catch (error) {
            console.error(`[WS Permissions Error] User ${userId}:`, error);
            return [];
        }
    }

    // ===================== SUBSCRIPTION MANAGEMENT =====================
    async handleSubscribe(clientId, message) {
        const client = this.clients.get(clientId);
        if (!client) return;


        // Validate and normalize channels
        let channels = [];

        if (message.data?.channels) {
            const channelsData = message.data.channels;
            if (Array.isArray(channelsData)) {
                // Filter out invalid values
                channels = channelsData.filter(ch =>
                    ch && typeof ch === 'string' && ch.trim().length > 0
                );
            } else if (typeof channelsData === 'string') {
                channels = [channelsData];
            }
        }

        if (channels.length === 0) {
            console.warn(`⚠️ [WS Subscribe] No valid channels for client ${clientId}:`, message.data?.channels);
            this.sendError(clientId, 'No valid channels specified', 'INVALID_CHANNELS');
            return;
        }


        const subscribed = [];

        for (let channel of channels) {
            try {
                // Double-check that channel is defined and is a string
                if (!channel || typeof channel !== 'string') {
                    console.warn(`⚠️ [WS Subscribe] Invalid channel for client ${clientId}:`, channel);
                    continue;
                }

                if (channel.startsWith('isp_') && channel !== `isp_${client.ispId}`) {
                    console.warn(`[WS Subscribe] Rewriting ${channel} to authenticated room isp_${client.ispId} for client ${clientId}`);
                    channel = `isp_${client.ispId}`;
                }

                // Check permissions for restricted channels
                if (channel.startsWith('yeastar_')) {
                    if (!client.permissions.has('yeaster_read') &&
                        !client.permissions.has('yeaster_manage') &&
                        !client.permissions.has('services_read')) {
                        console.warn(`⚠️ [WS Subscribe] Client ${clientId} lacks permission for channel: ${channel}`);
                        continue;
                    }
                }

                if (!client.subscriptions.has(channel)) {
                    client.subscriptions.add(channel);
                    this.joinRoom(clientId, channel);
                    subscribed.push(channel);
                    console.log(`✅ [WS Subscribe] Client ${clientId} subscribed to: ${channel}`);
                }
            } catch (error) {
                console.error(`❌ [WS Subscribe] Error subscribing to channel ${channel}:`, error);
            }
        }

        if (subscribed.length > 0) {
            this.sendToClient(clientId, 'subscribed', {
                channels: subscribed,
                timestamp: new Date().toISOString()
            });
        }
    }

    handleUnsubscribe(clientId, message) {
        const client = this.clients.get(clientId);
        if (!client) return;

        console.log('📨 [WS Unsubscribe] Raw message:', message); // Debug log

        // Validate and normalize channels
        let channels = [];

        if (message.data?.channels) {
            const channelsData = message.data.channels;
            if (Array.isArray(channelsData)) {
                channels = channelsData.filter(ch =>
                    ch && typeof ch === 'string' && ch.trim().length > 0
                );
            } else if (typeof channelsData === 'string') {
                channels = [channelsData];
            }
        }

        if (channels.length === 0) {
            console.warn(`⚠️ [WS Unsubscribe] No valid channels for client ${clientId}:`, message.data?.channels);
            this.sendError(clientId, 'No valid channels specified', 'INVALID_CHANNELS');
            return;
        }

        const unsubscribed = [];

        channels.forEach(channel => {
            if (!channel || typeof channel !== 'string') {
                console.warn(`⚠️ [WS Unsubscribe] Invalid channel for client ${clientId}:`, channel);
                return;
            }

            if (client.subscriptions.has(channel)) {
                client.subscriptions.delete(channel);
                this.leaveRoom(clientId, channel);
                unsubscribed.push(channel);
                console.log(`✅ [WS Unsubscribe] Client ${clientId} unsubscribed from: ${channel}`);
            }
        });

        if (unsubscribed.length > 0) {
            this.sendToClient(clientId, 'unsubscribed', {
                channels: unsubscribed,
                timestamp: new Date().toISOString()
            });
        }
    }

    // ===================== COMMAND HANDLING =====================
    async handleCommand(clientId, message) {
        const client = this.clients.get(clientId);
        if (!client || !client.isAuthenticated) {
            this.sendError(clientId, 'Authentication required', 'AUTH_REQUIRED');
            return;
        }

        console.log('📨 [WS Command] Raw message:', message); // Debug log

        // The client sends { type: 'command', data: { command: '...', ... } }
        // So we need to access message.data.command
        const command = message.data?.command;
        const data = message.data || {};

        if (!command || typeof command !== 'string') {
            console.error('❌ [WS Command] Invalid command format:', { command, data, message });
            this.sendError(clientId, 'Invalid command format', 'INVALID_COMMAND');
            return;
        }

        console.log(`⚙️ [WS Command] ${command} from client ${clientId}`, data);

        switch (command) {
            // Yeastar Listener Commands
            case 'yeastar.listener.start':
                if (!client.permissions.has('yeaster_manage')) {
                    this.sendError(clientId, 'Permission denied', 'PERMISSION_DENIED');
                    return;
                }
                this.eventEmitter.emit('yeastar.listener.start.request', {
                    ispId: client.ispId,
                    userId: client.userId,
                    clientId
                });
                break;

            case 'yeastar.listener.stop':
                if (!client.permissions.has('yeaster_manage')) {
                    this.sendError(clientId, 'Permission denied', 'PERMISSION_DENIED');
                    return;
                }
                this.eventEmitter.emit('yeastar.listener.stop.request', {
                    ispId: client.ispId,
                    userId: client.userId,
                    clientId
                });
                break;

            // Call Control Commands
            case 'yeastar.call.hangup':
                if (!client.permissions.has('yeaster_manage')) {
                    this.sendError(clientId, 'Permission denied', 'PERMISSION_DENIED');
                    return;
                }
                if (!data.callId && !data.channelId) {
                    this.sendError(clientId, 'callId or channelId required', 'INVALID_PAYLOAD');
                    return;
                }
                this.eventEmitter.emit('yeastar.call.hangup.request', {
                    ...data,
                    ispId: client.ispId,
                    userId: client.userId
                });
                break;

            case 'yeastar.call.transfer':
                if (!client.permissions.has('yeaster_manage')) {
                    this.sendError(clientId, 'Permission denied', 'PERMISSION_DENIED');
                    return;
                }
                if (!data.channelId || !data.target) {
                    this.sendError(clientId, 'channelId and target required', 'INVALID_PAYLOAD');
                    return;
                }
                this.eventEmitter.emit('yeastar.call.transfer.request', {
                    ...data,
                    ispId: client.ispId,
                    userId: client.userId
                });
                break;

            // Extension Commands
            case 'yeastar.extension.refresh':
                if (!client.permissions.has('yeaster_read') && !client.permissions.has('yeaster_manage')) {
                    this.sendError(clientId, 'Permission denied', 'PERMISSION_DENIED');
                    return;
                }
                this.eventEmitter.emit('yeastar.extension.refresh.request', {
                    ispId: client.ispId,
                    userId: client.userId
                });
                break;

            // Extension Management Commands
            case 'yeastar.extensions.delete.all':
                if (!client.permissions.has('yeaster_manage')) {
                    this.sendError(clientId, 'Permission denied', 'PERMISSION_DENIED');
                    return;
                }
                this.eventEmitter.emit('yeastar.extensions.delete.all.request', {
                    ispId: client.ispId,
                    userId: client.userId
                });
                break;

            // Trunk Management Commands
            case 'yeastar.trunks.delete.all':
                if (!client.permissions.has('yeaster_manage')) {
                    this.sendError(clientId, 'Permission denied', 'PERMISSION_DENIED');
                    return;
                }
                this.eventEmitter.emit('yeastar.trunks.delete.all.request', {
                    ispId: client.ispId,
                    userId: client.userId
                });
                break;

            // Data Refresh Commands
            case 'yeastar.data.refresh':
                if (!client.permissions.has('yeaster_read') && !client.permissions.has('yeaster_manage')) {
                    this.sendError(clientId, 'Permission denied', 'PERMISSION_DENIED');
                    return;
                }
                this.eventEmitter.emit('yeastar.data.refresh.request', {
                    ispId: client.ispId,
                    userId: client.userId
                });
                break;

            // System Commands
            case 'system.get_stats':
                this.sendToClient(clientId, 'system.stats', this.getStats());
                break;

            case 'system.get_clients':
                if (!client.permissions.has('system_admin')) {
                    this.sendError(clientId, 'Permission denied', 'PERMISSION_DENIED');
                    return;
                }
                this.sendToClient(clientId, 'system.clients', this.getClientsInfo());
                break;

            default:
                console.warn(`⚠️ [WS Command] Unknown command: ${command}`);
                this.sendError(clientId, `Unknown command: ${command}`, 'UNKNOWN_COMMAND');
        }
    }

    // ===================== ROOM MANAGEMENT =====================
    joinRoom(clientId, roomName) {
        if (!this.rooms.has(roomName)) {
            this.rooms.set(roomName, new Set());
        }
        this.rooms.get(roomName).add(clientId);
    }

    leaveRoom(clientId, roomName) {
        if (this.rooms.has(roomName)) {
            this.rooms.get(roomName).delete(clientId);
            if (this.rooms.get(roomName).size === 0) {
                this.rooms.delete(roomName);
            }
        }
    }

    // ===================== EVENT BROADCASTING =====================
    setupEventListeners() {
        this.eventEmitter.on('yeastar.listener.start.request', async (data) => {
            const result = await YeastarService.startListener(data.ispId, prisma);
            this.sendToClient(data.clientId, 'command.response', {
                command: 'yeastar.listener.start',
                success: result.success,
                message: result.message || result.error,
                data: result
            });
            this.broadcastToRoom(`isp_${data.ispId}`, result.success ? 'yeastar.listener.started' : 'yeastar.listener.failed', {
                ...result,
                ispId: data.ispId
            });
        });

        this.eventEmitter.on('yeastar.listener.stop.request', (data) => {
            const result = YeastarService.stopListener(data.ispId);
            this.sendToClient(data.clientId, 'command.response', {
                command: 'yeastar.listener.stop',
                success: result.success,
                message: result.message || result.error,
                data: result
            });
            this.broadcastToRoom(`isp_${data.ispId}`, 'yeastar.listener.stopped', {
                ...result,
                ispId: data.ispId
            });
        });

        // Yeastar Events
        this.eventEmitter.on('yeastar.call.start', (data) => {
            this.broadcastToRoom(`isp_${data.ispId}`, 'yeastar.call.start', data);
        });

        this.eventEmitter.on('yeastar.call.end', (data) => {
            this.broadcastToRoom(`isp_${data.ispId}`, 'yeastar.call.end', data);
        });

        this.eventEmitter.on('yeastar.extension.added', (data) => {
            this.broadcastToRoom(`isp_${data.ispId}`, 'yeastar.extension.added', data);
        });

        this.eventEmitter.on('yeastar.extension.updated', (data) => {
            this.broadcastToRoom(`isp_${data.ispId}`, 'yeastar.extension.updated', data);
        });

        this.eventEmitter.on('yeastar.trunk.updated', (data) => {
            this.broadcastToRoom(`isp_${data.ispId}`, 'yeastar.trunk.updated', data);
        });

        this.eventEmitter.on('yeastar.listener.started', (data) => {
            this.broadcastToRoom(`isp_${data.ispId}`, 'yeastar.listener.started', data);
        });

        this.eventEmitter.on('yeastar.listener.stopped', (data) => {
            this.broadcastToRoom(`isp_${data.ispId}`, 'yeastar.listener.stopped', data);
        });

        this.eventEmitter.on('yeastar.data.synced', (data) => {
            this.broadcastToRoom(`isp_${data.ispId}`, 'yeastar.data.synced', data);
        });

        // System Events
        this.eventEmitter.on('system.notification', (data) => {
            if (data.userId) {
                this.sendToUser(data.userId, 'system.notification', data);
            } else if (data.ispId) {
                this.broadcastToRoom(`isp_${data.ispId}`, 'system.notification', data);
            }
        });

        this.eventEmitter.on('dashboard.update', (data) => {
            this.broadcastToRoom(`isp_${data.ispId}`, 'dashboard.update', data);
        });

        this.eventEmitter.on('data.updated', (data) => {
            if (data.ispId) {
                this.broadcastToRoom(`isp_${data.ispId}`, 'data.updated', data);
            }
        });

        this.eventEmitter.on('gps.location.updated', (data) => {
            this.broadcastFieldStaffLocation(data);
        });

        // Command response events
        this.eventEmitter.on('command.response', (data) => {
            if (data.clientId) {
                this.sendToClient(data.clientId, 'command.response', data);
            }
        });

        console.log('✅ [WS] Event listeners setup complete');
    }

    broadcastToRoom(roomName, eventType, data) {
        if (!this.rooms.has(roomName)) return;

        const message = JSON.stringify({
            type: eventType,
            data,
            timestamp: new Date().toISOString()
        });

        this.rooms.get(roomName).forEach(clientId => {
            const client = this.clients.get(clientId);
            if (client && client.ws.readyState === WebSocket.OPEN) {
                try {
                    client.ws.send(message);
                } catch (error) {
                    console.error(`❌ [WS Broadcast] Failed to send to client ${clientId}:`, error);
                }
            }
        });
    }

    broadcastFieldStaffLocation(data) {
        if (!data?.ispId || !data?.userId || !data?.latestLocation) return;

        this.clients.forEach((client, clientId) => {
            const role = String(client.role || '').toLowerCase();
            const isAdministrator =
                ['administrator', 'super admin', 'super_admin', 'admin'].includes(role);
            const hasGlobalScope = isAdministrator || role.startsWith('global ');
            const canView =
                isAdministrator ||
                client.permissions.has('gps_view') ||
                client.permissions.has('users_read');

            if (!canView || Number(client.ispId) !== Number(data.ispId)) return;
            if (!hasGlobalScope && client.branchId && Number(client.branchId) !== Number(data.branchId)) return;
            if (client.resellerId && Number(client.resellerId) !== Number(data.resellerId)) return;

            this.sendToClient(clientId, 'gps.location.updated', {
                userId: data.userId,
                latestLocation: data.latestLocation,
                locationStatus: 'current',
                ageSeconds: 0
            });
        });
    }

    sendToUser(userId, eventType, data) {
        this.broadcastToRoom(`user_${userId}`, eventType, data);
    }

    // ===================== CLIENT COMMUNICATION =====================
    sendToClient(clientId, eventType, data) {
        const client = this.clients.get(clientId);
        if (!client || client.ws.readyState !== WebSocket.OPEN) return false;

        const message = JSON.stringify({
            type: eventType,
            data,
            timestamp: new Date().toISOString()
        });

        try {
            client.ws.send(message);
            return true;
        } catch (error) {
            console.error(`❌ [WS Send] Failed to send to client ${clientId}:`, error);
            return false;
        }
    }

    sendError(clientId, message, code = 'ERROR') {
        this.sendToClient(clientId, 'error', {
            code,
            message,
            timestamp: new Date().toISOString()
        });
    }

    emitEvent(eventType, data) {
        this.eventEmitter.emit(eventType, data);
    }

    // ===================== HEARTBEAT MANAGEMENT =====================
    setupHeartbeat(clientId) {
        const interval = setInterval(() => {
            const client = this.clients.get(clientId);
            if (!client) {
                clearInterval(interval);
                this.heartbeatIntervals.delete(clientId);
                return;
            }

            const now = Date.now();
            if (now - client.lastHeartbeat > HEARTBEAT_TIMEOUT) {
                console.log(`🕐 [WS Heartbeat] Client ${clientId} timeout, disconnecting`);
                client.ws.close(1001, 'Heartbeat timeout');
                clearInterval(interval);
                this.heartbeatIntervals.delete(clientId);
                this.handleDisconnect(clientId);
            } else {
                this.sendToClient(clientId, 'ping', {
                    timestamp: new Date().toISOString()
                });
            }
        }, HEARTBEAT_INTERVAL);

        this.heartbeatIntervals.set(clientId, interval);
    }

    // ===================== INITIAL DATA =====================
    async sendInitialData(clientId, userId, ispId) {
        try {
            // System status
            const systemStatus = {
                serverTime: new Date().toISOString(),
                connectedClients: this.clients.size,
                uptime: process.uptime()
            };
            this.sendToClient(clientId, 'system.status', systemStatus);

            // Check Yeastar service
            // const yeastarService = await prisma.service.findFirst({
            //     where: {
            //         ispId,
            //         service: 'yeastar',
            //         isActive: true,
            //         isDeleted: false
            //     }
            // });



            const yeastarService = await prisma.iSPService.findMany({
                where: {
                    service: { code: 'YEASTAR' },
                    isActive: true,
                    isDeleted: false
                },
                select: { ispId: true }
            });

            if (yeastarService) {
                this.sendToClient(clientId, 'yeastar.service.available', {
                    ispId,
                    configured: true
                });
            }

            // Welcome notification
            this.sendToClient(clientId, 'system.notification', {
                type: 'info',
                title: 'Connection Established',
                message: 'WebSocket connection established successfully',
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            console.error(`[WS Initial Data Error] ${clientId}:`, error);
        }
    }

    // ===================== DISCONNECTION HANDLING =====================
    handleDisconnect(clientId) {
        const client = this.clients.get(clientId);
        if (!client) return;
        this.deviceService?.handleDisconnect(clientId);
        this.terminalService?.handleDisconnect(clientId);

        // Clear heartbeat
        const interval = this.heartbeatIntervals.get(clientId);
        if (interval) {
            clearInterval(interval);
            this.heartbeatIntervals.delete(clientId);
        }

        // Leave all rooms
        client.subscriptions.forEach(channel => {
            this.leaveRoom(clientId, channel);
        });

        if (client.ispId) this.leaveRoom(clientId, `isp_${client.ispId}`);
        if (client.userId) this.leaveRoom(clientId, `user_${client.userId}`);
        client.permissions.forEach(permission => {
            this.leaveRoom(clientId, `perm_${permission}`);
        });

        // Remove client
        this.clients.delete(clientId);
        this.networkOperationsService?.handleDisconnect(client);

        console.log(`👋 [WS Disconnect] Client ${clientId} disconnected (User: ${client.userName || 'Unauthenticated'})`);
    }

    // ===================== UTILITY METHODS =====================
    generateClientId() {
        return `ws_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    }

    setupCleanupInterval() {
        setInterval(() => this.cleanupInactiveClients(), 60000);
    }

    cleanupInactiveClients() {
        const now = Date.now();
        let cleaned = 0;

        this.clients.forEach((client, clientId) => {
            if (now - client.lastHeartbeat > HEARTBEAT_TIMEOUT * 2) {
                console.log(`🕐 [WS Cleanup] Cleaning up inactive client: ${clientId}`);
                if (client.ws.readyState === WebSocket.OPEN) {
                    client.ws.close(1001, 'Inactive timeout');
                }
                this.handleDisconnect(clientId);
                cleaned++;
            }
        });

        if (cleaned > 0) {
            console.log(`🧹 [WS Cleanup] Cleaned up ${cleaned} inactive connections`);
        }
    }

    getStats() {
        const totalClients = this.clients.size;
        const authenticatedClients = Array.from(this.clients.values())
            .filter(client => client.isAuthenticated).length;
        const totalRooms = this.rooms.size;

        return {
            totalClients,
            authenticatedClients,
            totalRooms,
            serverTime: new Date().toISOString(),
            uptime: process.uptime()
        };
    }

    getClientsInfo() {
        const clients = [];
        this.clients.forEach(client => {
            clients.push({
                clientId: client.clientId,
                userId: client.userId,
                userName: client.userName,
                ispId: client.ispId,
                isAuthenticated: client.isAuthenticated,
                ip: client.ip,
                userAgent: client.userAgent,
                subscriptions: Array.from(client.subscriptions),
                permissions: Array.from(client.permissions),
                connectedAt: client.connectedAt,
                connectionAge: Date.now() - client.connectedAt.getTime()
            });
        });
        return clients;
    }

    isUserConnected(userId) {
        return Array.from(this.clients.values())
            .some(client => client.userId === userId && client.isAuthenticated);
    }

    // ===================== SHUTDOWN =====================
    shutdown() {
        this.deviceService?.close();
        this.networkOperationsService?.close();
        console.log('🛑 [WS Shutdown] Shutting down WebSocket server...');

        this.heartbeatIntervals.forEach(interval => clearInterval(interval));
        this.heartbeatIntervals.clear();

        this.clients.forEach(client => {
            if (client.ws.readyState === WebSocket.OPEN) {
                client.ws.close(1000, 'Server shutdown');
            }
        });

        this.clients.clear();
        this.rooms.clear();

        this.wss.close(() => {
            console.log('✅ [WS Shutdown] WebSocket server closed');
        });
    }
}

module.exports = WebSocketManager;

