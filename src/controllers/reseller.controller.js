// src/controllers/reseller.controller.js
const bcrypt = require('bcrypt');

const RESELLER_DEFAULT_PERMISSIONS = [
    'reseller_view', 'wallet_view', 'dashboard_view', 'dashboard_overview',
    'customer_read', 'customer_create', 'customer_update', 'customers_list', 'customers_details', 'customers_create',
    'lead_read', 'lead_create', 'lead_update', 'leads_manage',
    'billing_create', 'billing_read_self', 'billing_update', 'tickets_read', 'tickets_create', 'tickets_update',
    'tasks_read_self', 'tasks_update', 'reports_read', 'services_read', 'inventory_read',
    'package_plans_read', 'package_price_read', 'reseller_device_assign', 'olt_read', 'splitter_read', 'nas_read'
];

async function ensureResellerRolePermissions(prisma) {
    const permissions = await prisma.permission.findMany({ where: { name: { in: RESELLER_DEFAULT_PERMISSIONS } }, select: { id: true } });
    return prisma.role.upsert({
        where: { name: 'Reseller' },
        update: { isActive: true, permissions: { connect: permissions.map(permission => ({ id: permission.id })) } },
        create: { name: 'Reseller', isActive: true, permissions: { connect: permissions.map(permission => ({ id: permission.id })) } }
    });
}

function isMainAdministrator(req) {
    const role = String(req.user?.role || '').toLowerCase();
    return ['administrator', 'admin', 'isp_admin', 'super admin', 'super_admin'].includes(role);
}

async function listResellers(req, res, next) {
    try {
        const { search, page = 1, limit = 20, isActive } = req.query;
        const ispId = Number(req.ispId);
        await ensureResellerRolePermissions(req.prisma);

        const where = {
            ispId,
            isDeleted: false,
            ...(req.user?.resellerId ? { id: req.user.resellerId } : {}),
        };

        if (isActive !== undefined && isActive !== 'all') {
            where.isActive = isActive === 'true' || isActive === true;
        }

        if (search) {
            where.OR = [
                { name: { contains: search } },
                { code: { contains: search } },
                { email: { contains: search } },
                { phoneNumber: { contains: search } },
                { contactPerson: { contains: search } },
            ];
        }

        const skip = (Number(page) - 1) * Number(limit);
        const take = Number(limit);

        const [items, total] = await Promise.all([
            req.prisma.reseller.findMany({
                where,
                skip,
                take,
                orderBy: { createdAt: 'desc' },
                include: {
                    wallet: true,
                    _count: {
                        select: { customers: { where: { isDeleted: false } } }
                    }
                }
            }),
            req.prisma.reseller.count({ where })
        ]);

        return res.json({
            success: true,
            data: items,
            pagination: {
                total,
                page: Number(page),
                limit: Number(limit),
                totalPages: Math.ceil(total / Number(limit))
            }
        });
    } catch (err) {
        return next(err);
    }
}

async function getResellerById(req, res, next) {
    try {
        const id = Number(req.params.id);
        const ispId = Number(req.ispId);

        const reseller = await req.prisma.reseller.findFirst({
            where: { id, ispId, isDeleted: false, ...(req.user?.resellerId ? { id: req.user.resellerId } : {}) },
            include: {
                wallet: true,
                _count: {
                    select: { customers: { where: { isDeleted: false } } }
                }
            }
        });

        if (!reseller) {
            return res.status(404).json({ success: false, error: 'Reseller not found' });
        }

        return res.json({ success: true, data: reseller });
    } catch (err) {
        return next(err);
    }
}

