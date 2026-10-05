const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/settings.controller');
const isAuthenticated = require('../middlewares/isAuthenticated');
const checkPermission = require('../middlewares/checkPermission');

module.exports = (prisma) => {
    const auth = isAuthenticated(prisma);

    router.get('/calendar-system', auth, settingsController.getCalendarSystem);
    router.get('/', auth, checkPermission('settings_read'), settingsController.getSettings);
    router.get('/radius-pools', auth, checkPermission('settings_read'), settingsController.listRadiusPools);
    router.post('/radius-pools', auth, checkPermission('settings_update'), settingsController.upsertRadiusPool);
    router.delete('/radius-pools/:value', auth, checkPermission('settings_update'), settingsController.deleteRadiusPool);
    router.post('/esewa/base64', auth, checkPermission('settings_update'), settingsController.generateEsewaBase64);
    router.get('/esewa/config', auth, checkPermission('settings_read'), settingsController.getEsewaConfiguration);
    router.put('/esewa/config', auth, checkPermission('settings_update'), settingsController.saveEsewaConfiguration);
    router.get('/externalpayment/config', auth, checkPermission('settings_read'), settingsController.getExternalPaymentConfiguration);
    router.put('/externalpayment/config', auth, checkPermission('settings_update'), settingsController.saveExternalPaymentConfiguration);
    router.get('/whatsapp', auth, checkPermission('settings_read'), settingsController.getWhatsAppSettings);
    router.post('/whatsapp', auth, checkPermission('settings_update'), settingsController.updateWhatsAppSettings);
    router.post('/whatsapp/qr/generate', auth, checkPermission('settings_update'), settingsController.generateWhatsAppQr);
    router.post('/whatsapp/qr/disconnect', auth, checkPermission('settings_update'), settingsController.disconnectWhatsAppQr);
    router.post('/whatsapp/qr/scan-simulate', auth, checkPermission('settings_update'), settingsController.simulateWhatsAppQrScan);
    router.get('/whatsapp/chats', auth, checkPermission('settings_read'), settingsController.listWhatsAppChats);
    router.get('/whatsapp/chats/:phone/messages', auth, checkPermission('settings_read'), settingsController.getWhatsAppChatMessages);
    router.post('/whatsapp/chats/:phone/messages', auth, checkPermission('settings_update'), settingsController.sendWhatsAppChatMessage);
    router.get('/whatsapp/automation', auth, checkPermission('settings_read'), settingsController.listWhatsAppAutomationRules);
    router.post('/whatsapp/automation', auth, checkPermission('settings_update'), settingsController.saveWhatsAppAutomationRule);
    router.delete('/whatsapp/automation/:id', auth, checkPermission('settings_update'), settingsController.deleteWhatsAppAutomationRule);
    router.get('/database-backup', auth, checkPermission('settings_read'), settingsController.getDatabaseBackupSettings);
    router.put('/database-backup', auth, checkPermission('settings_update'), settingsController.updateDatabaseBackupSettings);
    router.post('/database-backup/run', auth, checkPermission('settings_update'), settingsController.runDatabaseBackupNow);
    router.post('/', auth, checkPermission('settings_update'), settingsController.updateSetting);
    router.post('/batch', auth, checkPermission('settings_update'), settingsController.batchUpdateSettings);

    return router;
};
