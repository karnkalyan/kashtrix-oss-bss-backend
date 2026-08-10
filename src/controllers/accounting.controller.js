// src/controllers/accounting.controller.js
const crypto = require('crypto');

// --- BILLING ACCOUNTS ---
async function listBillingAccounts(req, res, next) {
    try {
        const ispId = Number(req.ispId);
        const accounts = await req.prisma.billingAccount.findMany({
            where: { ispId, isActive: true, ...(req.branchId ? { branchId: req.branchId } : {}) },
            orderBy: { createdAt: 'desc' }
        });
        return res.json({ success: true, data: accounts });
    } catch (err) {
        return next(err);
    }
}

async function createBillingAccount(req, res, next) {
    try {
        const ispId = Number(req.ispId);
        const { name, type, accountNo, initialBalance = 0, openingBalance = initialBalance, branchId, notes, allowNegative = false } = req.body;
        const requestedBranchId = branchId ? Number(branchId) : null;
        if (req.branchId && requestedBranchId && requestedBranchId !== Number(req.branchId)) {
            return res.status(403).json({ success: false, error: 'Cannot create an account for another branch' });
        }
        const effectiveBranchId = req.branchId ? Number(req.branchId) : requestedBranchId;

        if (!name || !type) {
            return res.status(400).json({ success: false, error: 'Name and type are required' });
        }

        const opening = Number(openingBalance);
        if (!Number.isFinite(opening) || opening < 0) {
            return res.status(400).json({ success: false, error: 'Opening balance must be zero or greater' });
        }
        const account = await req.prisma.$transaction(async (tx) => {
            const created = await tx.billingAccount.create({ data: {
                name,
                type,
                accountNo: accountNo || null,
                openingBalance: opening.toFixed(2),
                balance: opening.toFixed(2),
                allowNegative: Boolean(allowNegative),
                notes: notes || null,
                createdById: req.user?.id || null,
                updatedById: req.user?.id || null,
                ispId,
                branchId: effectiveBranchId
            } });
            if (opening > 0) await tx.accountingLedgerEntry.create({ data: {
                ispId, billingAccountId: created.id, direction: 'CREDIT', amount: opening.toFixed(2),
                balanceAfter: opening.toFixed(2), sourceType: 'OPENING_BALANCE',
                reference: `OPENING-${created.id}`, description: 'Audited opening balance', createdById: req.user?.id || null,
            } });
            return created;
        });
        return res.status(201).json({ success: true, data: account });
    } catch (err) {
        return next(err);
    }
}

async function updateBillingAccount(req, res, next) {
    try {
        const id = Number(req.params.id);
        const { name, type, accountNo, isActive, balance, notes, allowNegative } = req.body;
        if (balance !== undefined || req.body.openingBalance !== undefined) {
            return res.status(400).json({ success: false, error: 'Balances cannot be edited directly; create an audited adjustment or transfer' });
        }
        const existing = await req.prisma.billingAccount.findFirst({
            where: { id, ispId: Number(req.ispId), ...(req.branchId ? { branchId: Number(req.branchId) } : {}) }
        });
        if (!existing) return res.status(404).json({ success: false, error: 'Billing account not found' });

        const updated = await req.prisma.billingAccount.update({
            where: { id },
            data: {
                ...(name && { name }),
                ...(type && { type }),
                ...(accountNo !== undefined && { accountNo }),
                ...(isActive !== undefined && { isActive }),
                ...(notes !== undefined && { notes }),
                ...(allowNegative !== undefined && { allowNegative: Boolean(allowNegative) }),
                updatedById: req.user?.id || null
            }
        });
        return res.json({ success: true, data: updated });
    } catch (err) {
        return next(err);
    }
}

// --- ACCOUNTING CATEGORIES ---
async function listCategories(req, res, next) {
    try {
        const ispId = Number(req.ispId);
        const { type } = req.query;
        const where = { ispId, isActive: true };
        if (type && type !== 'all') where.type = type;

        const categories = await req.prisma.accountingCategory.findMany({
            where,
            orderBy: { name: 'asc' }
        });
        return res.json({ success: true, data: categories });
    } catch (err) {
        return next(err);
    }
}

