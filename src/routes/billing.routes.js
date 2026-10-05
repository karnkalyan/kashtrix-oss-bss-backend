const express = require('express');
const {
    updatePaymentMode,
    extendSubscription,
    togglePause,
    addAdjustmentItem,
    removeAdjustmentItem,
    applyDiscount,
    payOrder,
    renewSubscription,
    generateManualInvoice,
    getBillingStats,
    listInvoices,
    getInvoiceSummary,
    listInvoiceRanges,
    createInvoiceRange,
    toggleInvoiceRange,
    deleteInvoiceRange,
    listFiscalYears,
    createFiscalYear,
    updateFiscalYear,
    listPaymentMethods,
    savePaymentMethod
    ,syncInvoiceToAccounting
} = require('../controllers/billing.controller');

const isAuthenticated = require('../middlewares/isAuthenticated');
const checkPermission = require('../middlewares/checkPermission');
const checkAnyPermission = require('../middlewares/checkAnyPermission');

module.exports = (prisma) => {
    const router = express.Router();

    // Attach prisma client to req
    router.use((req, res, next) => { req.prisma = prisma; next(); });

    // Apply isAuthenticated globally for billing routes
    router.use(isAuthenticated(prisma));

    router.post('/extend', checkAnyPermission(['billing_update', 'customer_update']), extendSubscription);
    router.post('/pause-play', checkAnyPermission(['billing_update', 'customer_update']), togglePause);
    router.post('/adjustments/add', checkPermission('billing_update'), addAdjustmentItem);
    router.post('/adjustments/remove', checkPermission('billing_update'), removeAdjustmentItem);
    router.post('/adjustments/discount', checkPermission('billing_update'), applyDiscount);
    router.post('/invoices/discount', checkPermission('billing_update'), applyDiscount);
    router.post('/pay', checkPermission('billing_update'), payOrder);
    router.post('/update-payment-mode', checkPermission('billing_update'), updatePaymentMode);
    router.post('/renew', checkAnyPermission(['billing_create', 'billing_read_self', 'customer_read']), renewSubscription);
    router.post('/generate-manual', checkPermission('billing_create'), generateManualInvoice);
    router.get('/stats', checkPermission('billing_read'), getBillingStats);

    // New Invoices endpoints
    router.get('/invoices', checkAnyPermission(['billing_read', 'billing_read_self']), listInvoices);
    router.get('/invoices/summary', checkAnyPermission(['billing_read', 'billing_read_self']), getInvoiceSummary);
    router.post('/invoices/:id/sync-accounting', checkPermission('billing_update'), syncInvoiceToAccounting);

    // New Invoice Range allocation endpoints
    router.get('/invoice-ranges', checkAnyPermission(['billing_read', 'billing_read_self']), listInvoiceRanges);
    router.post('/invoice-ranges', checkPermission('billing_update'), createInvoiceRange);
    router.patch('/invoice-ranges/:id', checkPermission('billing_update'), toggleInvoiceRange);
    router.delete('/invoice-ranges/:id', checkPermission('billing_update'), deleteInvoiceRange);
    router.get('/fiscal-years', checkAnyPermission(['billing_read', 'billing_create', 'billing_read_self']), listFiscalYears);
    router.post('/fiscal-years', checkPermission('billing_update'), createFiscalYear);
    router.patch('/fiscal-years/:id', checkPermission('billing_update'), updateFiscalYear);
    router.get('/payment-methods', checkAnyPermission(['billing_read', 'billing_create', 'billing_read_self']), listPaymentMethods);
    router.post('/payment-methods', checkPermission('billing_update'), savePaymentMethod);
    router.patch('/payment-methods/:id', checkPermission('billing_update'), savePaymentMethod);

    return router;
}
