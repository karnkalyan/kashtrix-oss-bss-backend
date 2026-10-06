// src/routes/mcp.routes.js
const express = require('express');
const { randomUUID } = require('crypto');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js');
const { createMcpServer, READ_ONLY_TOOLS, handleToolCall } = require('../../mcp-server/index.js');

module.exports = (prisma) => {
  const router = express.Router();
  const streamableSessions = new Map();
  const sseSessions = new Map();

  // Attach prisma client & handle CORS + Debug logging
  router.use((req, res, next) => {
    req.prisma = prisma;

    const origin = req.get('origin');
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID, X-Requested-With'
    );
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, MCP-Protocol-Version');

    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }

    // Comprehensive debug logging
    const sessionId = req.get('Mcp-Session-Id') || req.query.sessionId || 'none';
    console.log(`[MCP DEBUG] ${new Date().toISOString()} | ${req.method} ${req.originalUrl} | Origin: ${origin || 'none'} | Session: ${sessionId} | UA: ${req.get('user-agent') || 'none'}`);
    if (req.method === 'POST' && req.body) {
      console.log(`[MCP DEBUG BODY] ${JSON.stringify(req.body).slice(0, 300)}`);
    }

    next();
  });

  // Helper to ensure rawHeaders has text/event-stream for StreamableHTTPServerTransport
  const normalizeAcceptHeaderForStreamable = (req) => {
    if (!req.rawHeaders) return;
    const acceptIdx = req.rawHeaders.findIndex(h => typeof h === 'string' && h.toLowerCase() === 'accept');
    if (acceptIdx !== -1) {
      if (!req.rawHeaders[acceptIdx + 1].includes('text/event-stream')) {
        req.rawHeaders[acceptIdx + 1] = req.rawHeaders[acceptIdx + 1] + ', text/event-stream, application/json, */*';
      }
    } else {
      req.rawHeaders.push('Accept', 'application/json, text/event-stream, */*');
    }
    req.headers.accept = 'application/json, text/event-stream, */*';
    req.headers['accept'] = 'application/json, text/event-stream, */*';
  };

  // POST handler: Streamable HTTP / JSON-RPC / Legacy SSE Messages
  const handlePost = async (req, res, next) => {
    try {
      const sessionId = req.get('Mcp-Session-Id') || req.query.sessionId;

      let session = sessionId ? streamableSessions.get(sessionId) : undefined;

      if (!session) {
        // Fallback for legacy SSE session post message
        if (sessionId && sseSessions.has(sessionId)) {
          const sse = sseSessions.get(sessionId);
          return await sse.transport.handlePostMessage(req, res, req.body);
        }

        // Allow initialize request or error
        if (sessionId || !isInitializeRequest(req.body)) {
          console.warn(`[MCP WARN] Non-initialize request without session ID: ${JSON.stringify(req.body)}`);
          return res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Invalid session or non-initialize request' },
            id: req.body?.id || null
          });
        }

        normalizeAcceptHeaderForStreamable(req);

        const server = createMcpServer();
        let transport;

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            console.log(`[MCP INFO] Streamable HTTP Session initialized: ${newSessionId}`);
            streamableSessions.set(newSessionId, { transport, server });
          }
        });

        transport.onclose = async () => {
          if (transport.sessionId) {
            console.log(`[MCP INFO] Streamable HTTP Session closed: ${transport.sessionId}`);
            streamableSessions.delete(transport.sessionId);
          }
          try { await server.close(); } catch (e) {}
        };

        await server.connect(transport);
        session = { transport, server };
      } else {
        normalizeAcceptHeaderForStreamable(req);
      }

      await session.transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[MCP ERROR] POST failure:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal MCP server error' },
          id: req.body?.id || null
        });
      } else {
        next(error);
      }
    }
  };

  // GET handler: Handles Streamable HTTP SSE, legacy SSE, or probe responses
  const handleGet = async (req, res, next) => {
    try {
      const sessionId = req.get('Mcp-Session-Id') || req.query.sessionId;

      if (sessionId && streamableSessions.has(sessionId)) {
        normalizeAcceptHeaderForStreamable(req);
        const session = streamableSessions.get(sessionId);
        return await session.transport.handleRequest(req, res);
      }

      const rawAccept = req.get('accept') || '';
      // Only enter legacy SSE if explicitly requested via /sse or Accept: text/event-stream without wildcard probe
      const isExplicitSse = req.path === '/sse' || (rawAccept.includes('text/event-stream') && !rawAccept.includes('*/*'));

      if (isExplicitSse) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');

        const baseUrl = req.baseUrl || '/mcp';
        const transport = new SSEServerTransport(`${baseUrl}/messages`, res);
        const server = createMcpServer();
        const sseSessionId = transport.sessionId;
        sseSessions.set(sseSessionId, { transport, server });
        console.log(`[MCP INFO] Legacy SSE Session created: ${sseSessionId}`);

        res.on('close', () => {
          console.log(`[MCP INFO] Legacy SSE Session closed: ${sseSessionId}`);
          sseSessions.delete(sseSessionId);
        });

        return await server.connect(transport);
      }

      // Fast JSON Probe response for GET without active session or explicit SSE header
      res.json({
        status: 'ok',
        mcp: true,
        name: 'kisan-isp-mcp-server',
        version: '1.0.0',
        protocolVersion: '2024-11-05',
        description: 'Strictly Read-Only MCP Server for Kisan ISP CMS',
        toolsCount: READ_ONLY_TOOLS.length,
        supportedTransports: ['streamable-http', 'sse']
      });
    } catch (error) {
      console.error('[MCP ERROR] GET failure:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal MCP server error' });
      }
    }
  };

  // DELETE handler: Session termination
  const handleDelete = async (req, res) => {
    try {
      const sessionId = req.get('Mcp-Session-Id') || req.query.sessionId;
      const session = sessionId ? streamableSessions.get(sessionId) : undefined;

      if (!session) {
        return res.status(404).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'MCP session not found' },
          id: null
        });
      }

      await session.transport.handleRequest(req, res);
    } catch (error) {
      console.error('[MCP ERROR] DELETE failure:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal MCP server error' });
      }
    }
  };

  // Bind endpoints
  router.post('/', handlePost);
  router.get('/', handleGet);
  router.delete('/', handleDelete);

  router.get('/sse', handleGet);
  router.post('/messages', handlePost);
  router.get('/messages', handleGet);
  router.post('/message', handlePost);
  router.get('/message', handleGet);

  // MCP Settings API
  router.get('/config', async (req, res, next) => {
    try {
      const settings = await prisma.iSPSettings.findMany({
        where: { key: { startsWith: 'mcp_' } }
      });
      const map = {};
      settings.forEach(s => { map[s.key] = s.value; });

      let disabledTools = [];
      try {
        if (map['mcp_disabled_tools']) {
          disabledTools = JSON.parse(map['mcp_disabled_tools']);
        }
      } catch (e) {}

      res.json({
        enabled: map['mcp_server_enabled'] !== 'false',
        readOnly: map['mcp_readonly_mode'] !== 'false',
        authToken: map['mcp_auth_token'] || '',
        transport: map['mcp_transport'] || 'all',
        disabledTools: Array.isArray(disabledTools) ? disabledTools : [],
        allTools: READ_ONLY_TOOLS.map(t => ({
          name: t.name,
          description: t.description,
          enabled: !disabledTools.includes(t.name)
        }))
      });
    } catch (err) {
      next(err);
    }
  });

  router.put('/config', async (req, res, next) => {
    try {
      const { enabled, readOnly, authToken, disabledTools, transport } = req.body || {};
      const updates = [
        { key: 'mcp_server_enabled', value: String(Boolean(enabled)) },
        { key: 'mcp_readonly_mode', value: String(readOnly !== false) },
        { key: 'mcp_auth_token', value: String(authToken || '').trim() },
        { key: 'mcp_transport', value: String(transport || 'all') },
        { key: 'mcp_disabled_tools', value: JSON.stringify(Array.isArray(disabledTools) ? disabledTools : []) }
      ];

      for (const item of updates) {
        await prisma.iSPSettings.upsert({
          where: { key: item.key },
          update: { value: item.value, updatedAt: new Date() },
          create: { key: item.key, value: item.value, ispId: 1, updatedAt: new Date() }
        });
      }

      res.json({ success: true, message: 'MCP configuration updated successfully' });
    } catch (err) {
      next(err);
    }
  });

  // Diagnostic endpoints
  router.get('/tools', async (req, res) => {
    try {
      const setting = await prisma.iSPSettings.findFirst({ where: { key: 'mcp_disabled_tools' } });
      let disabledTools = [];
      try {
        if (setting?.value) disabledTools = JSON.parse(setting.value);
      } catch (e) {}

      const activeTools = READ_ONLY_TOOLS.filter(t => !disabledTools.includes(t.name));

      res.json({
        name: 'kisan-isp-mcp-server',
        version: '1.0.0',
        description: 'Strictly Read-Only MCP Server covering ISP CMS domain tools',
        totalToolsCount: READ_ONLY_TOOLS.length,
        activeToolsCount: activeTools.length,
        tools: activeTools
      });
    } catch (e) {
      res.json({
        name: 'kisan-isp-mcp-server',
        version: '1.0.0',
        toolsCount: READ_ONLY_TOOLS.length,
        tools: READ_ONLY_TOOLS
      });
    }
  });

  router.post('/call-tool', async (req, res, next) => {
    try {
      const { name, arguments: args } = req.body || {};
      if (!name) return res.status(400).json({ error: 'Tool name is required' });

      // Check if MCP server or tool is disabled
      const serverSetting = await prisma.iSPSettings.findFirst({ where: { key: 'mcp_server_enabled' } });
      if (serverSetting && serverSetting.value === 'false') {
        return res.status(403).json({ error: 'MCP server is currently disabled in System Settings.' });
      }

      const disabledSetting = await prisma.iSPSettings.findFirst({ where: { key: 'mcp_disabled_tools' } });
      if (disabledSetting && disabledSetting.value) {
        try {
          const disabled = JSON.parse(disabledSetting.value);
          if (Array.isArray(disabled) && disabled.includes(name)) {
            return res.status(403).json({ error: `Tool '${name}' has been disabled by the system administrator.` });
          }
        } catch (e) {}
      }

      const result = await handleToolCall(name, args || {});
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
};