const express = require('express');
const {
    listResellers,
    getResellerById,
    createReseller,
    updateReseller,
    deleteReseller,
    assignCustomerToReseller,
    assignDeviceToReseller,
    listResellerDevices
} = require('../controllers/reseller.controller');

const isAuthenticated = require('../middlewares/isAuthenticated');
const checkPermission = require('../middlewares/checkPermission');
const checkAnyPermission = require('../middlewares/checkAnyPermission');

module.exports = (prisma) => {
    const router = express.Router();

    router.use((req, res, next) => {
        req.prisma = prisma;
        next();
    });

    router.use(isAuthenticated(prisma));

    const view = checkAnyPermission(['reseller_view', 'branch_read']);
    const manage = checkAnyPermission(['reseller_manage', 'branch_update']);
    router.get('/', view, listResellers);
    router.post('/', manage, createReseller);
    router.get('/:id', view, getResellerById);
    router.put('/:id', manage, updateReseller);
    router.delete('/:id', manage, deleteReseller);
    router.get('/:id/devices', view, listResellerDevices);
    router.post('/:id/assign-customer', manage, assignCustomerToReseller);
    router.post('/:id/assign-device', checkAnyPermission(['reseller_device_assign', 'branch_update']), assignDeviceToReseller);

    return router;
};
