const { computeExpiryFromBase, convertToNepaliDate } = require('../utils/dateHelper');

const formatADDate = (date) => {
    if (!date) return '';
    const d = new Date(date);
    if (isNaN(d.getTime())) return '';
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
};
const { formatRadiusExpiration } = require('../utils/radiusExpiration');
const { RadiusClient } = require('../services/radiusClient');
const { getBranchFilter } = require('../utils/branchHelper');
const { syncOrderToAccounting, fetchAccountingInvoices } = require('../services/accountingInvoice.service');

async function syncPaidOrderAccounting(prisma, ispId, orderId) {
    try {
        return await syncOrderToAccounting(prisma, ispId, orderId);
    } catch (error) {
        console.error('[ACCOUNTING] Sales invoice sync failed:', { ispId, orderId, error: error.message });
        return null;
    }
}

async function debitResellerWallet(tx, {
    ispId, resellerId, amount, customerId, invoiceId, orderId, userId, action
}) {
    const debitAmount = Number(amount);
    if (!resellerId || !Number.isFinite(debitAmount) || debitAmount <= 0) return null;
    const wallet = await tx.wallet.findFirst({
        where: { ispId: Number(ispId), resellerId: Number(resellerId) }
    });
    if (!wallet) throw Object.assign(new Error('Reseller wallet is not configured'), { status: 409 });
    const idempotencyKey = `${action}:${orderId}`;
    const existing = await tx.walletTransaction.findUnique({
        where: { walletId_idempotencyKey: { walletId: wallet.id, idempotencyKey } }
    });
    if (existing) return existing;
    const changed = await tx.wallet.updateMany({
        where: {
            id: wallet.id,
            balance: { gte: wallet.reservedBalance.plus(debitAmount) }
        },
        data: { balance: { decrement: debitAmount } }
    });
    if (changed.count !== 1) {
        throw Object.assign(new Error('Insufficient reseller wallet balance'), {
            status: 409,
            code: 'INSUFFICIENT_WALLET_BALANCE'
        });
    }
    const updated = await tx.wallet.findUnique({ where: { id: wallet.id } });
    return tx.walletTransaction.create({
        data: {
            walletId: wallet.id,
            type: 'DEBIT',
            amount: debitAmount.toFixed(2),
            balanceAfter: updated.balance,
            description: action === 'RENEWAL' ? 'Customer package renewal' : 'Invoice payment',
            reference: `ORDER-${orderId}`,
            idempotencyKey,
            createdById: userId || null,
            relatedCustomerId: Number(customerId),
            relatedInvoiceId: invoiceId ? String(invoiceId) : null,
            resellerId: Number(resellerId),
            metadata: { action, orderId: Number(orderId), paymentSource: 'RESELLER_WALLET' }
        }
    });
}

async function syncRadiusExpirationAndDisconnect(ispId, connectionUsers, expiration, context) {
    const users = (connectionUsers || []).filter(user => user?.username && user.isDeleted !== true && user.isActive !== false);
    if (!users.length) {
        console.warn('[BILLING RADIUS] No active connection users to synchronize', { ispId, context });
        return;
    }

    try {
        console.log('[BILLING RADIUS] Synchronization started', {
            ispId,
            context,
            expiration: formatRadiusExpiration(expiration),
            timezone: 'Asia/Kathmandu',
            usernames: users.map(user => user.username)
        });
        const radius = await RadiusClient.create(ispId);
        for (const user of users) {
            await radius.updateExpiration(user.username, expiration);
            console.log('[BILLING RADIUS] Expiration synchronized', { context, username: user.username });
            let sessionDisconnectAttempted = false;
            let sessionDisconnectSucceeded = false;
            try {
                const sessionInfo = await radius.getSessionInfo(user.username);
                const sessions = Array.isArray(sessionInfo)
                    ? sessionInfo
                    : Array.isArray(sessionInfo?.sessions)
                        ? sessionInfo.sessions
                        : Array.isArray(sessionInfo?.data)
                            ? sessionInfo.data
                            : Array.isArray(sessionInfo?.data?.sessions)
                                ? sessionInfo.data.sessions
                                : [];
                const activeSessions = sessions.filter(session =>
                    !session.acctstoptime && !session.acctStopTime && !session.stop_time
                );
                for (const session of activeSessions) {
                    const sessionId = session.acctsessionid || session.acctSessionId || session.session_id || session.sessionId;
                    if (!sessionId) continue;
                    sessionDisconnectAttempted = true;
                    await radius.disconnectBySessionId(sessionId);
                    console.log('[BILLING RADIUS] Session disconnected by ID', {
                        context,
                        username: user.username,
                        sessionId
                    });
                }
                sessionDisconnectSucceeded = sessionDisconnectAttempted;
            } catch (disconnectError) {
                console.warn(`Session-ID disconnect failed during ${context} for ${user.username}:`, disconnectError.message);
            }
            if (!sessionDisconnectSucceeded) {
                try {
                    await radius.disconnectAllSessions(user.username);
                    console.log('[BILLING RADIUS] Username-wide disconnect completed', {
                        context,
                        username: user.username
                    });
                } catch (disconnectError) {
                    console.warn(`Radius expiration updated but username disconnect failed during ${context} for ${user.username}:`, disconnectError.message);
                }
            }
        }
        console.log('[BILLING RADIUS] Synchronization completed', { ispId, context });
    } catch (error) {
        console.error('[BILLING RADIUS] Synchronization failed', {
            ispId,
            context,
            expiration: (() => { try { return formatRadiusExpiration(expiration); } catch { return expiration; } })(),
            error: error.message,
            responseStatus: error.responseStatus || null,
            responseData: error.responseData || null
        });
    }
}

function getRenewalBase(subscription, now = new Date()) {
    if (!subscription) return now;
    const planEnd = subscription?.planEnd ? new Date(subscription.planEnd) : now;
    const graceDays = Math.max(0, Number(subscription?.graceDaysBalance || 0));
    const adminDays = Math.max(0, Number(subscription?.adminExtensionDays || 0));
    const deductibleDays = graceDays + adminDays;
    const expiryBeforeExtension = new Date(planEnd);
    expiryBeforeExtension.setDate(expiryBeforeExtension.getDate() - deductibleDays);
    expiryBeforeExtension.setHours(0, 0, 0, 0);
    if (deductibleDays > 0) return expiryBeforeExtension;
    const result = planEnd >= now ? planEnd : now;
    result.setHours(0, 0, 0, 0);
    return result;
}

async function getRenewalWindow(prisma, ispId, subscription) {
    const now = new Date();
    if (!subscription) return { planStart: now, trialDeductionDays: 0 };
    const baseStart = getRenewalBase(subscription, now);
    if (!subscription.isTrial) return { planStart: baseStart, trialDeductionDays: 0 };
    const setting = await prisma.iSPSettings.findFirst({ where: { ispId: Number(ispId), key: 'trialDeductionOnSubscriptionActivation' } });
    const deductTrial = setting?.value === 'true';
    const trialMs = Math.max(0, new Date(subscription.planEnd) - new Date(subscription.planStart));
    return { planStart: baseStart, trialDeductionDays: deductTrial ? Math.ceil(trialMs / 86400000) : 0 };
}

async function resolveActiveFiscalYear(prisma, ispId, fiscalYearId) {
    const now = new Date();
    return prisma.fiscalYear.findFirst({
        where: {
            ispId: Number(ispId),
            isEnabled: true,
            startDate: { lte: now },
            endDate: { gte: now },
            ...(fiscalYearId ? { id: Number(fiscalYearId) } : {})
        },
        orderBy: { startDate: 'desc' }
    });
}

/**
 * Extend a customer's subscription
 */