async function createCategory(req, res, next) {
    try {
        const ispId = Number(req.ispId);
        const { name, type, description } = req.body;
        if (!name || !type) {
            return res.status(400).json({ success: false, error: 'Name and type (SALE/PURCHASE/EXPENSE) are required' });
        }

        const category = await req.prisma.accountingCategory.create({
            data: { name, type, description: description || null, ispId }
        });
        return res.status(201).json({ success: true, data: category });
    } catch (err) {
        return next(err);
    }
}

// --- ACCOUNTING ITEMS ---
async function listItems(req, res, next) {
    try {
        const ispId = Number(req.ispId);
        const items = await req.prisma.accountingItem.findMany({
            where: { ispId, isActive: true },
            orderBy: { name: 'asc' }
        });
        return res.json({ success: true, data: items });
    } catch (err) {
        return next(err);
    }
}

async function createItem(req, res, next) {
    try {
        const ispId = Number(req.ispId);
        const { name, description, unitPrice = 0, unit = 'pcs', sku } = req.body;
        if (!name) {
            return res.status(400).json({ success: false, error: 'Item name is required' });
        }

        const item = await req.prisma.accountingItem.create({
            data: {
                name,
                description: description || null,
                unitPrice: Number(unitPrice),
                unit,
                sku: sku || null,
                ispId
            }
        });
        return res.status(201).json({ success: true, data: item });
    } catch (err) {
        return next(err);
    }
}

// --- SALES ---
async function listSales(req, res, next) {
    try {
        const ispId = Number(req.ispId);
        const { status, categoryId, billingAccountId, startDate, endDate, page = 1, limit = 20 } = req.query;

        const where = { ispId, ...(req.branchId ? { branchId: req.branchId } : {}) };
        if (status && status !== 'all') where.status = status;
        if (categoryId) where.categoryId = Number(categoryId);
        if (billingAccountId) where.billingAccountId = Number(billingAccountId);

        if (startDate || endDate) {
            where.saleDate = {};
            if (startDate) where.saleDate.gte = new Date(startDate);
            if (endDate) where.saleDate.lte = new Date(endDate);
        }

        const skip = (Number(page) - 1) * Number(limit);
        const take = Number(limit);

        const [sales, total] = await Promise.all([
            req.prisma.sale.findMany({
                where,
                skip,
                take,
                orderBy: { saleDate: 'desc' },
                include: {
                    category: true,
                    billingAccount: true,
                    items: { include: { item: true } }
                }
            }),
            req.prisma.sale.count({ where })
        ]);

        return res.json({
            success: true,
            data: sales,
            pagination: { total, page: Number(page), limit: Number(limit), totalPages: Math.ceil(total / Number(limit)) }
        });
    } catch (err) {
        return next(err);
    }
}

