const express = require('express');
const {
    importBranches,
    importPlans,
    importPackages,
    importLeads,
    importCustomers,
    importOlts,
    getSampleTemplate
} = require('../controllers/import.controller');

const isAuthenticated = require('../middlewares/isAuthenticated');
const checkAnyPermission = require('../middlewares/checkAnyPermission');

module.exports = (prisma) => {
    const router = express.Router();

    // Attach prisma client to req
    router.use((req, res, next) => {
        req.prisma = prisma;
        next();
    });

    // Optional auth middleware helper to populate req.user & req.ispId if token exists
    const optionalAuth = async (req, res, next) => {
        try {
            let token = req.cookies?.access_token;
            if (!token && req.headers.authorization?.startsWith('Bearer ')) {
                token = req.headers.authorization.slice(7).trim();
            }
            if (token && process.env.ACCESS_SECRET) {
                const jwt = require('jsonwebtoken');
                const payload = jwt.verify(token, process.env.ACCESS_SECRET);
                if (payload?.userId) {
                    const user = await prisma.user.findUnique({
                        where: { id: payload.userId },
                        select: { id: true, ispId: true, email: true }
                    });
                    if (user) {
                        req.user = user;
                        req.ispId = user.ispId;
                    }
                }
            }
        } catch (e) {
            // Ignore auth error for public/optional template download
        }
        next();
    };

    // Public or authenticated template download (supports branches, plans, packages, leads, customers, olts)
    router.get('/template/:type', optionalAuth, getSampleTemplate);

    // Apply isAuthenticated globally for import processing
    router.use(isAuthenticated(prisma));

    // Import branches & sub-branches
    router.post('/branches', checkAnyPermission(['branches_create', 'branch_create', 'branches_manage', 'branch_manage', 'settings_manage', 'admin', 'administrator']), importBranches);

    // Import base internet plans (PackagePlan with NAS types, speeds, organization branch mapping, RADIUS attributes)
    router.post('/plans', checkAnyPermission(['package_plans_create', 'package_plan_create', 'packages_create', 'package_create', 'package_plans_manage', 'packages_manage', 'package_manage', 'plans_create', 'plans_manage', 'settings_manage', 'admin', 'administrator']), importPlans);
    router.post('/package-plans', checkAnyPermission(['package_plans_create', 'package_plan_create', 'packages_create', 'package_create', 'package_plans_manage', 'packages_manage', 'package_manage', 'plans_create', 'plans_manage', 'settings_manage', 'admin', 'administrator']), importPlans);

    // Import packages & tariffs (PackagePrice with 1M, 3M, 6M, 12M rate sheets)
    router.post('/packages', checkAnyPermission(['packages_create', 'package_create', 'packages_manage', 'package_manage', 'package_prices_create', 'package_prices_manage', 'tariffs_manage', 'tariffs_create', 'settings_manage', 'admin', 'administrator']), importPackages);

    // Import leads (CRM)
    router.post('/leads', checkAnyPermission(['lead_create', 'leads_create', 'leads_manage', 'lead_manage', 'crm_manage', 'settings_manage', 'admin', 'administrator']), importLeads);

    // Import customers (with FreeRADIUS & Lead ID linkage)
    router.post('/customers', checkAnyPermission(['customers_create', 'customer_create', 'customers_manage', 'customer_manage', 'settings_manage', 'admin', 'administrator']), importCustomers);

    // Import OLTs (with SSH/Telnet credentials, service boards array, VLANs, and profiles)
    router.post('/olts', checkAnyPermission(['olt_create', 'olts_create', 'olt_manage', 'olts_manage', 'devices_manage', 'settings_manage', 'admin', 'administrator']), importOlts);
    router.post('/olt', checkAnyPermission(['olt_create', 'olts_create', 'olt_manage', 'olts_manage', 'devices_manage', 'settings_manage', 'admin', 'administrator']), importOlts);

    return router;
};
