const express = require('express');
const {
    listBillingAccounts,
    createBillingAccount,
    updateBillingAccount,
    listCategories,
    createCategory,
    listItems,
    createItem,
    listSales,
    createSale,
    listPurchases,
    createPurchase,
    listExpenses,
    createExpense,
    createTransfer,
    listTransfers,
    getAccountingDashboard,
    checkCustomerSubscription
} = require('../controllers/accounting.controller');

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
    const view = checkAnyPermission(['accounting_view', 'billing_read']);
    const manage = checkAnyPermission(['accounting_manage', 'billing_update']);

    // Billing Accounts
    router.get('/accounts', view, listBillingAccounts);
    router.post('/accounts', manage, createBillingAccount);
    router.put('/accounts/:id', manage, updateBillingAccount);

    // Categories & Items
    router.get('/categories', view, listCategories);
    router.post('/categories', manage, createCategory);
    router.get('/items', view, listItems);
    router.post('/items', manage, createItem);

    // Sales
    router.get('/sales', view, listSales);
    router.post('/sales', manage, createSale);

    // Purchases
    router.get('/purchases', view, listPurchases);
    router.post('/purchases', manage, createPurchase);

    // Expenses
    router.get('/expenses', view, listExpenses);
    router.post('/expenses', manage, createExpense);

    // Account to Account Transfers
    router.get('/transfers', view, listTransfers);
    router.post('/transfers', manage, createTransfer);

    // Customer Subscription Check
    router.get('/customer-subscription-check/:customerId', view, checkCustomerSubscription);

    // Dashboard & Reports
    router.get('/dashboard', view, getAccountingDashboard);

    return router;
};