async function createReseller(req, res, next) {
    try {
        const ispId = Number(req.ispId);
        if (!isMainAdministrator(req) || req.user?.resellerId) {
            return res.status(403).json({ success: false, error: 'Only an ISP administrator can register resellers' });
        }
        const {
            name,
            code,
            email,
            password,
            phoneNumber,
            address,
            city,
            state,
            zipCode,
            country,
            website,
            legalName,
            registrationNo,
            panNo,
            notes,
            contactPerson,
            logoUrl,
            commissionType = 'PERCENTAGE',
            commissionValue = 0,
            initialWalletBalance = 0
        } = req.body;

        const normalizedEmail = String(email || '').trim().toLowerCase();
        const normalizedCode = String(code || '').trim().toUpperCase();
        if (!name || !normalizedCode || !normalizedEmail || String(password || '').length < 8) {
            return res.status(400).json({ success: false, error: 'Name, code, email, and a password of at least 8 characters are required' });
        }
        const openingBalance = Number(initialWalletBalance);
        if (!Number.isFinite(openingBalance) || openingBalance < 0) {
            return res.status(400).json({ success: false, error: 'Initial wallet balance must be zero or greater' });
        }

        const [existing, existingUser] = await Promise.all([
            req.prisma.reseller.findFirst({ where: { code: normalizedCode, isDeleted: false } }),
            req.prisma.user.findUnique({ where: { email: normalizedEmail } })
        ]);
        if (existing || existingUser) {
            return res.status(409).json({ success: false, error: existing ? 'Reseller code already exists' : 'Login email already exists' });
        }

        const reseller = await req.prisma.$transaction(async tx => {
            const permissions = await tx.permission.findMany({
                where: { name: { in: RESELLER_DEFAULT_PERMISSIONS } },
                select: { id: true }
            });
            const resellerRole = await tx.role.upsert({
                where: { name: 'Reseller' },
                update: {
                    isActive: true,
                    permissions: { connect: permissions.map(permission => ({ id: permission.id })) }
                },
                create: {
                    name: 'Reseller',
                    isActive: true,
                    permissions: { connect: permissions.map(permission => ({ id: permission.id })) }
                }
            });
            const created = await tx.reseller.create({ data: {
                name,
                code: normalizedCode,
                email: normalizedEmail,
                phoneNumber,
                address,
                city,
                state,
                zipCode,
                country,
                website,
                legalName,
                registrationNo,
                panNo,
                notes,
                contactPerson,
                logoUrl,
                commissionType,
                commissionValue: Number(commissionValue),
                ispId,
                wallet: {
                    create: {
                        balance: openingBalance.toFixed(2),
                        ispId
                    }
                }
            },
            include: { wallet: true } });
            await tx.user.create({
                data: {
                    email: normalizedEmail,
                    passwordHash: await bcrypt.hash(String(password), 10),
                    name: contactPerson || name,
                    roleId: resellerRole.id,
                    status: 'active',
                    ispId,
                    resellerId: created.id
                }
            });
            if (openingBalance > 0 && created.wallet) await tx.walletTransaction.create({
                data: {
                    walletId: created.wallet.id,
                    type: 'CREDIT',
                    amount: openingBalance.toFixed(2),
                    balanceAfter: openingBalance.toFixed(2),
                    description: 'Initial wallet balance on creation',
                    reference: `OPENING-${created.code}`,
                    idempotencyKey: `reseller-opening:${created.id}`,
                    createdById: req.user?.id || null,
                    resellerId: created.id,
                    metadata: { action: 'OPENING_BALANCE' }
                }
            });
            return created;
        });

        return res.status(201).json({ success: true, data: reseller });
    } catch (err) {
        return next(err);
    }
}

async function updateReseller(req, res, next) {
    try {
        const id = Number(req.params.id);
        const ispId = Number(req.ispId);

        const reseller = await req.prisma.reseller.findFirst({
            where: { id, ispId, isDeleted: false, ...(req.user?.resellerId ? { id: req.user.resellerId } : {}) }
        });
        if (!reseller) {
            return res.status(404).json({ success: false, error: 'Reseller not found' });
        }

        const {
            name,
            email,
            phoneNumber,
            address,
            city,
            state,
            zipCode,
            country,
            website,
            legalName,
            registrationNo,
            panNo,
            notes,
            contactPerson,
            logoUrl,
            isActive,
            commissionType,
            commissionValue
        } = req.body;

        const updated = await req.prisma.reseller.update({
            where: { id },
            data: {
                ...(name && { name }),
                ...(email !== undefined && { email }),
                ...(phoneNumber !== undefined && { phoneNumber }),
                ...(address !== undefined && { address }),
                ...(city !== undefined && { city }),
                ...(state !== undefined && { state }),
                ...(zipCode !== undefined && { zipCode }),
                ...(country !== undefined && { country }),
                ...(website !== undefined && { website }),
                ...(legalName !== undefined && { legalName }),
                ...(registrationNo !== undefined && { registrationNo }),
                ...(panNo !== undefined && { panNo }),
                ...(notes !== undefined && { notes }),
                ...(contactPerson !== undefined && { contactPerson }),
                ...(logoUrl !== undefined && { logoUrl }),
                ...(isActive !== undefined && { isActive }),
                ...(commissionType && { commissionType }),
                ...(commissionValue !== undefined && { commissionValue: Number(commissionValue) })
            },
            include: { wallet: true }
        });

        return res.json({ success: true, data: updated });
    } catch (err) {
        return next(err);
    }
}