async function createSale(req, res, next) {
    try {
        const ispId = Number(req.ispId);
        const {
            customerId,
            customerName,
            categoryId,
            billingAccountId,
            items = [],
            discountAmount = 0,
            discountPercent,
            taxAmount = 0,
            taxPercent,
            paidAmount = 0,
            notes,
            dueDate
        } = req.body;

        // Auto-detect subscription package if customer is selected and no manual items provided
        let saleItems = items;
        let cName = customerName;

        if (customerId) {
            const cust = await req.prisma.customer.findFirst({
                where: { id: Number(customerId), ispId, isDeleted: false, ...(req.branchId ? { branchId: req.branchId } : {}) },
                include: {
                    subscribedPkg: { include: { packagePlanDetails: true } },
                    lead: true
                }
            });
            if (cust) {
                cName = cust.lead?.name || `Customer #${cust.id}`;
                if (saleItems.length === 0 && cust.subscribedPkg) {
                    saleItems = [{
                        description: `Subscription: ${cust.subscribedPkg.packagePlanDetails?.name || 'Package'}`,
                        quantity: 1,
                        unitPrice: cust.subscribedPkg.price || 0,
                        total: cust.subscribedPkg.price || 0
                    }];
                }
            }
        }

        const subtotal = saleItems.reduce((sum, item) => sum + (Number(item.quantity || 1) * Number(item.unitPrice || 0)), 0);
        const disc = Number(discountAmount) || (discountPercent ? (subtotal * Number(discountPercent) / 100) : 0);
        const tax = Number(taxAmount) || (taxPercent ? ((subtotal - disc) * Number(taxPercent) / 100) : 0);
        const totalAmount = subtotal - disc + tax;
        const paid = Number(paidAmount);
        const dueAmount = totalAmount - paid;

        let status = 'PENDING';
        if (paid >= totalAmount && totalAmount > 0) status = 'PAID';
        else if (paid > 0) status = 'PARTIAL';

        const invoiceNumber = `INV-${Date.now().toString().slice(-6)}`;

        const sale = await req.prisma.$transaction(async (tx) => {
            // Process sale items and auto-create any new dynamic items
            const processedItems = [];
            for (const item of saleItems) {
                let itemId = item.itemId ? Number(item.itemId) : null;
                if (!itemId && item.createNew && item.description) {
                    const newItem = await tx.accountingItem.create({
                        data: {
                            name: item.description,
                            unitPrice: Number(item.unitPrice || 0),
                            ispId,
                            unit: item.unit || 'pcs'
                        }
                    });
                    itemId = newItem.id;
                }

                const qty = Number(item.quantity || 1);
                const price = Number(item.unitPrice || 0);
                const itemDisc = Number(item.discount || 0);
                const itemTax = Number(item.tax || 0);
                const itemTotal = Number(item.total || ((qty * price) - itemDisc + itemTax));

                processedItems.push({
                    itemId,
                    description: item.description || 'Sale Item',
                    quantity: qty,
                    unitPrice: price,
                    discount: itemDisc,
                    tax: itemTax,
                    total: itemTotal
                });
            }

            const createdSale = await tx.sale.create({
                data: {
                    invoiceNumber,
                    customerId: customerId ? Number(customerId) : null,
                    customerName: cName || 'Walk-in Customer',
                    categoryId: categoryId ? Number(categoryId) : null,
                    billingAccountId: billingAccountId ? Number(billingAccountId) : null,
                    subtotal,
                    discountAmount: disc,
                    discountPercent: discountPercent ? Number(discountPercent) : null,
                    taxAmount: tax,
                    taxPercent: taxPercent ? Number(taxPercent) : null,
                    totalAmount,
                    paidAmount: paid,
                    dueAmount,
                    status,
                    notes: notes || null,
                    dueDate: dueDate ? new Date(dueDate) : null,
                    ispId,
                    branchId: req.branchId || null,
                    createdById: req.user?.id || null,
                    items: {
                        create: processedItems
                    }
                },
                include: { items: { include: { item: true } } }
            });

            // Update Billing Account Balance if paid amount > 0
            if (paid > 0 && billingAccountId) {
                const changed = await tx.billingAccount.updateMany({
                    where: { id: Number(billingAccountId), ispId, isActive: true },
                    data: { balance: { increment: paid.toFixed(2) } }
                });
                if (changed.count !== 1) throw Object.assign(new Error('Receiving billing account is invalid or inactive'), { status: 404 });
                const account = await tx.billingAccount.findUnique({ where: { id: Number(billingAccountId) } });
                await tx.accountingLedgerEntry.create({ data: {
                    ispId, billingAccountId: account.id, direction: 'CREDIT', amount: paid.toFixed(2),
                    balanceAfter: account.balance, sourceType: 'SALE', sourceId: createdSale.id,
                    reference: invoiceNumber, description: `Payment received for ${invoiceNumber}`, createdById: req.user?.id || null,
                } });
            }

            // Sync/Create invoice record in CustomerOrderManagement if customerId exists
            if (customerId) {
                const sub = await tx.customerSubscription.findFirst({
                    where: { customerId: Number(customerId), isDeleted: false }
                });
                if (sub) {
                    const createdOrder = await tx.customerOrderManagement.create({
                        data: {
                            customerId: Number(customerId),
                            subscriptionId: sub.id,
                            package: sub.packagePriceId,
                            orderDate: new Date(),
                            packageStart: sub.startDate || new Date(),
                            packageEnd: sub.endDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
                            totalAmount,
                            isPaid: status === 'PAID',
                            invoiceId: invoiceNumber,
                            paymentId: billingAccountId ? `ACCT-${billingAccountId}` : 'CASH',
                            items: {
                                create: processedItems.map(i => ({
                                    itemName: i.description,
                                    itemPrice: i.total
                                }))
                            }
                        }
                    }).catch(err => console.error('Error auto-creating order invoice:', err.message));
                }
            }

            return createdSale;
        });

        return res.status(201).json({ success: true, data: sale });
    } catch (err) {
        return next(err);
    }
}

