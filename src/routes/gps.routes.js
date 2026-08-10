const express = require('express');
const {
    updateLocation,
    getFieldStaffLocations,
    getLocationHistory
} = require('../controllers/gps.controller');

const isAuthenticated = require('../middlewares/isAuthenticated');
const checkPermission = require('../middlewares/checkPermission');
const checkAnyPermission = require('../middlewares/checkAnyPermission');
const createRateLimit = require('../middlewares/rateLimit');

function canSubmitOwnLocation(req, res, next) {
    const role = String(req.user?.role || '').toLowerCase();
    const isFieldStaff = role.includes('field staff') || role.includes('field_staff');
    const hasPermission = req.user?.permissions?.includes('gps_submit_own');
    const isAdministrator = ['administrator', 'super admin', 'super_admin', 'admin'].includes(role);

    if (isFieldStaff || hasPermission || isAdministrator) return next();
    return res.status(403).json({ message: 'Access Denied' });
}

module.exports = (prisma) => {
    const router = express.Router();

    router.use((req, res, next) => {
        req.prisma = prisma;
        next();
    });

    router.use(isAuthenticated(prisma));

    router.post('/update', createRateLimit({ windowMs: 60_000, max: 30 }), canSubmitOwnLocation, updateLocation);
    router.get('/field-staff', checkAnyPermission(['gps_view', 'users_read']), getFieldStaffLocations);
    router.get('/history/:userId', checkAnyPermission(['gps_view', 'users_read']), getLocationHistory);

    return router;
};