async function extendSubscription(req, res, next) {
    const prisma = req.prisma;
    const { customerId, days, extendToDate, type } = req.body; // grace, compensation, admin_extension
    
    try {
        console.log('[SUBSCRIPTION EXTENSION] Request received', {
            customerId: Number(customerId),
            ispId: req.ispId,
            type,
            days: days ?? null,
            extendToDate: extendToDate || null
        });
        const role = String(typeof req.user?.role === 'string' ? req.user.role : req.user?.role?.name || '').toLowerCase();
        const isAdmin = ['admin', 'isp_admin', 'administrator', 'super_admin', 'global admin', 'global_admin'].includes(role);
        const subscription = await prisma.customerSubscription.findFirst({
            where: { 
                customerId: Number(customerId), 
                isActive: true,
                customer: { ispId: req.ispId, ...(req.branchId ? { branchId: req.branchId } : {}), ...(req.user?.resellerId ? { resellerId: Number(req.user.resellerId) } : {}) }
            },
            include: { customer: { include: { connectionUsers: true } } },
            orderBy: { createdAt: 'desc' }
        });

        if (!subscription) return res.status(404).json({ error: 'Active subscription not found' });
        if (subscription.isTrial && !isAdmin) {
            return res.status(403).json({ error: 'Only an administrator can extend a trial subscription.' });
        }

        if (!['grace', 'compensation', 'admin_extension'].includes(type)) {
            return res.status(400).json({ error: 'Invalid extension type' });
        }
        if (type === 'admin_extension' && !isAdmin) {
            return res.status(403).json({ error: 'Only an administrator can apply an admin extension' });
        }
        if (type === 'grace') {
            const now = new Date();
            if (subscription.planEnd && new Date(subscription.planEnd) > now) {
                return res.status(400).json({ error: 'Grace period is not valid. Customer already has a valid subscription.' });
            }
            if (Number(subscription.graceDaysBalance || 0) > 0) {
                return res.status(400).json({ error: 'Grace period has already been used for this subscription.' });
            }
            if (extendToDate) return res.status(400).json({ error: 'Grace uses the configured fixed duration, not a custom date.' });
            const graceSetting = await prisma.iSPSettings.findFirst({ where: { ispId: req.ispId, key: 'maxStaffGraceDays' } });
            const configuredGraceDays = Math.max(1, Number(graceSetting?.value || 3));
            if (Number(days) !== configuredGraceDays) {
                return res.status(400).json({ error: `Grace period must be exactly ${configuredGraceDays} days.` });
            }
        }

        // Normal staff can only extend by 3 days once and only as 'grace'
        if (!isAdmin) {
            const graceSetting = await prisma.iSPSettings.findFirst({ where: { ispId: req.ispId, key: 'maxStaffGraceDays' } });
            const maxGraceDays = Math.max(1, Number(graceSetting?.value || 3));
            if (type === 'compensation') {
                const setting = await prisma.iSPSettings.findFirst({ where: { ispId: req.ispId, key: 'allowStaffCompensation' } });
                if (setting?.value !== 'true') return res.status(403).json({ error: 'Staff compensation is disabled.' });
            } else if (type !== 'grace') {
                return res.status(403).json({ error: 'Only administrators can apply this extension type.' });
            }
            if (!Number.isInteger(Number(days)) || Number(days) < 1 || Number(days) > maxGraceDays) return res.status(403).json({ error: `Extension must be between 1 and ${maxGraceDays} days.` });
        }

        let newPlanEnd;
        if (extendToDate) {
            newPlanEnd = new Date(extendToDate);
        } else {
            newPlanEnd = new Date(subscription.planEnd);
            newPlanEnd.setDate(newPlanEnd.getDate() + Number(days));
        }

        if (isNaN(newPlanEnd.getTime()) || newPlanEnd <= new Date(subscription.planEnd)) {
            return res.status(400).json({ error: 'Extension must move the expiry date forward' });
        }

        const extensionDays = Math.ceil((newPlanEnd - new Date(subscription.planEnd)) / (1000 * 60 * 60 * 24));

        await prisma.$transaction(async (tx) => {
            await tx.customerSubscription.update({
                where: { id: subscription.id },
                data: {
                    planEnd: newPlanEnd,
                    extensionCount: { increment: 1 },
                    graceDaysBalance: type === 'grace' ? { increment: extensionDays } : undefined,
                    compensationDays: type === 'compensation' ? { increment: extensionDays } : undefined,
                    adminExtensionDays: type === 'admin_extension' ? { increment: extensionDays } : undefined
                }
            });

            // If customer is inactive, set them back to active
            const customerObj = await tx.customer.findUnique({
                where: { id: Number(customerId) },
                select: { status: true }
            });

            if (customerObj && customerObj.status !== 'active') {
                await tx.customer.update({
                    where: { id: Number(customerId) },
                    data: {
                        status: 'active',
                        onboardStatus: 'fully_onboarded'
                    }
                });

                await tx.customerServiceConnection.updateMany({
                    where: { customerId: Number(customerId), status: { not: 'active' } },
                    data: { status: 'active' }
                });

                await tx.connectionUser.updateMany({
                    where: { customerId: Number(customerId), isDeleted: false, isActive: false },
                    data: { isActive: true }
                });
            }
        });
        await syncRadiusExpirationAndDisconnect(req.ispId, subscription.customer.connectionUsers, newPlanEnd, `${type} extension`);

        console.log('[SUBSCRIPTION EXTENSION] Completed', {
            customerId: Number(customerId),
            subscriptionId: subscription.id,
            type,
            newPlanEnd: newPlanEnd.toISOString()
        });

        res.json({ success: true, newPlanEnd, type });
    } catch (err) {
        console.error('[SUBSCRIPTION EXTENSION] Failed', {
            customerId: Number(customerId),
            ispId: req.ispId,
            type,
            error: err.message
        });
        next(err);
    }
}

/**
 * Pause / Play functionality
 */
async function togglePause(req, res, next) {
    const prisma = req.prisma;
    const { customerId, action } = req.body; // action: 'pause' or 'play'

    try {
        console.log('[SUBSCRIPTION PAUSE/PLAY] Request received', {
            customerId: Number(customerId),
            ispId: req.ispId,
            action
        });
        if (!['pause', 'play'].includes(action)) {
            return res.status(400).json({ error: "Action must be 'pause' or 'play'" });
        }
        const subscription = await prisma.customerSubscription.findFirst({
            where: { 
                customerId: Number(customerId), 
                isActive: true,
                customer: { ispId: req.ispId, ...(req.branchId ? { branchId: req.branchId } : {}), ...(req.user?.resellerId ? { resellerId: Number(req.user.resellerId) } : {}) }
            },
            include: { customer: { include: { connectionUsers: true } } },
            orderBy: { createdAt: 'desc' }
        });

        if (!subscription) return res.status(404).json({ error: 'Active subscription not found' });

        if (action === 'pause') {
            if (!subscription.isPaused && new Date(subscription.planEnd) <= new Date()) {
                return res.status(400).json({ error: 'Expired subscriptions cannot be paused' });
            }
            
            const pausedAt = new Date();
            if (!subscription.isPaused) {
                await prisma.$transaction(async (tx) => {
                    await tx.customerSubscription.update({
                        where: { id: subscription.id },
                        data: { isPaused: true, pauseDate: pausedAt }
                    });
                });
            }
            await syncRadiusExpirationAndDisconnect(req.ispId, subscription.customer.connectionUsers, pausedAt, 'service pause');
            console.log('[SUBSCRIPTION PAUSE/PLAY] Pause synchronized', {
                customerId: Number(customerId),
                subscriptionId: subscription.id,
                alreadyPaused: subscription.isPaused,
                radiusExpiration: formatRadiusExpiration(pausedAt),
                timezone: 'Asia/Kathmandu'
            });
        } else if (action === 'play') {
            if (!subscription.isPaused) return res.status(400).json({ error: 'Not paused' });

            const pauseDate = new Date(subscription.pauseDate);
            const now = new Date();
            const pauseDurationMs = now - pauseDate;

            const newPlanEnd = new Date(subscription.planEnd.getTime() + pauseDurationMs);

            await prisma.$transaction(async (tx) => {
                await tx.customerSubscription.update({
                    where: { id: subscription.id },
                    data: { isPaused: false, pauseDate: null, planEnd: newPlanEnd }
                });
            });
            await syncRadiusExpirationAndDisconnect(req.ispId, subscription.customer.connectionUsers, newPlanEnd, 'service resume');
            console.log('[SUBSCRIPTION PAUSE/PLAY] Resume synchronized', {
                customerId: Number(customerId),
                subscriptionId: subscription.id,
                newPlanEnd: newPlanEnd.toISOString()
            });
        }


        res.json({ success: true, action, isPaused: action === 'pause' });
    } catch (err) {
        console.error('[SUBSCRIPTION PAUSE/PLAY] Failed', {
            customerId: Number(customerId),
            ispId: req.ispId,
            action,
            error: err.message
        });
        next(err);
    }
}