// --- PURCHASES ---
async function listPurchases(req, res, next) {
    try {
        const ispId = Number(req.ispId);
        const { vendorId, categoryId, startDate, endDate, page = 1, limit = 20 } = req.query;

        const where = { ispId, ...(req.branchId ? { branchId: req.branchId } : {}) };
        if (vendorId) where.vendorId = Number(vendorId);
        if (categoryId) where.categoryId = Number(categoryId);

        if (startDate || endDate) {
            where.purchaseDate = {};
            if (startDate) where.purchaseDate.gte = new Date(startDate);
            if (endDate) where.purchaseDate.lte = new Date(endDate);
        }

        const skip = (Number(page) - 1) * Number(limit);
        const take = Number(limit);

        const [purchases, total] = await Promise.all([
            req.prisma.purchase.findMany({
                where,
                skip,
                take,
                orderBy: { purchaseDate: 'desc' },
                include: {
                    category: true,
                    billingAccount: true,
                    items: { include: { item: true } }
                }
            }),
            req.prisma.purchase.count({ where })
        ]);

        return res.json({
            success: true,
            data: purchases,
            pagination: { total, page: Number(page), limit: Number(limit), totalPages: Math.ceil(total / Number(limit)) }
        });
    } catch (err) {
        return next(err);
    }
}

async function createPurchase(req, res, next) {
    try {
        const ispId = Number(req.ispId);
        const {
            vendorId,
            vendorName,
            categoryId,
            billingAccountId,
            items = [],
            taxAmount = 0,
            paidAmount = 0,
            notes
        } = req.body;

        const subtotal = items.reduce((sum, i) => sum + (Number(i.quantity || 1) * Number(i.unitPrice || 0)), 0);
        const tax = Number(taxAmount);
        const totalAmount = subtotal + tax;
        const paid = Number(paidAmount);

        let status = 'PENDING';
        if (paid >= totalAmount && totalAmount > 0) status = 'PAID';
        else if (paid > 0) status = 'PARTIAL';

        const purchase = await req.prisma.$transaction(async (tx) => {
            const createdPurchase = await tx.purchase.create({
                data: {
                    vendorId: vendorId ? Number(vendorId) : null,
                    vendorName: vendorName || 'Vendor',
                    categoryId: categoryId ? Number(categoryId) : null,
                    billingAccountId: billingAccountId ? Number(billingAccountId) : null,
                    subtotal,
                    taxAmount: tax,
                    totalAmount,
                    paidAmount: paid,
                    dueAmount: Math.max(0, totalAmount - paid),
                    status,
                    notes: notes || null,
                    ispId,
                    branchId: req.branchId || null,
                    createdById: req.user?.id || null,
                    items: {
                        create: items.map(i => ({
                            itemId: i.itemId ? Number(i.itemId) : null,
                            description: i.description || 'Purchase Item',
                            quantity: Number(i.quantity || 1),
                            unitPrice: Number(i.unitPrice || 0),
                            total: Number(i.total || (Number(i.quantity || 1) * Number(i.unitPrice || 0)))
                        }))
                    }
                },
                include: { items: true }
            });

            // Deduct paid amount from Billing Account
            if (paid > 0 && billingAccountId) {
                const changed = await tx.billingAccount.updateMany({
                    where: { id: Number(billingAccountId), ispId, isActive: true, OR: [{ allowNegative: true }, { balance: { gte: paid.toFixed(2) } }] },
                    data: { balance: { decrement: paid.toFixed(2) } }
                });
                if (changed.count !== 1) throw Object.assign(new Error('Paying billing account is invalid or has insufficient balance'), { status: 409 });
                const account = await tx.billingAccount.findUnique({ where: { id: Number(billingAccountId) } });
                await tx.accountingLedgerEntry.create({ data: {
                    ispId, billingAccountId: account.id, direction: 'DEBIT', amount: paid.toFixed(2),
                    balanceAfter: account.balance, sourceType: 'PURCHASE', sourceId: createdPurchase.id,
                    reference: `PURCHASE-${createdPurchase.id}`, description: `Vendor payment for purchase ${createdPurchase.id}`, createdById: req.user?.id || null,
                } });
            }

            return createdPurchase;
        });

        return res.status(201).json({ success: true, data: purchase });
    } catch (err) {
        return next(err);
    }
}