async function deleteReseller(req, res, next) {
    try {
        const id = Number(req.params.id);
        const ispId = Number(req.ispId);

        if (req.user?.resellerId) return res.status(403).json({ success: false, error: 'Reseller users cannot delete reseller organisations' });
        const reseller = await req.prisma.reseller.findFirst({
            where: { id, ispId, isDeleted: false }
        });
        if (!reseller) {
            return res.status(404).json({ success: false, error: 'Reseller not found' });
        }

        await req.prisma.reseller.update({
            where: { id },
            data: { isDeleted: true, isActive: false }
        });

        return res.json({ success: true, message: 'Reseller deleted successfully' });
    } catch (err) {
        return next(err);
    }
}

async function assignCustomerToReseller(req, res, next) {
    try {
        const resellerId = Number(req.params.id);
        const { customerId, action = 'assign' } = req.body;
        const ispId = Number(req.ispId);

        if (!customerId) {
            return res.status(400).json({ success: false, error: 'customerId is required' });
        }

        const reseller = await req.prisma.reseller.findFirst({
            where: { id: resellerId, ispId, isDeleted: false }
        });
        if (!reseller) {
            return res.status(404).json({ success: false, error: 'Reseller not found' });
        }

        const customerExists = await req.prisma.customer.findFirst({ where: { id: Number(customerId), ispId, isDeleted: false } });
        if (!customerExists) return res.status(404).json({ success: false, error: 'Customer not found' });
        if (action !== 'assign' && customerExists.resellerId !== resellerId) {
            return res.status(409).json({ success: false, error: 'Customer is not assigned to this reseller' });
        }
        const customer = await req.prisma.customer.update({
            where: { id: customerExists.id },
            data: {
                resellerId: action === 'assign' ? resellerId : null
            }
        });

        return res.json({ success: true, data: customer });
    } catch (err) {
        return next(err);
    }
}

async function listResellerDevices(req, res, next) {
    try {
        const resellerId = Number(req.params.id);
        if (req.user?.resellerId && req.user.resellerId !== resellerId) return res.status(404).json({ success: false, error: 'Reseller not found' });
        const devices = await req.prisma.managedDevice.findMany({
            where: { ispId: Number(req.ispId), resellerId, isDeleted: false },
            select: { id: true, uuid: true, name: true, deviceType: true, vendor: true, model: true, host: true, status: true, lastSeenAt: true },
            orderBy: { name: 'asc' },
        });
        return res.json({ success: true, data: devices });
    } catch (error) { return next(error); }
}

async function assignDeviceToReseller(req, res, next) {
    try {
        if (req.user?.resellerId) return res.status(403).json({ success: false, error: 'Only the main administrator can change reseller device assignments' });
        const resellerId = Number(req.params.id);
        const deviceId = Number(req.body.deviceId);
        const action = req.body.action === 'remove' ? 'remove' : 'assign';
        const [reseller, device] = await Promise.all([
            req.prisma.reseller.findFirst({ where: { id: resellerId, ispId: Number(req.ispId), isDeleted: false } }),
            req.prisma.managedDevice.findFirst({ where: { id: deviceId, ispId: Number(req.ispId), isDeleted: false } }),
        ]);
        if (!reseller || !device) return res.status(404).json({ success: false, error: 'Reseller or device not found' });
        if (action === 'remove' && device.resellerId !== resellerId) return res.status(409).json({ success: false, error: 'Device is not assigned to this reseller' });
        if (action === 'assign' && device.resellerId && device.resellerId !== resellerId) {
            return res.status(409).json({ success: false, error: 'Device is already assigned to another reseller' });
        }
        const updated = await req.prisma.$transaction(async tx => {
            const changed = await tx.managedDevice.update({ where: { id: device.id }, data: { resellerId: action === 'assign' ? resellerId : null, updatedBy: req.user.id } });
            await tx.auditLog.create({ data: {
                ispId: Number(req.ispId), userId: req.user.id, action: 'RESELLER_DEVICE_ASSIGNMENT_CHANGED',
                details: JSON.stringify({ deviceId, oldResellerId: device.resellerId, newResellerId: changed.resellerId }), ip: req.ip,
            } });
            return changed;
        });
        return res.json({ success: true, data: updated });
    } catch (error) { return next(error); }
}

module.exports = {
    listResellers,
    getResellerById,
    createReseller,
    updateReseller,
    deleteReseller,
    assignCustomerToReseller,
    assignDeviceToReseller,
    listResellerDevices
};
