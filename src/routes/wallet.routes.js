const express = require('express');
const {
    getWallet,
    addFunds,
    deductFunds,
    getTransactions,
    reverseTransaction
} = require('../controllers/wallet.controller');

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

    router.get('/', checkAnyPermission(['wallet_view', 'billing_read']), getWallet);
    router.post('/add-funds', checkAnyPermission(['wallet_topup', 'billing_update']), addFunds);
    router.post('/deduct-funds', checkAnyPermission(['wallet_debit', 'billing_update']), deductFunds);
    router.get('/transactions', checkAnyPermission(['wallet_view', 'billing_read']), getTransactions);
    router.post('/transactions/:transactionId/reverse', checkAnyPermission(['wallet_adjust', 'billing_update']), reverseTransaction);

    return router;
};
