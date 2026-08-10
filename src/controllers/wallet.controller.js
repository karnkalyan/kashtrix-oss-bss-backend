const crypto = require('crypto');

function owner(body = {}, req = {}) {
  const resellerId = body.resellerId ? Number(body.resellerId) : (req.user?.resellerId ? Number(req.user.resellerId) : null);
  const branchId = body.branchId ? Number(body.branchId) : (!resellerId && req.branchId ? Number(req.branchId) : null);
  if (Boolean(resellerId) === Boolean(branchId)) {
    throw Object.assign(new Error('Exactly one of resellerId or branchId is required'), { status: 400 });
  }
  return { resellerId, branchId };
}

function requireAdministrator(req) {
  const role = String(req.user?.role || '').toLowerCase();
  if (!['administrator', 'admin', 'isp_admin', 'super admin', 'super_admin'].includes(role) || req.user?.resellerId) {
    throw Object.assign(new Error('Only an ISP administrator can deposit or adjust wallet funds'), { status: 403 });
  }
}

function money(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
    throw Object.assign(new Error('Amount must be a positive value with at most two decimal places'), { status: 400 });
  }
  const [whole, fraction = ''] = text.split('.');
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (minor <= 0n) throw Object.assign(new Error('Amount must be greater than zero'), { status: 400 });
  return { minor, decimal: `${minor / 100n}.${String(minor % 100n).padStart(2, '0')}` };
}

function ownerWhere(ispId, requested, req) {
  const where = { ispId, ...(requested.resellerId ? { resellerId: requested.resellerId } : { branchId: requested.branchId }) };
  if (req.user?.resellerId && requested.resellerId !== req.user.resellerId) {
    throw Object.assign(new Error('You cannot access another reseller wallet'), { status: 403 });
  }
  if (req.branchId && requested.branchId !== req.branchId) {
    throw Object.assign(new Error('You cannot access another branch wallet'), { status: 403 });
  }
  return where;
}

async function ensureWallet(tx, ispId, requested, req) {
  const where = ownerWhere(ispId, requested, req);
  let wallet = await tx.wallet.findFirst({ where });
  if (!wallet) wallet = await tx.wallet.create({ data: { ...where, balance: '0.00' } });
  return wallet;
}

async function getWallet(req, res, next) {
  try {
    const requested = owner(req.query, req);
    const wallet = await req.prisma.$transaction(tx => ensureWallet(tx, Number(req.ispId), requested, req));
    return res.json({ success: true, data: { ...wallet, availableBalance: wallet.balance.minus(wallet.reservedBalance) } });
  } catch (error) { return next(error); }
}

async function addFunds(req, res, next) {
  try {
    requireAdministrator(req);
    const requested = owner(req.body, req);
    const amount = money(req.body.amount);
    const depositor = await req.prisma.user.findFirst({
      where: { id: Number(req.user?.id), ispId: Number(req.ispId), isDeleted: false },
      select: { id: true, name: true, email: true }
    });
    if (!depositor) throw Object.assign(new Error('Authenticated depositing user was not found'), { status: 401 });
    const depositedBy = depositor.name || depositor.email;
    if (req.body.depositedBy && String(req.body.depositedBy).trim() !== depositedBy) {
      throw Object.assign(new Error('Deposited By is assigned from the authenticated user and cannot be changed'), { status: 400 });
    }
    const idempotencyKey = String(req.body.idempotencyKey || req.body.reference || req.body.referenceNo || crypto.randomUUID()).slice(0, 191);
    const result = await req.prisma.$transaction(async tx => {
      const wallet = await ensureWallet(tx, Number(req.ispId), requested, req);
      const existing = await tx.walletTransaction.findUnique({
        where: { walletId_idempotencyKey: { walletId: wallet.id, idempotencyKey } },
      });
      if (existing) return { wallet, transaction: existing, replayed: true };
      await tx.wallet.update({ where: { id: wallet.id }, data: { balance: { increment: amount.decimal } } });
      const updated = await tx.wallet.findUnique({ where: { id: wallet.id } });
      const transaction = await tx.walletTransaction.create({ data: {
        walletId: wallet.id, type: 'CREDIT', amount: amount.decimal, balanceAfter: updated.balance,
        description: String(req.body.description || req.body.notes || 'Wallet deposit').slice(0, 2000),
        reference: req.body.reference || req.body.referenceNo ? String(req.body.reference || req.body.referenceNo).slice(0, 191) : null,
        idempotencyKey, createdById: req.user?.id || null,
        resellerId: requested.resellerId,
        metadata: {
          action: 'DEPOSIT',
          sourceIp: req.ip,
          paymentMethod: req.body.paymentMethod || null,
          bankName: req.body.bankName || null,
          depositedBy,
          depositedByUserId: depositor.id,
          receiptNumber: req.body.receiptNumber || null
        },
      } });
      return { wallet: updated, transaction, replayed: false };
    });
    return res.status(result.replayed ? 200 : 201).json({ success: true, data: result });
  } catch (error) { return next(error); }
}