/**
 * Add / Remove Custom Adjustment Items
 */
async function addAdjustmentItem(req, res, next) {
    const prisma = req.prisma;
    const { orderId, itemName, itemPrice } = req.body;

    try {
        const order = await prisma.customerOrderManagement.findUnique({
            where: { id: Number(orderId) },
            include: { items: true }
        });

        if (!order) return res.status(404).json({ error: 'Order not found' });

        if (Number(itemPrice) < 0) {
            const orderCustomer = await prisma.customer.findUnique({
                where: { id: order.customerId },
                include: { branch: true }
            });
            const branch = orderCustomer?.branch;
            if (branch && branch.discountThresholdEnabled && Math.abs(Number(itemPrice)) > branch.discountThresholdValue) {
                return res.status(400).json({ 
                    error: `Discount exceeds branch limit of ${branch.discountThresholdValue} NPR. Please request admin approval.`,
                    exceedsLimit: true,
                    limitValue: branch.discountThresholdValue,
                    requestedValue: Math.abs(Number(itemPrice))
                });
            }
        }

        if (order.isPaid) return res.status(400).json({ error: 'Cannot add adjustment to a paid invoice.' });

        const updatedOrder = await prisma.$transaction(async (tx) => {
            const newItem = await tx.orderDetail.create({
                data: {
                    orderId: order.id,
                    itemName,
                    itemPrice: parseFloat(itemPrice)
                }
            });

            const totalAmount = order.totalAmount + newItem.itemPrice;

            return await tx.customerOrderManagement.update({
                where: { id: order.id },
                data: { totalAmount },
                include: { items: true }
            });
        });

        res.json(updatedOrder);
    } catch (err) {
        next(err);
    }
}

async function removeAdjustmentItem(req, res, next) {
    const prisma = req.prisma;
    const { detailId } = req.body;

    try {
        const detail = await prisma.orderDetail.findUnique({
            where: { id: Number(detailId) },
            include: { order: true }
        });

        if (!detail) return res.status(404).json({ error: 'Item not found' });

        if (detail.order.isPaid) return res.status(400).json({ error: 'Cannot remove adjustment from a paid invoice.' });

        const updatedOrder = await prisma.$transaction(async (tx) => {
            await tx.orderDetail.delete({ where: { id: detail.id } });
            
            const totalAmount = detail.order.totalAmount - detail.itemPrice;

            return await tx.customerOrderManagement.update({
                where: { id: detail.order.id },
                data: { totalAmount },
                include: { items: true }
            });
        });

        res.json(updatedOrder);
    } catch (err) {
        next(err);
    }
}

/**
 * Pay an arbitrary order with invoice ID validation
 */
/**
 * Apply Discount to Invoice (Flat or Percentage)
 */
async function applyDiscount(req, res, next) {
    const prisma = req.prisma;
    const { orderId, discountType, discountValue, reason, applyToItemId } = req.body;

    try {
        const order = await prisma.customerOrderManagement.findUnique({
            where: { id: Number(orderId) },
            include: { items: true }
        });

        if (!order) return res.status(404).json({ error: 'Order not found' });
        if (order.isPaid) return res.status(400).json({ error: 'Cannot apply discount to a paid invoice.' });

        const val = parseFloat(discountValue);
        if (isNaN(val) || val <= 0) {
            return res.status(400).json({ error: 'Discount value must be a positive number' });
        }

        let baseAmount = order.totalAmount;
        let targetItemName = '';

        if (applyToItemId) {
            const targetItem = order.items.find(i => i.id === Number(applyToItemId));
            if (targetItem) {
                baseAmount = Math.max(0, targetItem.itemPrice);
                targetItemName = ` (${targetItem.itemName})`;
            }
        } else {
            const positiveSum = order.items
                .filter(i => Number(i.itemPrice) > 0)
                .reduce((sum, i) => sum + Number(i.itemPrice), 0);
            if (positiveSum > 0) baseAmount = positiveSum;
        }

        let discountAmount = 0;
        let discountLabel = '';

        if (discountType === 'percentage') {
            if (val > 100) {
                return res.status(400).json({ error: 'Percentage discount cannot exceed 100%' });
            }
            discountAmount = Math.round((baseAmount * val) / 100 * 100) / 100;
            discountLabel = reason?.trim() ? `${reason.trim()} (${val}%)` : `Discount (${val}%${targetItemName})`;
        } else {
            discountAmount = Math.round(val * 100) / 100;
            discountLabel = reason?.trim() ? `${reason.trim()} (Flat NPR ${discountAmount})` : `Discount (Flat NPR ${discountAmount}${targetItemName})`;
        }

        if (discountAmount <= 0) {
            return res.status(400).json({ error: 'Calculated discount must be greater than 0' });
        }

        const orderCustomer = await prisma.customer.findUnique({
            where: { id: order.customerId },
            include: { branch: true }
        });
        const branch = orderCustomer?.branch;
        if (branch && branch.discountThresholdEnabled && discountAmount > branch.discountThresholdValue) {
            return res.status(400).json({ 
                error: `Discount exceeds branch limit of ${branch.discountThresholdValue} NPR. Please request admin approval.`,
                exceedsLimit: true,
                limitValue: branch.discountThresholdValue,
                requestedValue: discountAmount
            });
        }

        const updatedOrder = await prisma.$transaction(async (tx) => {
            await tx.orderDetail.create({
                data: {
                    orderId: order.id,
                    itemName: discountLabel,
                    itemPrice: -discountAmount
                }
            });

            const allItems = await tx.orderDetail.findMany({
                where: { orderId: order.id }
            });
            const newTotal = Math.max(0, allItems.reduce((sum, i) => sum + Number(i.itemPrice), 0));

            return await tx.customerOrderManagement.update({
                where: { id: order.id },
                data: { totalAmount: newTotal },
                include: { items: true }
            });
        });

        res.json(updatedOrder);
    } catch (err) {
        next(err);
    }
}

