const express = require('express');
const AsteriskController = require('../controllers/asterisk.controller');
const isAuthenticated = require('../middlewares/isAuthenticated');
const checkPermission = require('../middlewares/checkPermission');

const noCache = (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
};

module.exports = (prisma) => {
  const router = express.Router();

  router.use((req, res, next) => {
    req.prisma = prisma;
    next();
  });

  router.use(isAuthenticated(prisma));

  const controller = new AsteriskController(prisma);

  /* ========== STATUS, CAPABILITIES & SYSTEM INFO ========== */
  router.get('/status', checkPermission('asterisk_read'), noCache, (req, res) =>
    controller.getDashboardStatus(req, res));

  router.get('/capabilities', checkPermission('asterisk_read'), noCache, (req, res) =>
    controller.getCapabilities(req, res));

  router.get('/system/info', checkPermission('asterisk_read'), noCache, (req, res) =>
    controller.getSystemInfo(req, res));

  router.post('/system/sync', checkPermission('asterisk_manage'), (req, res) =>
    controller.syncSystemStatus(req, res));

  router.get('/test', checkPermission('asterisk_read'), noCache, (req, res) =>
    controller.testConnection(req, res));

  /* ========== PROVISIONING CONFIG ========== */
  router.get('/provisioning', checkPermission('asterisk_manage'), noCache, (req, res) =>
    controller.getProvisioningConfig(req, res));

  router.put('/provisioning', checkPermission('asterisk_manage'), (req, res) =>
    controller.updateProvisioningConfig(req, res));

  router.post('/provisioning/test', checkPermission('asterisk_manage'), (req, res) =>
    controller.testProvisioningConfig(req, res));

  /* ========== EXTENSIONS ========== */
  router.get('/extensions', checkPermission('asterisk_read'), noCache, (req, res) =>
    controller.listExtensions(req, res));

  router.get('/extensions/db', checkPermission('asterisk_read'), (req, res) =>
    controller.getExtensionsFromDB(req, res));

  router.get('/extensions/:extension', checkPermission('asterisk_read'), noCache, (req, res) =>
    controller.getExtensionDetails(req, res));

  router.post('/extensions', checkPermission('asterisk_manage'), (req, res) =>
    controller.createExtension(req, res));

  router.put('/extensions/:extension', checkPermission('asterisk_manage'), (req, res) =>
    controller.updateExtension(req, res));

  router.delete('/extensions/:extension', checkPermission('asterisk_manage'), (req, res) =>
    controller.deleteExtension(req, res));

  router.patch('/extensions/:extension/status', checkPermission('asterisk_manage'), (req, res) =>
    controller.toggleExtensionStatus(req, res));

  router.post('/extensions/:extension/regenerate-secret', checkPermission('asterisk_manage'), (req, res) =>
    controller.regenerateSecret(req, res));

  router.get('/extensions/:extension/softphone', checkPermission('asterisk_read'), (req, res) =>
    controller.getSoftphoneConfig(req, res));

  /* ========== AI AGENTS ========== */
  router.get('/ai-agents', checkPermission('asterisk_read'), noCache, (req, res) =>
    controller.listAiAgents(req, res));

  router.get('/ai-agents/:id', checkPermission('asterisk_read'), noCache, (req, res) =>
    controller.getAiAgent(req, res));

  router.post('/ai-agents', checkPermission('asterisk_manage'), (req, res) =>
    controller.createAiAgent(req, res));

  router.put('/ai-agents/:id', checkPermission('asterisk_manage'), (req, res) =>
    controller.updateAiAgent(req, res));

  router.post('/ai-agents/:id/clone', checkPermission('asterisk_manage'), (req, res) =>
    controller.cloneAiAgent(req, res));

  router.patch('/ai-agents/:id/status', checkPermission('asterisk_manage'), (req, res) =>
    controller.toggleAiAgentStatus(req, res));

  router.post('/ai-agents/:id/test', checkPermission('asterisk_manage'), (req, res) =>
    controller.testAiAgentHealth(req, res));

  router.post('/ai-agents/:id/start', checkPermission('asterisk_manage'), (req, res) =>
    controller.startAiAgent(req, res));

  router.post('/ai-agents/:id/stop', checkPermission('asterisk_manage'), (req, res) =>
    controller.stopAiAgent(req, res));

  router.post('/ai-agents/:id/restart', checkPermission('asterisk_manage'), (req, res) =>
    controller.restartAiAgent(req, res));

  router.post('/ai-agents/:id/call', checkPermission('asterisk_manage'), (req, res) =>
    controller.callAiAgent(req, res));

  router.delete('/ai-agents/:id', checkPermission('asterisk_manage'), (req, res) =>
    controller.deleteAiAgent(req, res));

  /* ========== TRUNKS ========== */
  router.get('/trunks', checkPermission('asterisk_read'), noCache, (req, res) =>
    controller.listTrunks(req, res));

  router.get('/trunks/db', checkPermission('asterisk_read'), (req, res) =>
    controller.getTrunksFromDB(req, res));

  router.get('/trunks/:id', checkPermission('asterisk_read'), noCache, (req, res) =>
    controller.getTrunk(req, res));

  router.post('/trunks', checkPermission('asterisk_manage'), (req, res) =>
    controller.createTrunk(req, res));

  router.put('/trunks/:id', checkPermission('asterisk_manage'), (req, res) =>
    controller.updateTrunk(req, res));

  router.delete('/trunks/:id', checkPermission('asterisk_manage'), (req, res) =>
    controller.deleteTrunk(req, res));

  /* ========== ROUTES (INBOUND & OUTBOUND) ========== */
  router.get('/routes/inbound', checkPermission('asterisk_read'), (req, res) =>
    controller.listInboundRoutes(req, res));

  router.post('/routes/inbound', checkPermission('asterisk_manage'), (req, res) =>
    controller.createInboundRoute(req, res));

  router.put('/routes/inbound/:id', checkPermission('asterisk_manage'), (req, res) =>
    controller.updateInboundRoute(req, res));

  router.delete('/routes/inbound/:id', checkPermission('asterisk_manage'), (req, res) =>
    controller.deleteInboundRoute(req, res));

  router.get('/routes/outbound', checkPermission('asterisk_read'), (req, res) =>
    controller.listOutboundRoutes(req, res));

  router.post('/routes/outbound', checkPermission('asterisk_manage'), (req, res) =>
    controller.createOutboundRoute(req, res));

  router.put('/routes/outbound/:id', checkPermission('asterisk_manage'), (req, res) =>
    controller.updateOutboundRoute(req, res));

  router.delete('/routes/outbound/:id', checkPermission('asterisk_manage'), (req, res) =>
    controller.deleteOutboundRoute(req, res));

  router.post('/routes/outbound/simulate', checkPermission('asterisk_read'), (req, res) =>
    controller.simulateOutboundRoute(req, res));

  /* ========== CALL CONTROL & ACTIVE CALLS ========== */
  router.post('/calls/make', checkPermission('asterisk_manage'), (req, res) =>
    controller.makeCall(req, res));

  router.post('/calls/hangup', checkPermission('asterisk_manage'), (req, res) =>
    controller.hangupCall(req, res));

  router.post('/calls/redirect', checkPermission('asterisk_manage'), (req, res) =>
    controller.redirectCall(req, res));

  router.post('/calls/mute', checkPermission('asterisk_manage'), (req, res) =>
    controller.muteCall(req, res));

  router.post('/calls/unmute', checkPermission('asterisk_manage'), (req, res) =>
    controller.unmuteCall(req, res));

  router.post('/calls/record/start', checkPermission('asterisk_manage'), (req, res) =>
    controller.startRecording(req, res));

  router.post('/calls/record/stop', checkPermission('asterisk_manage'), (req, res) =>
    controller.stopRecording(req, res));

  router.get('/calls/active', checkPermission('asterisk_read'), noCache, (req, res) =>
    controller.getActiveCalls(req, res));

  router.get('/calls/active/:channelId', checkPermission('asterisk_read'), noCache, (req, res) =>
    controller.getActiveCallDetails(req, res));

  router.get('/calls/logs', checkPermission('asterisk_read'), (req, res) =>
    controller.getCallLogs(req, res));

  /* ========== RECORDINGS ========== */
  router.get('/recordings', checkPermission('asterisk_read'), (req, res) =>
    controller.listRecordings(req, res));

  router.get('/recordings/:id/download', checkPermission('asterisk_read'), (req, res) =>
    controller.downloadRecording(req, res));

  router.delete('/recordings/:id', checkPermission('asterisk_manage'), (req, res) =>
    controller.deleteRecording(req, res));

  /* ========== QUEUES, RING GROUPS & IVR ========== */
  router.get('/queues', checkPermission('asterisk_read'), noCache, (req, res) =>
    controller.listQueues(req, res));

  router.post('/queues', checkPermission('asterisk_manage'), (req, res) =>
    controller.createQueue(req, res));

  router.put('/queues/:id', checkPermission('asterisk_manage'), (req, res) =>
    controller.updateQueue(req, res));

  router.delete('/queues/:id', checkPermission('asterisk_manage'), (req, res) =>
    controller.deleteQueue(req, res));

  router.get('/ring-groups', checkPermission('asterisk_read'), noCache, (req, res) =>
    controller.listRingGroups(req, res));

  router.post('/ring-groups', checkPermission('asterisk_manage'), (req, res) =>
    controller.createRingGroup(req, res));

  router.put('/ring-groups/:id', checkPermission('asterisk_manage'), (req, res) =>
    controller.updateRingGroup(req, res));

  router.delete('/ring-groups/:id', checkPermission('asterisk_manage'), (req, res) =>
    controller.deleteRingGroup(req, res));

  router.get('/ivr', checkPermission('asterisk_read'), noCache, (req, res) =>
    controller.listIvrs(req, res));

  router.post('/ivr', checkPermission('asterisk_manage'), (req, res) =>
    controller.createIvr(req, res));

  router.put('/ivr/:id', checkPermission('asterisk_manage'), (req, res) =>
    controller.updateIvr(req, res));

  router.delete('/ivr/:id', checkPermission('asterisk_manage'), (req, res) =>
    controller.deleteIvr(req, res));

  /* ========== DIALPLAN & AMI CONTROL ========== */
  router.get('/dialplan', checkPermission('asterisk_read'), noCache, (req, res) =>
    controller.getDialplan(req, res));

  router.post('/dialplan/extension', checkPermission('asterisk_manage'), (req, res) =>
    controller.addDialplanExtension(req, res));

  router.delete('/dialplan/extension', checkPermission('asterisk_manage'), (req, res) =>
    controller.removeDialplanExtension(req, res));

  router.post('/dialplan/reload', checkPermission('asterisk_manage'), (req, res) =>
    controller.reloadDialplan(req, res));

  router.post('/pjsip/reload', checkPermission('asterisk_manage'), (req, res) =>
    controller.reloadPjsip(req, res));

  router.post('/ami/command', checkPermission('asterisk_manage'), (req, res) =>
    controller.executeAmiCommand(req, res));

  return router;
};
