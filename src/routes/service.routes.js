const express = require('express');
const { ServiceController } = require('../controllers/services.controller');
const isAuthenticated = require('../middlewares/isAuthenticated');
const checkPermission = require('../middlewares/checkPermission');
const checkAnyPermission = require('../middlewares/checkAnyPermission');

module.exports = (prisma) => {
    const router = express.Router();
    const serviceController = new ServiceController(prisma);

    // Apply isAuthenticated middleware
    router.use(isAuthenticated(prisma));

    // ==================== PUBLIC SERVICE CATALOG ====================
    router.get('/catalog', serviceController.getAllServices.bind(serviceController));
    router.get('/catalog/:code', serviceController.getServiceByCode.bind(serviceController));

    // ==================== ISP-SPECIFIC SERVICE MANAGEMENT ====================
    router.get('/isp', checkPermission('services_read'), serviceController.getISPActiveServices.bind(serviceController));
    router.get('/isp/status', checkPermission('services_read'), serviceController.getAllServiceStatuses.bind(serviceController));
    router.get('/isp/status/:serviceCode', checkPermission('services_read'), serviceController.getServiceStatus.bind(serviceController));
    router.get('/logs', checkPermission('services_read'), serviceController.getServiceLogs.bind(serviceController));

    router.post('/isp/configure', checkPermission('services_manage'), serviceController.configureServiceForISP.bind(serviceController));
    router.post('/isp/:serviceCode/credentials', checkPermission('services_manage'), serviceController.setServiceCredentials.bind(serviceController));
    router.patch('/isp/:serviceCode/activation', checkPermission('services_manage'), serviceController.toggleServiceActivation.bind(serviceController));
    router.get('/isp/:serviceCode/test', checkPermission('services_read'), serviceController.testServiceConnection.bind(serviceController));

    // ==================== PROVISIONING & BULK OPERATIONS ====================
    router.post('/provision/default', checkPermission('services_manage'), serviceController.provisionDefaultServices.bind(serviceController));
    router.post('/enable-all', checkPermission('services_manage'), serviceController.enableAllServices.bind(serviceController));
    router.post('/disable-all', checkPermission('services_manage'), serviceController.disableAllServices.bind(serviceController));
    router.post('/test-all', checkPermission('services_test'), serviceController.testAllServices.bind(serviceController));
    router.post('/bulk-operations', checkPermission('services_manage'), serviceController.bulkOperations.bind(serviceController));
    router.get('/analytics', checkPermission('services_read'), serviceController.getServiceAnalytics.bind(serviceController));

    // ==================== SERVICE-SPECIFIC OPERATIONS ====================

    // NetTV Operations
    router.get('/nettv/reseller/info', checkPermission('services_read'), serviceController.getNetTVResellerInfo.bind(serviceController));
    router.get('/nettv/countries', checkPermission('services_read'), serviceController.countriesProvince.bind(serviceController));
    router.get('/nettv/subscribers', checkPermission('services_read'), serviceController.getNetTVSubscribers.bind(serviceController));
    router.get('/nettv/subscribers/orders', checkPermission('services_read'), serviceController.getNetTVOrders.bind(serviceController));
    router.get('/nettv/subscribers/orders/:id', checkPermission('services_read'), serviceController.getNetTVOrder.bind(serviceController));
    router.post('/nettv/subscribers/pwd/reset', checkPermission('services_manage'), serviceController.requestNetTVPasswordReset.bind(serviceController));
    router.patch('/nettv/subscribers/pwd/reset', checkPermission('services_manage'), serviceController.resetNetTVPassword.bind(serviceController));
    router.get('/nettv/packages', checkPermission('services_read'), serviceController.getNetTVPackages.bind(serviceController));
    router.get('/nettv/config/:serial/packages', checkPermission('services_read'), serviceController.getNetTVPackageConfigs.bind(serviceController));
    router.get('/nettv/config/:serial/packages/:packageId', checkPermission('services_read'), serviceController.getNetTVPackageConfig.bind(serviceController));
    router.get('/nettv/models', checkPermission('services_read'), serviceController.getNetTVModels.bind(serviceController));
    router.get('/nettv/vendors', checkPermission('services_read'), serviceController.getNetTVVendors.bind(serviceController));
    router.get('/nettv/mac/replace-reasons/config', checkPermission('services_read'), serviceController.getNetTVMacReplaceReasons.bind(serviceController));
    router.get('/nettv/invoices/:companyPaymentId/print', checkPermission('services_read'), serviceController.getNetTVInvoicePrint.bind(serviceController));
    router.get('/nettv/credit-notes/:companyPaymentId/print', checkPermission('services_read'), serviceController.getNetTVCreditNotePrint.bind(serviceController));
    router.get('/nettv/stbs', checkPermission('services_read'), serviceController.getNetTVSTBs.bind(serviceController));
    router.post('/nettv/stbs', checkPermission('services_manage'), serviceController.createNetTVSTB.bind(serviceController));
    router.get('/nettv/subscribers/:username', checkPermission('services_read'), serviceController.getNetTVSubscriber.bind(serviceController));
    router.patch('/nettv/subscribers/:username', checkPermission('services_manage'), serviceController.updateNetTVSubscriber.bind(serviceController));
    router.post('/nettv/subscribers/:username/link-customer', checkPermission('services_manage'), serviceController.linkNetTVCustomer.bind(serviceController));
    router.delete('/nettv/subscribers/:username', checkPermission('services_manage'), serviceController.deleteNetTVSubscriber.bind(serviceController));
    router.patch('/nettv/subscribers/:username/pwd', checkPermission('services_manage'), serviceController.forceNetTVPassword.bind(serviceController));
    router.get('/nettv/subscribers/:username/stbs/:serial', checkPermission('services_read'), serviceController.getNetTVSubscriberSTB.bind(serviceController));
    router.post('/nettv/subscribers/:username/stbs', checkPermission('services_manage'), serviceController.addNetTVSubscriberSTB.bind(serviceController));
    router.delete('/nettv/subscribers/:username/stbs/:serial', checkPermission('services_manage'), serviceController.removeNetTVSubscriberSTB.bind(serviceController));
    router.post('/nettv/subscribers/:username/replace/stb/:serial', checkPermission('services_manage'), serviceController.replaceNetTVSubscriberSTB.bind(serviceController));
    router.post('/nettv/subscribers', checkPermission('services_manage'), serviceController.createNetTVSubscriber.bind(serviceController));
    router.get('/nettv/stbs/:serial', checkPermission('services_read'), serviceController.getNetTVSTB.bind(serviceController));
    router.patch('/nettv/stbs/:serial', checkPermission('services_manage'), serviceController.updateNetTVSTB.bind(serviceController));
    router.post('/nettv/stbs/:serial/packages', checkPermission('services_manage'), serviceController.subscribeNetTVPackages.bind(serviceController));
    router.patch('/nettv/stbs/:serial/packages', checkPermission('services_manage'), serviceController.cancelNetTVPackage.bind(serviceController));

    // Mikrotik Operations
    router.get('/mikrotik/resources', checkPermission('services_read'), serviceController.getMikrotikResources.bind(serviceController));
    router.get('/mikrotik/interfaces', checkPermission('services_read'), serviceController.getMikrotikInterfaces.bind(serviceController));
    router.get('/mikrotik/dhcp-leases', checkPermission('services_read'), serviceController.getMikrotikDHCPLeases.bind(serviceController));

    // Yeastar Operations
    router.get('/yeastar/extensions', checkPermission('services_read'), serviceController.getYeastarExtensions.bind(serviceController));
    router.get('/yeastar/active-calls', checkPermission('services_read'), serviceController.getYeastarActiveCalls.bind(serviceController));
    router.get('/yeastar/system-info', checkPermission('services_read'), serviceController.getYeastarSystemInfo.bind(serviceController));

    // Tshul Operations
    router.get('/tshul/customers', checkPermission('services_read'), serviceController.getTshulCustomers.bind(serviceController));
    router.post('/tshul/customers', checkPermission('services_manage'), serviceController.createTshulCustomer.bind(serviceController));
    router.get('/tshul/customers/:refrenceId', checkPermission('services_read'), serviceController.getTshulCustomersbyId.bind(serviceController));
    router.put('/tshul/customers/:refrenceId', checkPermission('services_manage'), serviceController.updateTshulCustomer.bind(serviceController));
    router.delete('/tshul/customers/:refrenceId', checkPermission('services_manage'), serviceController.deleteTshulCustomer.bind(serviceController));

    // Nepurix Operations
    router.get('/nepurix/customers', checkPermission('services_read'), serviceController.getNepurixCustomers.bind(serviceController));
    router.post('/nepurix/customers', checkPermission('services_manage'), serviceController.createNepurixCustomer.bind(serviceController));
    router.get('/nepurix/customers/:refrenceId', checkPermission('services_read'), serviceController.getNepurixCustomerById.bind(serviceController));
    router.put('/nepurix/customers/:refrenceId', checkPermission('services_manage'), serviceController.updateNepurixCustomer.bind(serviceController));
    router.delete('/nepurix/customers/:refrenceId', checkPermission('services_manage'), serviceController.deleteNepurixCustomer.bind(serviceController));

    // Unified accounting dashboards (TSHUL / NEPURIX)
    router.get('/accounting/:provider/dashboard', checkPermission('services_read'), serviceController.getAccountingDashboard.bind(serviceController));
    router.get('/accounting/:provider/:resource', checkPermission('services_read'), serviceController.listAccountingResources.bind(serviceController));
    router.get('/accounting/:provider/:resource/:id', checkPermission('services_read'), serviceController.getAccountingResource.bind(serviceController));
    router.post('/accounting/:provider/:resource', checkPermission('services_manage'), serviceController.createAccountingResource.bind(serviceController));
    router.put('/accounting/:provider/:resource/:id', checkPermission('services_manage'), serviceController.updateAccountingResource.bind(serviceController));
    router.delete('/accounting/:provider/:resource/:id', checkPermission('services_manage'), serviceController.deleteAccountingResource.bind(serviceController));

    // Radius Operations
    router.get('/radius/users', checkPermission('services_read'), serviceController.getRadiusUsers.bind(serviceController));
    router.get('/radius/act/:username', checkPermission('services_read'), serviceController.getRadiusAccountbyUser.bind(serviceController));
    router.get('/radius/users/:username', checkPermission('services_read'), serviceController.getRadiusUser.bind(serviceController));
    router.get('/radius/tables/:table', checkPermission('services_read'), serviceController.getRadiusTable.bind(serviceController));
    router.post('/radius/tables/:table', checkPermission('services_manage'), serviceController.createRadiusTableRow.bind(serviceController));
    router.put('/radius/tables/:table/:id', checkPermission('services_manage'), serviceController.updateRadiusTableRow.bind(serviceController));
    router.delete('/radius/tables/:table/:id', checkPermission('services_manage'), serviceController.deleteRadiusTableRow.bind(serviceController));
    router.post('/radius/users', checkPermission('services_manage'), serviceController.createRadiusUser.bind(serviceController));

    router.delete('/radius/users/:username', checkPermission('services_manage'), serviceController.deleteRadiusUser.bind(serviceController));
    router.get('/radius/stats', checkPermission('services_read'), serviceController.getRadiusStats.bind(serviceController));
    router.post('/radius/users/:username/coa', checkPermission('services_manage'), serviceController.sendRadiusCoA.bind(serviceController));
    router.post('/radius/test-auth', checkPermission('services_test'), serviceController.testRadiusAuth.bind(serviceController));
    router.post('/radius/auto-sync-passwords', checkPermission('services_manage'), serviceController.syncAutoRadiusPasswords.bind(serviceController));
    router.get('/radius/auto-sync-status', checkPermission('services_read'), serviceController.getRadiusAutoPasswordStatus.bind(serviceController));

    // eSewa Operations
    router.post('/esewa/payment', checkPermission('services_manage'), serviceController.processEsewaPayment.bind(serviceController));
    router.get('/esewa/payment/verify/:transactionId', checkPermission('services_read'), serviceController.verifyEsewaPayment.bind(serviceController));

    // Khalti Operations
    router.post('/khalti/payment', checkPermission('services_manage'), serviceController.processKhaltiPayment.bind(serviceController));
    router.get('/khalti/payment/verify/:token', checkPermission('services_read'), serviceController.verifyKhaltiPayment.bind(serviceController));



    // ==================== GENIEACS OPERATIONS ====================
    router.get('/genieacs/devices/uptime', checkPermission('services_read'), serviceController.refreshUptime.bind(serviceController));
    router.get('/genieacs/devices', checkPermission('services_read'), serviceController.getGenieACSDevices.bind(serviceController));
    router.get('/genieacs/devices/:serialNumber', checkPermission('services_read'), serviceController.getGenieACSDeviceBySerial.bind(serviceController));

    router.get('/genieacs/devices/:serialNumber/deviceinfo', checkPermission('services_read'), serviceController.getGenieACSDeviceInfo.bind(serviceController));
    router.get('/genieacs/devices/:serialNumber/parameters', checkAnyPermission(['tr069_parameters_view', 'services_read']), serviceController.getGenieACSDeviceParameters.bind(serviceController));

    router.get('/genieacs/devices/:serialNumber/waninfo', checkPermission('services_read'), serviceController.getGenieACSDeviceWanInfo.bind(serviceController));


    router.get('/genieacs/devices/:serialNumber/wlaninfo', checkPermission('services_read'), serviceController.getGenieACSDeviceWlanInfo.bind(serviceController));


    router.get('/genieacs/devices/:serialNumber/connected-devices-info', checkPermission('services_read'), serviceController.getGenieACSDeviceConnectedDevicesInfo.bind(serviceController));



    router.get('/genieacs/devices/:serialNumber/laninfo', checkPermission('services_read'), serviceController.getGenieACSDeviceLANInfo.bind(serviceController));
    router.put('/genieacs/devices/:serialNumber/laninfo', checkPermission('services_manage'), serviceController.updateGenieACSDeviceLANInfo.bind(serviceController));

    router.get('/genieacs/devices/:serialNumber/status', checkPermission('services_read'), serviceController.getGenieACSDeviceStatus.bind(serviceController));
    router.get('/genieacs/devices/:serialNumber/connected-clients', checkPermission('services_read'), serviceController.getGenieACSConnectedClients.bind(serviceController));
    router.get('/genieacs/devices/:serialNumber/tasks', checkPermission('services_read'), serviceController.getGenieACSDeviceTasks.bind(serviceController));


    router.post('/genieacs/devices/:serialNumber/create-wan-connection', checkPermission('services_read'), serviceController.createwanipconnenctiondump.bind(serviceController));


    router.post('/genieacs/devices/:serialNumber/delete-wan-connection', checkPermission('services_delete'), serviceController.deleteWanConnection.bind(serviceController));
    router.post('/genieacs/devices/:serialNumber/update-wan-connection', checkPermission('services_manage'), serviceController.updateWanConnection.bind(serviceController));

    router.post('/genieacs/devices/:serialNumber/ssid-operations', checkPermission('services_manage'), serviceController.enableDisableSSID.bind(serviceController));



    router.post('/genieacs/devices/:serialNumber/refresh', checkPermission('services_manage'), serviceController.refreshGenieACSObject.bind(serviceController));
    router.post('/genieacs/devices/:serialNumber/diagnostics', checkAnyPermission(['tr069_diagnostics_run', 'services_manage']), serviceController.runGenieACSDiagnostic.bind(serviceController));
    router.get('/genieacs/devices/:serialNumber/diagnostics/result', checkAnyPermission(['tr069_diagnostics_run', 'tr069_parameters_view', 'services_read']), serviceController.getGenieACSDiagnosticResult.bind(serviceController));
    router.post('/genieacs/devices/:serialNumber/configure-wifi', checkPermission('services_manage'), serviceController.configureGenieACSWiFi.bind(serviceController));
    router.post('/genieacs/devices/:serialNumber/enable-acl', checkPermission('services_manage'), serviceController.enableGenieACSACL.bind(serviceController));
    router.post('/genieacs/devices/:serialNumber/reboot', checkPermission('services_manage'), serviceController.rebootGenieACSDevice.bind(serviceController));
    router.post('/genieacs/devices/:serialNumber/factory-reset', checkPermission('services_manage'), serviceController.factoryResetGenieACSDevice.bind(serviceController));
    router.post('/genieacs/devices/:serialNumber/upgrade-firmware', checkPermission('services_manage'), serviceController.triggerGenieACSFirmwareUpgrade.bind(serviceController));
    router.post('/genieacs/devices/:serialNumber/provision', checkPermission('services_manage'), serviceController.provisionGenieACSPPPoEWiFi.bind(serviceController));
    router.post('/genieacs/devices/:serialNumber/update-wifi-all-pwd', checkPermission('services_manage'), serviceController.updateAllSSIDPassword.bind(serviceController));
    router.post('/genieacs/devices/:serialNumber/update-wifi', checkPermission('services_manage'), serviceController.updateSpecificSSID.bind(serviceController));

    // ==================== GENIEACS ADMIN OPERATIONS ====================
    router.get('/genieacs/provisions', checkPermission('services_read'), serviceController.getGenieACSProvisions.bind(serviceController));
    router.post('/genieacs/provisions', checkPermission('services_manage'), serviceController.createOrUpdateGenieACSProvision.bind(serviceController));
    router.delete('/genieacs/provisions/:name', checkPermission('services_manage'), serviceController.deleteGenieACSProvision.bind(serviceController));

    router.get('/genieacs/virtual-parameters', checkPermission('services_read'), serviceController.getGenieACSVirtualParameters.bind(serviceController));
    router.post('/genieacs/virtual-parameters', checkPermission('services_manage'), serviceController.createOrUpdateGenieACSVirtualParameter.bind(serviceController));
    router.delete('/genieacs/virtual-parameters/:name', checkPermission('services_manage'), serviceController.deleteGenieACSVirtualParameter.bind(serviceController));

    router.get('/genieacs/presets', checkPermission('services_read'), serviceController.getGenieACSPresets.bind(serviceController));
    router.post('/genieacs/presets', checkPermission('services_manage'), serviceController.createOrUpdateGenieACSPreset.bind(serviceController));
    router.delete('/genieacs/presets/:name', checkPermission('services_manage'), serviceController.deleteGenieACSPreset.bind(serviceController));

    router.get('/genieacs/files', checkPermission('services_read'), serviceController.getGenieACSFiles.bind(serviceController));
    router.post('/genieacs/files', checkPermission('services_manage'), serviceController.uploadGenieACSFile.bind(serviceController));
    router.delete('/genieacs/files/:name', checkPermission('services_manage'), serviceController.deleteGenieACSFile.bind(serviceController));

    router.get('/genieacs/config', checkPermission('services_read'), serviceController.getGenieACSConfig.bind(serviceController));
    router.post('/genieacs/config', checkPermission('services_manage'), serviceController.updateGenieACSConfig.bind(serviceController));

    router.get('/genieacs/permissions', checkPermission('services_read'), serviceController.getGenieACSPermissions.bind(serviceController));
    router.post('/genieacs/permissions', checkPermission('services_manage'), serviceController.createGenieACSPermission.bind(serviceController));
    router.delete('/genieacs/permissions/:id', checkPermission('services_manage'), serviceController.deleteGenieACSPermission.bind(serviceController));

    router.get('/genieacs/users', checkPermission('services_read'), serviceController.getGenieACSUsers.bind(serviceController));
    router.post('/genieacs/users', checkPermission('services_manage'), serviceController.createGenieACSUser.bind(serviceController));
    router.delete('/genieacs/users/:id', checkPermission('services_manage'), serviceController.deleteGenieACSUser.bind(serviceController));

    // ==================== SMS OPERATIONS ====================
    router.get('/aakashsms/credit', checkPermission('services_read'), serviceController.getSmsCredit.bind(serviceController));
    router.post('/aakashsms/send-bulk', checkPermission('services_manage'), serviceController.sendBulkSms.bind(serviceController));

    router.get('/sms/credit', checkPermission('services_read'), serviceController.getSmsCredit.bind(serviceController));
    router.post('/sms/send-bulk', checkPermission('services_manage'), serviceController.sendBulkSms.bind(serviceController));
    router.post('/sms/campaigns', checkPermission('services_manage'), serviceController.enqueueSmsCampaign.bind(serviceController));
    router.get('/sms/campaigns', checkPermission('services_read'), serviceController.getSmsCampaigns.bind(serviceController));
    router.get('/sms/campaigns/:id/logs', checkPermission('services_read'), serviceController.getSmsCampaignLogs.bind(serviceController));
    router.get('/sms/campaigns/:id/export', checkPermission('services_read'), serviceController.exportSmsCampaignLogs.bind(serviceController));
    // ==================== HEALTH CHECK ====================
    router.get('/health', (req, res) => {
        res.json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            version: '1.0.0',
            services: {
                TSHUL: 'Available',
                RADIUS: 'Available',
                NETTV: 'Available',
                YEASTAR: 'Available',
                MIKROTIK: 'Available',
                ESEWA: 'Available',
                KHALTI: 'Available'
            }
        });
    });

    return router;
};