async function payOrder(req, res, next) {
    const prisma = req.prisma;
    const orderId = req.params.orderId || req.body.orderId;
    const { invoiceId, paymentMethod, amount, fiscalYearId, paymentMethodId } = req.body;
    
    try {
        const order = await prisma.customerOrderManagement.findUnique({
            where: { id: Number(orderId) }
        });

        if (!order) return res.status(404).json({ error: 'Order not found' });
        if (order.isPaid) return res.status(400).json({ error: 'Order already paid' });

        const customer = await prisma.customer.findFirst({
            where: { 
                id: order.customerId, 
                ispId: req.ispId, 
                isDeleted: false,
                ...(req.branchId ? { branchId: req.branchId } : {}),
                ...(req.user?.resellerId ? { resellerId: Number(req.user.resellerId) } : {})
            },
            select: { id: true, branchId: true, resellerId: true }
        });

        if (!customer) return res.status(404).json({ error: 'Customer not found' });

        if (amount === undefined || amount === null) {
            return res.status(400).json({ error: 'Payment amount is required for validation' });
        }
        if (Number(amount) !== Number(order.totalAmount)) {
            return res.status(400).json({ error: `Incorrect payment amount. Expected: ${order.totalAmount}, Received: ${amount}` });
        }

        const invIdNumeric = Number(invoiceId);
        if (isNaN(invIdNumeric)) return res.status(400).json({ error: 'Invoice ID must be numeric' });

        const fiscalYear = await resolveActiveFiscalYear(prisma, req.ispId, fiscalYearId);
        if (!fiscalYear) return res.status(400).json({ error: 'Select the fiscal year that is active for the current date' });

        const paymentMethodRecord = paymentMethodId 
            ? await prisma.billingPaymentMethod.findUnique({ where: { id: Number(paymentMethodId) } })
            : null;

        // Enforce global uniqueness of the invoice ID within the same ISP and fiscal year
        const existingInvoice = await prisma.customerOrderManagement.findFirst({
            where: {
                invoiceId: invoiceId.toString(),
                isPaid: true,
                fiscalYearId: fiscalYear.id,
                customer: {
                    ispId: req.ispId
                }
            }
        });
        if (existingInvoice) {
            return res.status(400).json({ error: 'Invoice number is already used/duplicate in this fiscal year' });
        }

        // Check branch invoice range for this fiscal year
        if (customer.branchId) {
            const ranges = await prisma.branchInvoiceRange.findMany({
                where: { branchId: customer.branchId, fiscalYearId: fiscalYear.id, isActive: true }
            });

            if (ranges.length > 0) {
                const isValid = ranges.some(r => invIdNumeric >= r.rangeStart && invIdNumeric <= r.rangeEnd);
                if (!isValid) {
                    return res.status(400).json({ error: 'Invoice ID is outside the assigned ranges for this branch and fiscal year' });
                }
            }
        }

        const updatedOrder = await prisma.$transaction(async tx => {
            const paid = await tx.customerOrderManagement.update({
                where: { id: order.id },
                data: {
                    isPaid: true,
                    invoiceId: invoiceId.toString(),
                    paymentId: req.user?.resellerId ? 'RESELLER_WALLET' : (paymentMethodRecord ? paymentMethodRecord.code : (paymentMethod || 'CASH')),
                    fiscalYearId: fiscalYear.id,
                    paymentMethodId: req.user?.resellerId ? null : (paymentMethodRecord ? paymentMethodRecord.id : undefined),
                    updatedAt: new Date()
                }
            });
            await debitResellerWallet(tx, {
                ispId: req.ispId,
                resellerId: req.user?.resellerId,
                amount,
                customerId: customer.id,
                invoiceId,
                orderId: order.id,
                userId: req.user?.id,
                action: 'INVOICE_PAYMENT'
            });
            return paid;
        });

        const subscription = await prisma.customerSubscription.findUnique({ where: { id: order.subscriptionId || 0 } });

        if (subscription) {
            await prisma.customerSubscription.update({
                where: { id: subscription.id },
                data: { isActive: true, updatedAt: new Date() }
            });

            await prisma.customer.update({
                where: { id: customer.id },
                data: {
                    status: 'active',
                    onboardStatus: 'fully_onboarded'
                }
            });

            await prisma.customerServiceConnection.updateMany({
                where: { customerId: customer.id },
                data: { status: 'active' }
            });
        }

        const pppUsers = await prisma.connectionUser.findMany({
            where: { customerId: customer.id, isDeleted: false, isActive: true },
            select: { username: true }
        }).catch(() => []);

        if (subscription && pppUsers.length) {
            await syncRadiusExpirationAndDisconnect(req.ispId, pppUsers, subscription.planEnd, 'payment approval');
        }

        await syncPaidOrderAccounting(prisma, req.ispId, updatedOrder.id);

        res.json(updatedOrder);
    } catch (err) {
        next(err);
    }
}

/**
 * Renew a subscription
 */