async function deductFunds(req, res, next) {
  try {
    requireAdministrator(req);
    const requested = owner(req.body, req);
    const amount = money(req.body.amount);
    const idempotencyKey = String(req.body.idempotencyKey || req.body.reference || '').slice(0, 191);
    if (!idempotencyKey) return res.status(400).json({ success: false, error: 'idempotencyKey is required for wallet debits' });
    const result = await req.prisma.$transaction(async tx => {
      const wallet = await ensureWallet(tx, Number(req.ispId), requested, req);
      const existing = await tx.walletTransaction.findUnique({
        where: { walletId_idempotencyKey: { walletId: wallet.id, idempotencyKey } },
      });
      if (existing) return { wallet, transaction: existing, replayed: true };
      const updatedCount = await tx.wallet.updateMany({
        where: { id: wallet.id, balance: { gte: wallet.reservedBalance.plus(amount.decimal) } },
        data: { balance: { decrement: amount.decimal } },
      });
      if (updatedCount.count !== 1) throw Object.assign(new Error('Insufficient available wallet balance'), { status: 409, code: 'INSUFFICIENT_WALLET_BALANCE' });
      const updated = await tx.wallet.findUnique({ where: { id: wallet.id } });
      const transaction = await tx.walletTransaction.create({ data: {
        walletId: wallet.id, type: 'DEBIT', amount: amount.decimal, balanceAfter: updated.balance,
        description: String(req.body.description || 'Subscriber recharge or activation').slice(0, 2000),
        reference: req.body.reference ? String(req.body.reference).slice(0, 191) : null,
        idempotencyKey, createdById: req.user?.id || null,
        resellerId: requested.resellerId,
        relatedCustomerId: req.body.customerId ? Number(req.body.customerId) : null,
        relatedInvoiceId: req.body.invoiceId ? String(req.body.invoiceId).slice(0, 191) : null,
        metadata: { action: req.body.action || 'DEBIT', sourceIp: req.ip },
      } });
      return { wallet: updated, transaction, replayed: false };
    });
    return res.status(result.replayed ? 200 : 201).json({ success: true, data: result });
  } catch (error) { return next(error); }
}

async function reverseTransaction(req, res, next) {
  try {
    requireAdministrator(req);
    const originalId = Number(req.params.transactionId);
    const result = await req.prisma.$transaction(async tx => {
      const original = await tx.walletTransaction.findFirst({
        where: { id: originalId, wallet: { ispId: Number(req.ispId) } }, include: { wallet: true, reversedBy: true },
      });
      if (!original) throw Object.assign(new Error('Wallet transaction not found'), { status: 404 });
      if (original.reversedBy) return { transaction: original.reversedBy, replayed: true };
      const increment = original.type === 'DEBIT';
      if (!increment) {
        const changed = await tx.wallet.updateMany({ where: { id: original.walletId, balance: { gte: original.amount } }, data: { balance: { decrement: original.amount } } });
        if (changed.count !== 1) throw Object.assign(new Error('The credit cannot be reversed because funds are no longer available'), { status: 409 });
      } else {
        await tx.wallet.update({ where: { id: original.walletId }, data: { balance: { increment: original.amount } } });
      }
      const wallet = await tx.wallet.findUnique({ where: { id: original.walletId } });
      const transaction = await tx.walletTransaction.create({ data: {
        walletId: original.walletId, type: increment ? 'CREDIT' : 'DEBIT', amount: original.amount,
        balanceAfter: wallet.balance, description: String(req.body.reason || `Reversal of transaction ${original.id}`).slice(0, 2000),
        reference: `REV-${original.id}`, idempotencyKey: `reversal:${original.id}`, reversalOfId: original.id,
        createdById: req.user.id, resellerId: original.resellerId, metadata: { action: 'REVERSAL', sourceIp: req.ip },
      } });
      return { wallet, transaction, replayed: false };
    });
    return res.status(result.replayed ? 200 : 201).json({ success: true, data: result });
  } catch (error) { return next(error); }
}

async function getTransactions(req, res, next) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const where = {
      wallet: { ispId: Number(req.ispId), ...(req.user?.resellerId ? { resellerId: req.user.resellerId } : {}), ...(req.branchId ? { branchId: req.branchId } : {}) },
      ...(req.query.walletId ? { walletId: Number(req.query.walletId) } : {}),
      ...(req.query.resellerId ? { resellerId: Number(req.query.resellerId) } : {}),
      ...(req.query.type && req.query.type !== 'all' ? { type: String(req.query.type) } : {}),
      ...(req.query.startDate || req.query.endDate ? { createdAt: {
        ...(req.query.startDate ? { gte: new Date(String(req.query.startDate)) } : {}),
        ...(req.query.endDate ? { lte: new Date(String(req.query.endDate)) } : {}),
      } } : {}),
    };
    const [transactions, total] = await Promise.all([
      req.prisma.walletTransaction.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: 'desc' },
        include: { wallet: { include: { reseller: { select: { name: true, code: true } }, branch: { select: { name: true, code: true } } } } } }),
      req.prisma.walletTransaction.count({ where }),
    ]);
    const creatorIds = [...new Set(transactions.map(item => item.createdById).filter(Boolean))];
    const creators = creatorIds.length ? await req.prisma.user.findMany({
      where: { id: { in: creatorIds }, ispId: Number(req.ispId) },
      select: { id: true, name: true, email: true }
    }) : [];
    const creatorById = new Map(creators.map(user => [user.id, user]));
    const data = transactions.map(item => ({ ...item, createdBy: creatorById.get(item.createdById) || null }));
    return res.json({ success: true, data, pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } });
  } catch (error) { return next(error); }
}

module.exports = { addFunds, deductFunds, getTransactions, getWallet, reverseTransaction };