// --- EXPENSES ---
async function listExpenses(req, res, next) {
    try {
        const ispId = Number(req.ispId);
        const { categoryId, billingAccountId, startDate, endDate, page = 1, limit = 20 } = req.query;

        const where = { ispId, ...(req.branchId ? { branchId: req.branchId } : {}) };
        if (categoryId) where.categoryId = Number(categoryId);
        if (billingAccountId) where.billingAccountId = Number(billingAccountId);

        if (startDate || endDate) {
            where.expenseDate = {};
            if (startDate) where.expenseDate.gte = new Date(startDate);
            if (endDate) where.expenseDate.lte = new Date(endDate);
        }

        const skip = (Number(page) - 1) * Number(limit);
        const take = Number(limit);

        const [expenses, total] = await Promise.all([
            req.prisma.expense.findMany({
                where,
                skip,
                take,
                orderBy: { expenseDate: 'desc' },
                include: {
                    category: true,
                    billingAccount: true,
                    items: { include: { item: true } }
                }
            }),
            req.prisma.expense.count({ where })
        ]);

        return res.json({
            success: true,
            data: expenses,
            pagination: { total, page: Number(page), limit: Number(limit), totalPages: Math.ceil(total / Number(limit)) }
        });
    } catch (err) {
        return next(err);
    }
}

async function createExpense(req, res, next) {
    try {
        const ispId = Number(req.ispId);
        const {
            categoryId,
            billingAccountId,
            vendorId,
            description,
            amount = 0,
            taxAmount = 0,
            items = []
        } = req.body;

        const numAmount = Number(amount);
        const tax = Number(taxAmount);
        const totalAmount = numAmount + tax;

        const expense = await req.prisma.$transaction(async (tx) => {
            const createdExpense = await tx.expense.create({
                data: {
                    categoryId: categoryId ? Number(categoryId) : null,
                    billingAccountId: billingAccountId ? Number(billingAccountId) : null,
                    vendorId: vendorId ? Number(vendorId) : null,
                    description: description || 'Daily Expense',
                    amount: numAmount,
                    taxAmount: tax,
                    totalAmount,
                    ispId,
                    branchId: req.branchId || null,
                    createdById: req.user?.id || null,
                    ...(items.length > 0 && {
                        items: {
                            create: items.map(i => ({
                                itemId: i.itemId ? Number(i.itemId) : null,
                                description: i.description || 'Expense Item',
                                quantity: Number(i.quantity || 1),
                                unitPrice: Number(i.unitPrice || 0),
                                total: Number(i.total || (Number(i.quantity || 1) * Number(i.unitPrice || 0)))
                            }))
                        }
                    })
                },
                include: { items: true }
            });

            // Deduct total expense from Billing Account
            if (billingAccountId && totalAmount > 0) {
                const changed = await tx.billingAccount.updateMany({
                    where: { id: Number(billingAccountId), ispId, isActive: true, OR: [{ allowNegative: true }, { balance: { gte: totalAmount.toFixed(2) } }] },
                    data: { balance: { decrement: totalAmount.toFixed(2) } }
                });
                if (changed.count !== 1) throw Object.assign(new Error('Paying billing account is invalid or has insufficient balance'), { status: 409 });
                const account = await tx.billingAccount.findUnique({ where: { id: Number(billingAccountId) } });
                await tx.accountingLedgerEntry.create({ data: {
                    ispId, billingAccountId: account.id, direction: 'DEBIT', amount: totalAmount.toFixed(2),
                    balanceAfter: account.balance, sourceType: 'EXPENSE', sourceId: createdExpense.id,
                    reference: `EXPENSE-${createdExpense.id}`, description: createdExpense.description, createdById: req.user?.id || null,
                } });
            }

            return createdExpense;
        });

        return res.status(201).json({ success: true, data: expense });
    } catch (err) {
        return next(err);
    }
}