async function renewSubscription(req, res, next) {
    const prisma = req.prisma;
    const { customerId, packageId, invoiceId, amount, fiscalYearId, paymentMethodId } = req.body;
    
    try {
        const subscription = await prisma.customerSubscription.findFirst({
            where: { customerId: Number(customerId), isActive: true }
        });

        if (!subscription) return res.status(404).json({ error: 'Active subscription not found' });

        const pkgPrice = await prisma.packagePrice.findUnique({
            where: { id: Number(packageId) },
            include: {
                packagePlanDetails: { select: { planName: true } },
                oneTimeCharges: { where: { isDeleted: false, isRenewal: true } }
            }
        });

        if (!pkgPrice) return res.status(404).json({ error: 'Package Price not found' });

        const customer = await prisma.customer.findFirst({
            where: { 
                id: Number(customerId), 
                ispId: req.ispId, 
                isDeleted: false,
                ...(req.branchId ? { branchId: req.branchId } : {}),
                ...(req.user?.resellerId ? { resellerId: Number(req.user.resellerId) } : {})
            },
            include: {
                lead: true
            }
        });

        if (!customer) return res.status(404).json({ error: 'Customer not found' });
        if (req.user?.resellerId) {
            const assignedPlan = await prisma.packagePlanReseller.findFirst({
                where: {
                    packagePlanId: Number(pkgPrice.planId),
                    resellerId: Number(req.user.resellerId)
                },
                select: { id: true }
            });
            if (!assignedPlan) return res.status(403).json({ error: 'This package is not assigned to your reseller account' });
        }

        const fiscalYear = await resolveActiveFiscalYear(prisma, req.ispId, fiscalYearId);
        if (!fiscalYear) return res.status(400).json({ error: 'Select the fiscal year that is active for the current date' });

        const paymentMethod = req.user?.resellerId ? null : await prisma.billingPaymentMethod.findFirst({
            where: { id: Number(paymentMethodId), ispId: req.ispId, isEnabled: true }
        });
        if (!req.user?.resellerId && !paymentMethod) return res.status(400).json({ error: 'Select an enabled payment method' });

        const policyBranchId = customer.subBranchId || customer.branchId;
        const branchPolicy = policyBranchId ? await prisma.branch.findFirst({
            where: { id: Number(policyBranchId), ispId: req.ispId, isDeleted: false },
            select: { receiptRequired: true }
        }) : null;
        if (branchPolicy?.receiptRequired && !invoiceId) {
            return res.status(400).json({ error: 'Invoice/receipt number is required for this branch' });
        }

        const newPackageAmount = pkgPrice.initialTotalWithTax !== null && pkgPrice.initialTotalWithTax !== undefined
            ? Number(pkgPrice.initialTotalWithTax)
            : Number(pkgPrice.price || 0);
        const renewalAmount = pkgPrice.renewAmountWithTax !== null && pkgPrice.renewAmountWithTax !== undefined
            ? Number(pkgPrice.renewAmountWithTax)
            : Number(pkgPrice.price || 0);
        const expectedAmount = customer.isFree ? 0 : (customer.isRechargeable ? renewalAmount : newPackageAmount);

        // Amount validation
        if (amount !== undefined && amount !== null) {
            if (Number(amount) !== Number(expectedAmount)) {
                return res.status(400).json({ error: `Incorrect payment amount. Expected: ${expectedAmount}, Received: ${amount}` });
            }
        }

        let invoiceRange = null;
        if (invoiceId) {
            const invoiceNumber = Number(invoiceId);
            if (isNaN(invoiceNumber)) return res.status(400).json({ error: 'Invoice number must be numeric' });

            // Invoice numbers repeat across fiscal years, but never within one.
            const existingInvoice = await prisma.customerOrderManagement.findFirst({
                where: {
                    invoiceId: invoiceId.toString(),
                    fiscalYearId: fiscalYear.id,
                    isDeleted: false,
                    customer: {
                        ispId: req.ispId
                    }
                }
            });
            if (existingInvoice) {
                return res.status(400).json({ error: 'Invoice number is already used/duplicate in this ISP' });
            }

            if (policyBranchId) {
                const activeRange = await prisma.branchInvoiceRange.findFirst({
                    where: {
                        branchId: Number(policyBranchId),
                        fiscalYearId: fiscalYear.id,
                        isActive: true,
                        rangeStart: { lte: invoiceNumber },
                        rangeEnd: { gte: invoiceNumber }
                    }
                });

                if (!activeRange) {
                    return res.status(400).json({ error: 'Invoice number is outside the active range for this branch' });
                }
                invoiceRange = activeRange;
            }
        }
        
        const renewalWindow = await getRenewalWindow(prisma, req.ispId, subscription);
        const planStart = renewalWindow.planStart;
        const planEnd = computeExpiryFromBase(planStart, pkgPrice.packageDuration);
        if (renewalWindow.trialDeductionDays > 0) planEnd.setDate(planEnd.getDate() - renewalWindow.trialDeductionDays);

        const newSub = await prisma.$transaction(async (tx) => {
            // End old sub
            await tx.customerSubscription.update({
                where: { id: subscription.id },
                data: { isActive: false }
            });

            // Create new sub
            const created = await tx.customerSubscription.create({
                data: {
                    customerId: Number(customerId),
                    package: pkgPrice.id,
                    planStart,
                    planEnd,
                    isTrial: false,
                    isActive: true,
                    isInvoicing: true,
                    extensionCount: 0,
                    graceDaysBalance: 0,
                    compensationDays: 0,
                    adminExtensionDays: 0,
                }
            });

            // Create order for renewal
            const basePrice = customer.isFree ? 0 : (pkgPrice.price || 0);
            const renewalItems = customer.isFree ? [] : pkgPrice.oneTimeCharges.map(item => ({
                itemName: item.name || 'Renewal Item',
                referenceId: item.referenceId,
                itemPrice: Number(item.amount || 0)
            }));
            const renewalItemsTotal = renewalItems.reduce((sum, item) => sum + item.itemPrice, 0);
            
            const orderItems = [];
            const remainder = Math.max(0, basePrice - renewalItemsTotal);
            if (remainder > 0 || renewalItems.length === 0) {
                orderItems.push({
                    itemName: pkgPrice.packagePlanDetails?.planName || pkgPrice.packageName || 'Package Renewal',
                    referenceId: pkgPrice.referenceId,
                    itemPrice: remainder
                });
            }
            orderItems.push(...renewalItems);

            const renewalOrder = await tx.customerOrderManagement.create({
                data: {
                    customerId: Number(customerId),
                    subscriptionId: created.id,
                    package: pkgPrice.id,
                    orderDate: new Date(),
                    packageStart: planStart,
                    packageEnd: planEnd,
                    totalAmount: amount !== undefined ? Number(amount) : expectedAmount,
                    isPaid: Boolean(req.user?.resellerId),
                    isActive: true,
                    invoiceId: invoiceId ? String(invoiceId) : null,
                    paymentId: req.user?.resellerId ? 'RESELLER_WALLET' : 'PENDING_APPROVAL',
                    fiscalYearId: fiscalYear.id,
                    paymentMethodId: paymentMethod?.id || null,
                    updatedAt: new Date(),
                    items: {
                        create: orderItems.map(i => ({
                            itemName: i.itemName,
                            referenceId: i.referenceId,
                            itemPrice: i.itemPrice
                        }))
                    }
                }
            });
            await debitResellerWallet(tx, {
                ispId: req.ispId,
                resellerId: req.user?.resellerId,
                amount: expectedAmount,
                customerId: customer.id,
                invoiceId,
                orderId: renewalOrder.id,
                userId: req.user?.id,
                action: 'RENEWAL'
            });
            if (invoiceRange && invoiceId) {
                await tx.branchInvoiceRange.update({
                    where: { id: invoiceRange.id },
                    data: { current: Math.max(Number(invoiceRange.current), Number(invoiceId) + 1), updatedAt: new Date() }
                });
            }

            await tx.customer.update({
                where: { id: customer.id },
                data: { 
                    subscribedPkgId: pkgPrice.id,
                    assignedPkg: pkgPrice.id,
                    isRechargeable: true,
                    status: 'active',
                    onboardStatus: 'fully_onboarded'
                }
            });

            await tx.customerServiceConnection.updateMany({
                where: { customerId: customer.id },
                data: { status: 'active' }
            });

            await tx.connectionUser.updateMany({
                where: { customerId: customer.id, isDeleted: false },
                data: { isActive: true }
            });

            return created;
        });

        // Sync with FreeRADIUS immediately after successful renewal
        const pppUsers = await prisma.connectionUser.findMany({
            where: { customerId: Number(customerId), isDeleted: false, isActive: true },
            select: { username: true }
        }).catch(() => []);

        if (pppUsers.length > 0) {
            await syncRadiusExpirationAndDisconnect(req.ispId, pppUsers, planEnd, 'subscription renewal');
        }

        // Trigger Recharge Successful Email & SMS notifications
        try {
            const isp = await prisma.iSP.findUnique({ where: { id: req.ispId } });
            const ispName = isp?.companyName || isp?.name || 'ISP';
            const customerName = customer.lead ? `${customer.lead.firstName || ''} ${customer.lead.lastName || ''}`.trim() : 'Customer';

            const customerTemplateData = {
                ispName,
                customerName,
                customerUniqueId: customer.customerUniqueId || `CUST-${customer.id}`,
                packageName: pkgPrice.packagePlanDetails?.planName || pkgPrice.packageName || 'Package',
                amount: amount !== undefined ? Number(amount) : expectedAmount,
                expiryDate: planEnd.toLocaleDateString(),
                planEnd: planEnd.toLocaleDateString(),
                phoneNumber: customer.lead?.phoneNumber || ''
            };

            if (customer.lead?.email) {
                const { enqueueJob } = require('../utils/backgroundQueue');
                enqueueJob(`recharge email for customer ${customer.id}`, async () => {
                    const mailHelper = require('../utils/mailHelper');
                    const { renderTemplate, textToHtml } = require('../utils/templateHelper');
                    const rendered = await renderTemplate(req.ispId, 'EMAIL', 'recharge_success', customerTemplateData, {
                        subject: 'Recharge Successful',
                        body: `Dear ${customerName},\n\nYour recharge was successful.\n\nPackage: ${customerTemplateData.packageName}\nAmount: ${customerTemplateData.amount}\nValid Until: ${customerTemplateData.expiryDate}\n\nThank you,\n${ispName}`
                    }, prisma);
                    await mailHelper.sendMail(req.ispId, {
                        to: customer.lead.email,
                        subject: rendered.subject,
                        html: textToHtml(rendered.body)
                    }, { ignoreNotificationSetting: true });
                });
            }

            if (customer.lead?.phoneNumber) {
                try {
                    console.log('[billing.controller] Dispatching recharge_success SMS', {
                        ispId: req.ispId,
                        customerId: customer.id,
                        phone: customer.lead.phoneNumber,
                        amount: customerTemplateData.amount
                    });
                    const smsHelper = require('../utils/smsHelper');
                    const smsResult = await smsHelper.sendEventSms(req.ispId, 'recharge_success', customerTemplateData);
                    if (!smsResult?.success) {
                        console.warn('[billing.controller] recharge_success SMS was not accepted by provider', {
                            ispId: req.ispId,
                            customerId: customer.id,
                            phone: customer.lead.phoneNumber,
                            result: smsResult
                        });
                    } else {
                        console.log('[billing.controller] recharge_success SMS dispatch finished', {
                            ispId: req.ispId,
                            customerId: customer.id,
                            phone: customer.lead.phoneNumber,
                            result: smsResult
                        });
                    }
                } catch (smsErr) {
                    console.error('Failed to send recharge success SMS:', smsErr.message);
                }
            }
        } catch (notifErr) {
            console.error('Recharge notification dispatch error:', notifErr.message);
        }

        const paidOrder = await prisma.customerOrderManagement.findFirst({
            where: { subscriptionId: newSub.id, isPaid: true },
            orderBy: { id: 'desc' },
            select: { id: true }
        });
        if (paidOrder) await syncPaidOrderAccounting(prisma, req.ispId, paidOrder.id);

        res.json({ success: true, subscription: newSub });
    } catch (err) {
        next(err);
    }
}

