const express = require('express');
const {
    listTokens,
    createToken,
    revokeToken,
    rotateToken,
    getApiDocumentation
} = require('../controllers/apiToken.controller');

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

    router.get('/', checkAnyPermission(['api_tokens_manage', 'settings_read']), listTokens);
    router.get('/documentation', checkAnyPermission(['api_tokens_manage', 'settings_read']), getApiDocumentation);
    router.post('/', checkAnyPermission(['api_tokens_manage', 'settings_update']), createToken);
    router.post('/:id/revoke', checkAnyPermission(['api_tokens_manage', 'settings_update']), revokeToken);
    router.post('/:id/rotate', checkAnyPermission(['api_tokens_manage', 'settings_update']), rotateToken);

    return router;
};