// --- ACCOUNT TRANSFERS (Account to Account) ---
async function createTransfer(req, res, next) {
    try {
        const ispId = Number(req.ispId);
        const { fromAccountId, toAccountId, amount, description } = req.body;
        const reference = String(req.body.idempotencyKey || req.body.reference || crypto.randomUUID()).slice(0, 191);

        const numAmount = Number(amount);
        if (!numAmount || numAmount <= 0) {
            return res.status(400).json({ success: false, error: 'Amount must be greater than 0' });
        }

        if (!fromAccountId || !toAccountId) {
            return res.status(400).json({ success: false, error: 'fromAccountId and toAccountId are required' });
        }

        if (Number(fromAccountId) === Number(toAccountId)) {
            return res.status(400).json({ success: false, error: 'From and To accounts cannot be the same' });
        }

        const transfer = await req.prisma.$transaction(async (tx) => {
            const duplicate = await tx.accountTransfer.findUnique({ where: { ispId_reference: { ispId, reference } } });
            if (duplicate) return duplicate;
            const accounts = await tx.billingAccount.findMany({
                where: {
                    ispId,
                    id: { in: [Number(fromAccountId), Number(toAccountId)] },
                    isActive: true,
                    ...(req.branchId ? { branchId: Number(req.branchId) } : {})
                }
            });
            if (accounts.length !== 2) throw Object.assign(new Error('One or both billing accounts are invalid or inactive'), { status: 404 });
            const source = accounts.find(account => account.id === Number(fromAccountId));

            const debit = await tx.billingAccount.updateMany({
                where: { id: source.id, ispId, OR: [{ allowNegative: true }, { balance: { gte: numAmount.toFixed(2) } }] },
                data: { balance: { decrement: numAmount.toFixed(2) } }
            });
            if (debit.count !== 1) throw Object.assign(new Error('Insufficient source account balance'), { status: 409, code: 'INSUFFICIENT_ACCOUNT_BALANCE' });
            await tx.billingAccount.updateMany({
                where: { id: Number(toAccountId), ispId },
                data: { balance: { increment: numAmount.toFixed(2) } }
            });
            const [fromAfter, toAfter] = await Promise.all([
                tx.billingAccount.findUnique({ where: { id: Number(fromAccountId) } }),
                tx.billingAccount.findUnique({ where: { id: Number(toAccountId) } }),
            ]);

            const created = await tx.accountTransfer.create({
                data: {
                    fromAccountId: Number(fromAccountId),
                    toAccountId: Number(toAccountId),
                    amount: numAmount.toFixed(2),
                    description: description || 'Account to Account Transfer',
                    reference,
                    ispId,
                    createdById: req.user?.id || null
                },
                include: {
                    fromAccount: { select: { name: true, type: true } },
                    toAccount: { select: { name: true, type: true } }
                }
            });
            await tx.accountingLedgerEntry.createMany({ data: [
                { ispId, billingAccountId: fromAfter.id, direction: 'DEBIT', amount: numAmount.toFixed(2), balanceAfter: fromAfter.balance, sourceType: 'TRANSFER', sourceId: created.id, reference, description, createdById: req.user?.id || null },
                { ispId, billingAccountId: toAfter.id, direction: 'CREDIT', amount: numAmount.toFixed(2), balanceAfter: toAfter.balance, sourceType: 'TRANSFER', sourceId: created.id, reference, description, createdById: req.user?.id || null },
            ] });
            return created;
        });

        return res.status(201).json({ success: true, data: transfer });
    } catch (err) {
        return next(err);
    }
}

async function listTransfers(req, res, next) {
    try {
        const ispId = Number(req.ispId);
        const { page = 1, limit = 20 } = req.query;

        const skip = (Number(page) - 1) * Number(limit);
        const take = Number(limit);

        const transferWhere = {
            ispId,
            ...(req.branchId ? {
                fromAccount: { branchId: Number(req.branchId) },
                toAccount: { branchId: Number(req.branchId) }
            } : {})
        };
        const [transfers, total] = await Promise.all([
            req.prisma.accountTransfer.findMany({
                where: transferWhere,
                skip,
                take,
                orderBy: { transferDate: 'desc' },
                include: {
                    fromAccount: { select: { name: true, type: true } },
                    toAccount: { select: { name: true, type: true } }
                }
            }),
            req.prisma.accountTransfer.count({ where: transferWhere })
        ]);

        return res.json({
            success: true,
            data: transfers,
            pagination: { total, page: Number(page), limit: Number(limit), totalPages: Math.ceil(total / Number(limit)) }
        });
    } catch (err) {
        return next(err);
    }
}