/**
 * Generate Manual Invoice
 */
async function generateManualInvoice(req, res, next) {
    const prisma = req.prisma;
    const { customerId, items, description } = req.body; // items: [{itemName, itemPrice}]

    try {
        if (!items || items.length === 0) return res.status(400).json({ error: 'Items required' });

        const customer = await prisma.customer.findFirst({
            where: {
                id: Number(customerId),
                ispId: req.ispId,
                isDeleted: false,
                ...(req.branchId ? { branchId: req.branchId } : {}),
                ...(req.user?.resellerId ? { resellerId: Number(req.user.resellerId) } : {})
            }
        });
        if (!customer) return res.status(404).json({ error: 'Customer not found or access denied' });

        const totalAmount = items.reduce((sum, i) => sum + parseFloat(i.itemPrice || 0), 0);
        
        const newOrder = await prisma.$transaction(async tx => {
            const order = await tx.customerOrderManagement.create({
                data: {
                    customer: { connect: { id: Number(customerId) } },
                    orderDate: new Date(),
                    totalAmount,
                    isPaid: Boolean(req.user?.resellerId),
                    isActive: true,
                    paymentId: req.user?.resellerId ? 'RESELLER_WALLET' : null,
                    items: {
                        create: items.map(i => ({
                            itemName: i.itemName,
                            itemPrice: parseFloat(i.itemPrice)
                        }))
                    }
                },
                include: { items: true }
            });
            await debitResellerWallet(tx, {
                ispId: req.ispId,
                resellerId: req.user?.resellerId,
                amount: totalAmount,
                customerId: customer.id,
                orderId: order.id,
                userId: req.user?.id,
                action: 'MANUAL_INVOICE'
            });
            return order;
        });

        res.json(newOrder);
    } catch (err) {
        next(err);
    }
}

async function getBillingStats(req, res, next) {
    const prisma = req.prisma;
    try {
        const now = new Date();
        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(now.getMonth() - 5);
        sixMonthsAgo.setDate(1);

        const branchFilter = await getBranchFilter(req);
        const customerWhere = {
            ispId: req.ispId,
            ...(branchFilter?.branchId ? { branchId: branchFilter.branchId } : {}),
            ...(req.user?.resellerId ? { resellerId: Number(req.user.resellerId) } : {})
        };
        const customerIds = await prisma.customer.findMany({
            where: customerWhere,
            select: { id: true }
        }).then(customers => customers.map(customer => customer.id));

        const orders = await prisma.customerOrderManagement.findMany({
            where: {
                isPaid: true,
                orderDate: { gte: sixMonthsAgo },
                customerId: { in: customerIds }
            },
            select: {
                totalAmount: true,
                orderDate: true
            }
        });

        // Group by month
        const monthlyStats = {};
        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        
        for (let i = 0; i < 6; i++) {
            const d = new Date();
            d.setMonth(now.getMonth() - i);
            const monthName = months[d.getMonth()];
            monthlyStats[monthName] = { revenue: 0, expenses: 0 }; // We don't have expenses yet, but keeping structure
        }

        orders.forEach(order => {
            const monthName = months[new Date(order.orderDate).getMonth()];
            if (monthlyStats[monthName]) {
                monthlyStats[monthName].revenue += order.totalAmount;
                // Dummy expenses for visualization (e.g., 60% of revenue)
                monthlyStats[monthName].expenses += order.totalAmount * 0.6;
            }
        });

        const formattedStats = Object.keys(monthlyStats).map(month => ({
            month,
            revenue: monthlyStats[month].revenue,
            expenses: monthlyStats[month].expenses
        })).reverse();

        res.json(formattedStats);
    } catch (err) {
        next(err);
    }
}

/**
 * List Invoices (paid/unpaid orders)
 */
async function listInvoices(req, res, next) {
    const prisma = req.prisma;
    try {
        const branchFilter = await getBranchFilter(req);
        const { search, status, page = 1, limit = 10 } = req.query;
        const skip = (Number(page) - 1) * Number(limit);

        const where = {
            isDeleted: false,
            customer: {
                ispId: req.ispId,
                ...branchFilter,
                ...(req.user?.resellerId ? { resellerId: Number(req.user.resellerId) } : {})
            }
        };

        if (status === 'paid') {
            where.isPaid = true;
        } else if (status === 'pending') {
            where.isPaid = false;
            where.packageEnd = { gte: new Date() };
        } else if (status === 'overdue') {
            where.isPaid = false;
            where.packageEnd = { lt: new Date() };
        }

        if (search) {
            const normalizedSearch = String(search).trim();
            const invoiceNumber = normalizedSearch.match(/^INV-0*(\d+)$/i)?.[1];
            where.OR = [
                { invoiceId: { contains: normalizedSearch } },
                ...(invoiceNumber ? [
                    { invoiceId: { contains: invoiceNumber } },
                    { id: Number(invoiceNumber) }
                ] : []),
                { customer: { lead: { firstName: { contains: search } } } },
                { customer: { lead: { lastName: { contains: search } } } },
                { customer: { customerUniqueId: { contains: normalizedSearch } } },
                { packagePrice: { packageName: { contains: normalizedSearch } } }
            ];
        }

        const [orders, total] = await Promise.all([
            prisma.customerOrderManagement.findMany({
                where,
                include: {
                    customer: {
                        include: {
                            lead: {
                                select: {
                                    firstName: true,
                                    lastName: true,
                                    email: true,
                                    phoneNumber: true
                                }
                            }
                        }
                    },
                    items: true,
                    packagePrice: {
                        include: {
                            packagePlanDetails: true,
                            oneTimeCharges: {
                                where: { isDeleted: false },
                                orderBy: { id: 'asc' }
                            }
                        }
                    }
                },
                orderBy: { orderDate: 'desc' },
                skip,
                take: Number(limit)
            }),
            prisma.customerOrderManagement.count({ where })
        ]);
        const paymentMethodIds = [...new Set(orders.map(order => order.paymentMethodId).filter(Boolean))];
        const paymentMethods = paymentMethodIds.length
            ? await prisma.billingPaymentMethod.findMany({ where: { id: { in: paymentMethodIds }, ispId: req.ispId }, select: { id: true, name: true, code: true } })
            : [];
        const paymentMethodById = new Map(paymentMethods.map(method => [method.id, method]));

        // Package creation currently persists add-on links through the explicit
        // join model (A = package id, B = add-on id). Prisma's implicit relation
        // does not resolve those legacy rows, so load the same relation used by
        // the package-creation list and merge it into the invoice response.
        const packageIds = [...new Set(orders.map(order => order.package).filter(Boolean))];
        const legacyPackageLinks = packageIds.length
            ? await prisma.packageonetimecharges.findMany({ where: { A: { in: packageIds } } })
            : [];
        const legacyChargeIds = [...new Set(legacyPackageLinks.map(link => link.B))];
        const legacyCharges = legacyChargeIds.length
            ? await prisma.OneTimeCharge.findMany({
                where: { id: { in: legacyChargeIds }, isDeleted: false },
                orderBy: { id: 'asc' }
            })
            : [];
        const legacyChargeById = new Map(legacyCharges.map(charge => [charge.id, charge]));
        const legacyChargesByPackage = new Map();
        for (const link of legacyPackageLinks) {
            const charge = legacyChargeById.get(link.B);
            if (!charge) continue;
            const current = legacyChargesByPackage.get(link.A) || [];
            current.push(charge);
            legacyChargesByPackage.set(link.A, current);
        }

        // An add-on applies to the first package invoice regardless of isRenewal;
        // subsequent invoices only include add-ons explicitly marked for renewal.
        // Resolve this from order history instead of the customer's current
        // isRechargeable flag, which no longer describes historical invoices.
        const orderPackagePairs = orders
            .filter(order => order.package)
            .map(order => ({ customerId: order.customerId, package: order.package }));
        const firstOrders = orderPackagePairs.length
            ? await prisma.customerOrderManagement.groupBy({
                by: ['customerId', 'package'],
                where: {
                    isDeleted: false,
                    totalAmount: { gt: 0 },
                    OR: orderPackagePairs
                },
                _min: { id: true }
            })
            : [];
        const firstOrderIdByPackage = new Map(
            firstOrders.map(row => [`${row.customerId}:${row.package}`, row._min.id])
        );

        const orderIdsStr = orders.map(order => String(order.id));
        const esewaPayments = await prisma.eSewaTokenPayment.findMany({
            where: {
                orderId: { in: orderIdsStr },
                status: 'COMPLETED'
            },
            select: {
                orderId: true,
                eSewaTransactionCode: true,
                referenceCode: true
            }
        });
        const esewaPaymentByOrderId = new Map(esewaPayments.map(p => [p.orderId, p]));

        const accountingInvoices = await fetchAccountingInvoices(prisma, req.ispId, orders);
        const formattedInvoices = orders.map(order => {
            const esewaPayment = esewaPaymentByOrderId.get(String(order.id)) || null;
            const accountingInvoice = accountingInvoices.get(order.id) || null;
            const customerName = order.customer?.lead 
                ? `${order.customer.lead.firstName} ${order.customer.lead.lastName || ''}`.trim()
                : 'Unknown';

            const customerAddress = order.customer
                ? [order.customer.street, order.customer.district, order.customer.state].filter(Boolean).join(', ')
                : '';

            const firstOrderId = firstOrderIdByPackage.get(`${order.customerId}:${order.package}`);
            const isTrialInvoice = Number(order.totalAmount || 0) === 0;
            const isRenewalInvoice = !isTrialInvoice && Boolean(firstOrderId && order.id !== firstOrderId);
            const configuredAddons = legacyChargesByPackage.get(order.package)
                || order.packagePrice?.oneTimeCharges
                || [];
            const customPrices = order.packagePrice?.addonPricesJson ? JSON.parse(order.packagePrice.addonPricesJson) : {};
            const packageItems = isTrialInvoice
                ? []
                : configuredAddons.filter(item => !isRenewalInvoice || item.isRenewal).map(charge => ({
                    ...charge,
                    amount: customPrices[String(charge.id)] !== undefined ? customPrices[String(charge.id)] : charge.amount
                }));

            return {
                id: order.id,
                invoiceId: order.invoiceId || `INV-${order.id.toString().padStart(4, '0')}`,
                customer: customerName,
                customerEmail: order.customer?.lead?.email || '',
                customerPhone: order.customer?.lead?.phoneNumber || '',
                customerId: order.customer?.customerUniqueId || `CUST-${order.customer?.id}`,
                customerAddress: customerAddress,
                customerPan: order.customer?.panNo || '',
                date: order.orderDate,
                dueDate: order.packageEnd,
                packageStart: formatADDate(order.packageStart),
                packageEnd: formatADDate(order.packageEnd),
                amount: order.totalAmount,
                status: order.isPaid ? 'paid' : (new Date(order.packageEnd) < new Date() ? 'overdue' : 'pending'),
                packageName: order.packagePrice?.packageName || 'Package Renewal',
                planName: order.packagePrice?.packagePlanDetails?.planName || 'Package Plan',
                downSpeed: order.packagePrice?.packagePlanDetails?.downSpeed || null,
                upSpeed: order.packagePrice?.packagePlanDetails?.upSpeed || null,
                packageDuration: order.packagePrice?.packageDuration || '',
                isTscApplicable: order.packagePrice?.isTscApplicable || false,
                paymentMethod: order.isPaid ? (paymentMethodById.get(order.paymentMethodId)?.name || order.paymentId || 'Payment') : null,
                paymentMethodId: order.paymentMethodId || null,
                paymentTransactionCode: esewaPayment ? (esewaPayment.eSewaTransactionCode || esewaPayment.referenceCode) : null,
                paymentReferenceCode: esewaPayment ? esewaPayment.referenceCode : null,
                accountingProvider: order.accountingProvider || null,
                accountingInvoiceId: order.accountingInvoiceId || null,
                accountingInvoiceUrl: order.accountingInvoiceUrl || accountingInvoice?.InvoicePrintUrl || accountingInvoice?.invoicePrintUrl || null,
                accountingSyncError: order.accountingSyncError || null,
                accountingInvoice,
                items: order.items,
                isRenewalInvoice,
                isTrialInvoice,
                packageItems,
                packagePrice: order.packagePrice
            };
        });

        res.json({
            success: true,
            invoices: formattedInvoices,
            total,
            pagination: {
                page: Number(page),
                limit: Number(limit),
                total,
                totalPages: Math.ceil(total / Number(limit))
            }
        });
    } catch (err) {
        next(err);
    }
}

async function syncInvoiceToAccounting(req, res, next) {
    try {
        const order = await req.prisma.customerOrderManagement.findFirst({
            where: {
                id: Number(req.params.id),
                isDeleted: false,
                isPaid: true,
                totalAmount: { gt: 0 },
                customer: { ispId: req.ispId, ...(req.branchId ? { branchId: req.branchId } : {}) }
            }
        });
        if (!order) return res.status(404).json({ error: 'Paid non-trial invoice not found' });

        if (order.accountingInvoiceId) {
            return res.status(400).json({ error: 'Sales invoice has already been generated/synchronized for this order.' });
        }

        const accountingInvoice = await syncOrderToAccounting(req.prisma, req.ispId, order.id);
        const updated = await req.prisma.customerOrderManagement.findUnique({ where: { id: order.id } });
        return res.json({ success: true, accountingInvoice, order: updated });
    } catch (err) {
        next(err);
    }
}

/**
 * Get Invoice Summary statistics
 */
async function getInvoiceSummary(req, res, next) {
    const prisma = req.prisma;
    try {
        const branchFilter = await getBranchFilter(req);

        const where = {
            isDeleted: false,
            customer: {
                ispId: req.ispId,
                ...branchFilter,
                ...(req.user?.resellerId ? { resellerId: Number(req.user.resellerId) } : {})
            }
        };

        const orders = await prisma.customerOrderManagement.findMany({
            where,
            select: {
                isPaid: true,
                totalAmount: true,
                packageEnd: true
            }
        });

        let totalRevenue = 0;
        let pendingAmount = 0;
        let overdueAmount = 0;
        let paidAmount = 0;

        let pendingCount = 0;
        let overdueCount = 0;
        let paidCount = 0;

        const now = new Date();

        orders.forEach(order => {
            if (order.isPaid) {
                totalRevenue += order.totalAmount;
                paidAmount += order.totalAmount;
                paidCount++;
            } else {
                if (new Date(order.packageEnd) < now) {
                    overdueAmount += order.totalAmount;
                    overdueCount++;
                } else {
                    pendingAmount += order.totalAmount;
                    pendingCount++;
                }
            }
        });

        res.json({
            success: true,
            summary: {
                totalRevenue: {
                    value: totalRevenue,
                    count: paidCount
                },
                pending: {
                    value: pendingAmount,
                    count: pendingCount
                },
                overdue: {
                    value: overdueAmount,
                    count: overdueCount
                },
                paid: {
                    value: paidAmount,
                    count: paidCount
                }
            }
        });
    } catch (err) {
        next(err);
    }
}

/**
 * List Invoice Ranges
 */