// --- ACCOUNTING DASHBOARD & REPORTS ---
async function getAccountingDashboard(req, res, next) {
    try {
        const ispId = Number(req.ispId);
        const { startDate, endDate } = req.query;

        const dateWhere = {};
        if (startDate) dateWhere.gte = new Date(startDate);
        if (endDate) dateWhere.lte = new Date(endDate);
        const branchWhere = req.branchId ? { branchId: Number(req.branchId) } : {};

        const [
            salesAggregate,
            purchasesAggregate,
            expensesAggregate,
            accounts,
            salesByCategory,
            expensesByCategory
        ] = await Promise.all([
            req.prisma.sale.aggregate({
                where: { ispId, ...branchWhere, ...(Object.keys(dateWhere).length > 0 && { saleDate: dateWhere }) },
                _sum: { totalAmount: true, paidAmount: true, dueAmount: true },
                _count: { id: true }
            }),
            req.prisma.purchase.aggregate({
                where: { ispId, ...branchWhere, ...(Object.keys(dateWhere).length > 0 && { purchaseDate: dateWhere }) },
                _sum: { totalAmount: true, paidAmount: true },
                _count: { id: true }
            }),
            req.prisma.expense.aggregate({
                where: { ispId, ...branchWhere, ...(Object.keys(dateWhere).length > 0 && { expenseDate: dateWhere }) },
                _sum: { totalAmount: true },
                _count: { id: true }
            }),
            req.prisma.billingAccount.findMany({
                where: { ispId, isActive: true, ...branchWhere },
                select: { id: true, name: true, type: true, balance: true }
            }),
            req.prisma.sale.groupBy({
                by: ['categoryId'],
                where: { ispId, ...branchWhere, ...(Object.keys(dateWhere).length > 0 && { saleDate: dateWhere }) },
                _sum: { totalAmount: true },
                _count: { id: true }
            }),
            req.prisma.expense.groupBy({
                by: ['categoryId'],
                where: { ispId, ...branchWhere, ...(Object.keys(dateWhere).length > 0 && { expenseDate: dateWhere }) },
                _sum: { totalAmount: true },
                _count: { id: true }
            })
        ]);

        return res.json({
            success: true,
            data: {
                totalSales: salesAggregate._sum.totalAmount || 0,
                totalPaidSales: salesAggregate._sum.paidAmount || 0,
                totalDueSales: salesAggregate._sum.dueAmount || 0,
                totalSalesCount: salesAggregate._count.id || 0,

                totalPurchases: purchasesAggregate._sum.totalAmount || 0,
                totalPaidPurchases: purchasesAggregate._sum.paidAmount || 0,
                totalPurchasesCount: purchasesAggregate._count.id || 0,

                totalExpenses: expensesAggregate._sum.totalAmount || 0,
                totalExpensesCount: expensesAggregate._count.id || 0,

                netProfit: (salesAggregate._sum.paidAmount || 0) - (expensesAggregate._sum.totalAmount || 0) - (purchasesAggregate._sum.paidAmount || 0),

                accounts,
                salesByCategory,
                expensesByCategory
            }
        });
    } catch (err) {
        return next(err);
    }
}

async function checkCustomerSubscription(req, res, next) {
    try {
        const customerId = Number(req.params.customerId);
        const customer = await req.prisma.customer.findFirst({
            where: { id: customerId, ispId: req.ispId, isDeleted: false, ...(req.branchId ? { branchId: req.branchId } : {}) },
            include: {
                lead: true,
                subscribedPkg: { include: { packagePlanDetails: true } },
                customerSubscriptions: { orderBy: { endDate: 'desc' }, take: 1 }
            }
        });

        if (!customer) {
            return res.status(404).json({ success: false, error: 'Customer not found' });
        }

        const latestSub = customer.customerSubscriptions[0];
        const now = new Date();
        const isExpired = !latestSub || (latestSub.endDate && new Date(latestSub.endDate) < now);

        return res.json({
            success: true,
            data: {
                customerId: customer.id,
                customerName: customer.lead?.name || `Customer #${customer.id}`,
                isExpired,
                package: customer.subscribedPkg ? {
                    id: customer.subscribedPkg.id,
                    name: customer.subscribedPkg.packagePlanDetails?.name || 'Subscription Package',
                    price: customer.subscribedPkg.price || 0
                } : null
            }
        });
    } catch (err) {
        return next(err);
    }
}

module.exports = {
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
};