async function listInvoiceRanges(req, res, next) {
    const prisma = req.prisma;
    try {
        if (req.user?.resellerId) {
            return res.json({ success: true, ranges: [] });
        }
        const branches = await prisma.branch.findMany({ where: { ispId: req.ispId, isDeleted: false }, select: { id: true } });
        const ranges = await prisma.branchInvoiceRange.findMany({
            where: { branchId: { in: branches.map(branch => branch.id) } },
            orderBy: { createdAt: 'desc' }
        });

        res.json({
            success: true,
            ranges
        });
    } catch (err) {
        next(err);
    }
}

/**
 * Create/Allocate a new invoice range for a branch
 */
async function createInvoiceRange(req, res, next) {
    const prisma = req.prisma;
    const { branchId, rangeStart, rangeEnd, fiscalYearId } = req.body;

    try {
        if (!branchId || !rangeStart || !rangeEnd || !fiscalYearId) {
            return res.status(400).json({ error: 'branchId, fiscalYearId, rangeStart, and rangeEnd are required' });
        }

        const fiscalYear = await prisma.fiscalYear.findFirst({ where: { id: Number(fiscalYearId), ispId: req.ispId } });
        if (!fiscalYear) return res.status(400).json({ error: 'Invalid fiscal year' });

        const start = Number(rangeStart);
        const end = Number(rangeEnd);

        if (isNaN(start) || isNaN(end) || start > end) {
            return res.status(400).json({ error: 'Invalid range bounds' });
        }

        // Check if there is an overlapping range for this branch
        const overlapping = await prisma.branchInvoiceRange.findFirst({
            where: {
                branchId: Number(branchId),
                fiscalYearId: Number(fiscalYearId),
                isActive: true,
                OR: [
                    { rangeStart: { lte: start }, rangeEnd: { gte: start } },
                    { rangeStart: { lte: end }, rangeEnd: { gte: end } },
                    { rangeStart: { gte: start }, rangeEnd: { lte: end } }
                ]
            }
        });

        if (overlapping) {
            return res.status(400).json({ error: 'Range overlaps with an existing active range for this branch' });
        }

        const newRange = await prisma.branchInvoiceRange.create({
            data: {
                branchId: Number(branchId),
                fiscalYearId: Number(fiscalYearId),
                rangeStart: start,
                rangeEnd: end,
                current: start,
                isActive: true,
                updatedAt: new Date()
            }
        });

        res.status(201).json(newRange);
    } catch (err) {
        next(err);
    }
}

/**
 * Toggle an invoice range status (active/inactive)
 */
async function toggleInvoiceRange(req, res, next) {
    const prisma = req.prisma;
    const { id } = req.params;
    const { isActive } = req.body;

    try {
        const updated = await prisma.branchInvoiceRange.update({
            where: { id: Number(id) },
            data: {
                isActive: !!isActive,
                updatedAt: new Date()
            }
        });

        res.json(updated);
    } catch (err) {
        next(err);
    }
}

/**
 * Delete an invoice range
 */
async function deleteInvoiceRange(req, res, next) {
    const prisma = req.prisma;
    const { id } = req.params;

    try {
        await prisma.branchInvoiceRange.delete({
            where: { id: Number(id) }
        });

        res.json({ success: true, message: 'Invoice range deleted successfully' });
    } catch (err) {
        next(err);
    }
}

async function listFiscalYears(req, res, next) {
    try {
        const now = new Date();
        const rows = await req.prisma.fiscalYear.findMany({ where: { ispId: req.ispId }, orderBy: { startDate: 'desc' } });
        res.json(rows.map(row => ({ ...row, isActive: row.isEnabled && row.startDate <= now && row.endDate >= now })));
    } catch (err) { next(err); }
}

async function createFiscalYear(req, res, next) {
    try {
        const { name, startDate, endDate, isEnabled = true } = req.body;
        const start = new Date(startDate); const end = new Date(endDate);
        if (!name || isNaN(start.getTime()) || isNaN(end.getTime()) || start >= end) return res.status(400).json({ error: 'Valid name, start date and end date are required' });
        const overlap = await req.prisma.fiscalYear.findFirst({ where: { ispId: req.ispId, isEnabled: true, startDate: { lte: end }, endDate: { gte: start } } });
        if (overlap) return res.status(400).json({ error: `Fiscal year overlaps ${overlap.name}` });
        res.status(201).json(await req.prisma.fiscalYear.create({ data: { ispId: req.ispId, name: String(name).trim(), startDate: start, endDate: end, isEnabled: Boolean(isEnabled) } }));
    } catch (err) { next(err); }
}

async function updateFiscalYear(req, res, next) {
    try {
        const current = await req.prisma.fiscalYear.findFirst({ where: { id: Number(req.params.id), ispId: req.ispId } });
        if (!current) return res.status(404).json({ error: 'Fiscal year not found' });
        const start = req.body.startDate ? new Date(req.body.startDate) : current.startDate;
        const end = req.body.endDate ? new Date(req.body.endDate) : current.endDate;
        if (start >= end) return res.status(400).json({ error: 'End date must be after start date' });
        res.json(await req.prisma.fiscalYear.update({ where: { id: current.id }, data: { name: req.body.name, startDate: start, endDate: end, isEnabled: req.body.isEnabled } }));
    } catch (err) { next(err); }
}

async function listPaymentMethods(req, res, next) {
    try { res.json(await req.prisma.billingPaymentMethod.findMany({ where: { ispId: req.ispId, ...(req.query.enabled === 'true' ? { isEnabled: true } : {}) }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] })); } catch (err) { next(err); }
}

async function savePaymentMethod(req, res, next) {
    try {
        const { name, code, description, isEnabled = true, isDefault = false } = req.body;
        if (!name || !code) return res.status(400).json({ error: 'Name and code are required' });
        if (isDefault) await req.prisma.billingPaymentMethod.updateMany({ where: { ispId: req.ispId }, data: { isDefault: false } });
        const data = { name: String(name).trim(), code: String(code).trim().toUpperCase(), description: description || null, isEnabled: Boolean(isEnabled), isDefault: Boolean(isDefault) };
        const existing = req.params.id ? await req.prisma.billingPaymentMethod.findFirst({ where: { id: Number(req.params.id), ispId: req.ispId } }) : null;
        if (req.params.id && !existing) return res.status(404).json({ error: 'Payment method not found' });
        const row = req.params.id
            ? await req.prisma.billingPaymentMethod.update({ where: { id: existing.id }, data })
            : await req.prisma.billingPaymentMethod.create({ data: { ...data, ispId: req.ispId } });
        res.status(req.params.id ? 200 : 201).json(row);
    } catch (err) { next(err); }
}

async function updatePaymentMode(req, res, next) {
    const prisma = req.prisma;
    const { orderId, paymentMethodId, paymentMethod } = req.body;

    try {
        const order = await prisma.customerOrderManagement.findFirst({
            where: {
                id: Number(orderId),
                isPaid: true,
                isDeleted: false,
                customer: {
                    ispId: req.ispId,
                    ...(req.branchId ? { branchId: req.branchId } : {})
                }
            }
        });

        if (!order) return res.status(404).json({ error: 'Paid invoice not found' });
        
        const paymentMethodRecord = paymentMethodId 
            ? await prisma.billingPaymentMethod.findFirst({ where: { id: Number(paymentMethodId), ispId: req.ispId, isEnabled: true } })
            : null;

        if (paymentMethodId && !paymentMethodRecord) {
            return res.status(400).json({ error: 'Select a valid enabled payment method' });
        }

        const updated = await prisma.customerOrderManagement.update({
            where: { id: order.id },
            data: {
                paymentId: paymentMethodRecord ? paymentMethodRecord.code : (paymentMethod || 'CASH'),
                paymentMethodId: paymentMethodRecord ? paymentMethodRecord.id : null,
                updatedAt: new Date()
            }
        });

        res.json({ success: true, order: updated });
    } catch (err) {
        next(err);
    }
}

module.exports = {
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
    deleteInvoiceRange
    ,listFiscalYears
    ,createFiscalYear
    ,updateFiscalYear
    ,listPaymentMethods
    ,savePaymentMethod
    ,syncInvoiceToAccounting
};
