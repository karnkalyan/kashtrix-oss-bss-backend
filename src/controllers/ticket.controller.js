const prisma = require('../../prisma/client');
const { createSystemNotification } = require('../utils/notificationHelper');

const DEFAULT_TICKET_TAXONOMY = {
    'New Connection': ['Coverage Check', 'Plan Inquiry', 'New Installation', 'Installation Reschedule', 'Activation Issue'],
    'Internet Connectivity': ['No Internet', 'Slow Internet', 'Frequent Disconnection', 'High Latency', 'Packet Loss', 'Website/Application Not Working'],
    'Wi-Fi Issue': ['Weak Signal', 'Wi-Fi Not Connecting', 'Password Reset', 'Limited Coverage', 'Too Many Connected Devices'],
    'Fiber/Line Issue': ['LOS Red Light', 'Low Optical Power', 'Fiber Cable Damage', 'Drop Cable Issue', 'Distribution Box Issue'],
    'Router/Device Issue': ['Router Not Powering On', 'Router Configuration', 'Router Reset', 'Router Replacement', 'ONU/ONT Issue'],
    'Billing and Payment': ['Payment Not Updated', 'Incorrect Bill', 'Duplicate Payment', 'Invoice Request', 'Receipt Request', 'Refund Request'],
    'Renewal': ['Package Renewal', 'Account Expired', 'Auto-Renewal Issue', 'Renewal Confirmation'],
    'Package Change': ['Package Upgrade', 'Package Downgrade', 'Bandwidth Change', 'Package Information', 'Usage Inquiry'],
    'Account Management': ['Mobile Number Change', 'Email Change', 'Password Reset', 'Ownership Transfer', 'Customer Details Update'],
    'Relocation': ['Address Relocation', 'Internal Cable Relocation', 'Router Relocation', 'New Location Feasibility'],
    'Suspension/Termination': ['Temporary Suspension', 'Service Reactivation', 'Permanent Termination', 'Equipment Return'],
    'Network Services': ['Public IP Request', 'Static IP Issue', 'Port Forwarding', 'CGNAT Issue', 'DNS Issue', 'VPN Issue', 'CCTV/Gaming Issue'],
    'IPTV/Value-Added Services': ['IPTV Not Working', 'Set-Top Box Issue', 'Missing Channel', 'OTT Activation', 'Voice Service Issue'],
    'Outage': ['Area Outage', 'Planned Maintenance', 'Backbone Issue', 'Upstream Issue', 'Power Failure'],
    'Complaint/Escalation': ['Technician Delay', 'Unresolved Issue', 'Poor Customer Service', 'Installation Delay', 'Billing Dispute', 'Supervisor Escalation'],
    'Other': ['Other']
};

const normalizeTicketTypeText = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\bor\b/g, ' ').replace(/\s+/g, ' ').trim();
const makeTicketTypeCode = (category, subtype) => `SUPPORT_${category}_${subtype}`.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');

async function ensureDefaultTicketTypes(prismaClient, ispId) {
    const existing = await prismaClient.ticketType.findMany({ where: { ispId } });
    const missing = [];
    const updates = [];
    for (const [category, subtypes] of Object.entries(DEFAULT_TICKET_TAXONOMY)) {
        for (const subtype of subtypes) {
            const found = existing.find(type => {
                const storedCategory = normalizeTicketTypeText(type.description || String(type.name).split('/')[0]);
                const storedSubtype = normalizeTicketTypeText(String(type.name).split('/').pop());
                return storedCategory === normalizeTicketTypeText(category) && storedSubtype === normalizeTicketTypeText(subtype);
            });
            const canonicalName = category === 'Other' ? 'Other' : `${category} / ${subtype}`;
            if (found) {
                if (found.name !== canonicalName || found.description !== category || !found.isActive) {
                    updates.push(prismaClient.ticketType.update({ where: { id: found.id }, data: { name: canonicalName, description: category, isActive: true } }));
                }
            } else {
                missing.push({
                    ispId,
                    name: canonicalName,
                    code: makeTicketTypeCode(category, subtype),
                    description: category,
                    isActive: true
                });
            }
        }
    }
    if (updates.length) await Promise.all(updates);
    if (missing.length) await prismaClient.ticketType.createMany({ data: missing, skipDuplicates: true });
}

// Reusable customer include that resolves name via lead
const customerInclude = {
    select: {
        id: true,
        customerUniqueId: true,
        lead: {
            select: {
                firstName: true,
                lastName: true,
                email: true,
                phoneNumber: true,
                address: true,
                street: true,
                district: true,
                province: true,
            }
        }
    }
};

const leadInclude = {
    select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phoneNumber: true,
        status: true,
        convertedToCustomer: true,
        convertedAt: true,
        address: true,
        street: true,
        district: true,
        province: true,
    }
};

const customerIncludeBasic = {
    select: {
        id: true,
        customerUniqueId: true,
        lead: {
            select: {
                firstName: true,
                lastName: true,
                email: true,
                phoneNumber: true,
                address: true,
                street: true,
                district: true,
                province: true,
            }
        }
    }
};

/**
 * Transform customer data to flatten lead fields for frontend consumption
 */
function flattenCustomer(ticket) {
    if (!ticket) return ticket;
    
    let subject = null;
    if (ticket.customer) {
        subject = {
            type: 'CUSTOMER',
            id: ticket.customer.id,
            uniqueId: ticket.customer.customerUniqueId,
            firstName: ticket.customer.lead?.firstName || '',
            lastName: ticket.customer.lead?.lastName || '',
            email: ticket.customer.lead?.email || '',
            phoneNumber: ticket.customer.lead?.phoneNumber || '',
            address: [ticket.customer.lead?.address, ticket.customer.lead?.street, ticket.customer.lead?.district, ticket.customer.lead?.province].filter(Boolean).join(', '),
        };
    } else if (ticket.lead) {
        subject = {
            type: 'LEAD',
            id: ticket.lead.id,
            uniqueId: `LEAD-${ticket.lead.id}`,
            firstName: ticket.lead.firstName || '',
            lastName: ticket.lead.lastName || '',
            email: ticket.lead.email || '',
            phoneNumber: ticket.lead.phoneNumber || '',
            status: ticket.lead.status,
            convertedToCustomer: Boolean(ticket.lead.convertedToCustomer),
            convertedAt: ticket.lead.convertedAt,
            address: [ticket.lead.address, ticket.lead.street, ticket.lead.district, ticket.lead.province].filter(Boolean).join(', '),
        };
    } else if (ticket.contactName || ticket.contactPhone || ticket.contactEmail) {
        const parts = String(ticket.contactName || 'Guest').trim().split(/\s+/);
        subject = { type: 'GUEST', id: ticket.id, uniqueId: ticket.ticketNumber, firstName: parts[0] || 'Guest', lastName: parts.slice(1).join(' '), email: ticket.contactEmail || '', phoneNumber: ticket.contactPhone || '', address: '' };
    }

    const { customer, lead, ...rest } = ticket;
    return {
        ...rest,
        subject
    };
}

function flattenCustomerList(tickets) {
    return tickets.map(flattenCustomer);
}

async function findTicketAutoAssignee(prisma, ispId, branchId) {
    const supportRoles = [
        'sub branch admin',
        'branch admin',
        'support manager',
        'support agent',
        'technician',
        'administrator',
        'admin'
    ];

    const select = { id: true };

    if (branchId) {
        const branchUsers = await prisma.user.findMany({
            where: {
                ispId,
                isDeleted: false,
                status: 'active',
                OR: [
                    { branchId },
                    { userBranches: { some: { branchId } } }
                ],
                role: { isActive: true }
            },
            orderBy: { id: 'asc' },
            select: { id: true, role: { select: { name: true } } }
        });
        const branchUser = branchUsers.sort((a, b) => {
            const aIndex = supportRoles.indexOf(String(a.role?.name || '').toLowerCase());
            const bIndex = supportRoles.indexOf(String(b.role?.name || '').toLowerCase());
            return (aIndex < 0 ? 999 : aIndex) - (bIndex < 0 ? 999 : bIndex) || a.id - b.id;
        }).find(user => supportRoles.includes(String(user.role?.name || '').toLowerCase()));
        if (branchUser) return branchUser.id;
    }

    const adminUser = await prisma.user.findFirst({
        where: {
            ispId,
            isDeleted: false,
            status: 'active',
            role: { name: { in: ['administrator', 'admin', 'global admin', 'global administrator'] }, isActive: true }
        },
        orderBy: { id: 'asc' },
        select
    });

    return adminUser?.id || null;
}

/**
 * Create a new ticket
 */
async function createTicket(req, res, next) {
    try {
        let { title, description, priority, category, customerId, leadId, assignedToId, targetBranchId, notifyEmail, ticketTypeId, departmentId, contactName, contactPhone, contactEmail } = req.body;
        const ispId = req.ispId;
        let branchId = targetBranchId ? parseInt(targetBranchId) : null;
        const createdById = req.user?.id;

        // If user is a customer, auto-assign their info and branch
        if (req.user && (req.user.role === 'Customer' || req.user.role === 'customer' || req.user.customerId)) {
            let customer = null;
            if (req.user.customerId) {
                customer = await req.prisma.customer.findUnique({
                    where: { id: parseInt(req.user.customerId) },
                    select: { id: true, branchId: true, subBranchId: true }
                });
            }
            if (!customer && req.user.email) {
                customer = await req.prisma.customer.findFirst({
                    where: { lead: { email: req.user.email } },
                    select: { id: true, branchId: true, subBranchId: true }
                });
            }
            if (customer) {
                customerId = customer.id;
                // Auto assign to their branch if not specifically targeted
                if (!branchId) branchId = customer.subBranchId || customer.branchId;
            }
        }

        if (!customerId && !leadId && !String(contactName || '').trim()) {
            return res.status(400).json({ error: 'Select a lead/customer or enter the contact name.' });
        }
        if (!ticketTypeId) {
            return res.status(400).json({ error: 'Complaint type is required.' });
        }

        const selectedPriority = priority || 'MEDIUM';
        const typeId = ticketTypeId ? Number(ticketTypeId) : null;
        let sla = await req.prisma.ticketSlaPolicy.findFirst({
            where: {
                ispId,
                priority: selectedPriority,
                ticketTypeId: typeId,
                isActive: true
            }
        });
        if (!sla && typeId) {
            sla = await req.prisma.ticketSlaPolicy.findFirst({
                where: {
                    ispId,
                    priority: selectedPriority,
                    ticketTypeId: null,
                    isActive: true
                }
            });
        }
        const now = new Date();
        const dueAt = hours => sla ? new Date(now.getTime() + Number(hours) * 3600000) : null;
        if (ticketTypeId) {
            const type = await req.prisma.ticketType.findFirst({ where: { id: Number(ticketTypeId), ispId, isActive: true } });
            if (!type) return res.status(400).json({ error: 'Invalid ticket type' });
            if (!departmentId && type.departmentId) departmentId = type.departmentId;
        }

        if (customerId) {
            const customer = await req.prisma.customer.findFirst({
                where: { id: parseInt(customerId), ispId, isDeleted: false },
                select: { branchId: true, subBranchId: true }
            });
            branchId = customer?.subBranchId || customer?.branchId || branchId;
        } else if (leadId) {
            const lead = await req.prisma.lead.findFirst({
                where: { id: parseInt(leadId), ispId, isDeleted: false },
                select: { branchId: true, subBranchId: true }
            });
            branchId = lead?.subBranchId || lead?.branchId || branchId;
        }

        if (!branchId && req.branchId) branchId = req.branchId;

        if (!assignedToId) {
            assignedToId = await findTicketAutoAssignee(req.prisma, ispId, branchId);
        }

        if (assignedToId) {
            const assignee = await req.prisma.user.findFirst({
                where: {
                    id: parseInt(assignedToId),
                    ispId,
                    isDeleted: false,
                    ...(branchId ? {
                        OR: [
                            { branchId },
                            { userBranches: { some: { branchId } } }
                        ]
                    } : {})
                },
                select: { id: true, departmentId: true }
            });
            if (!assignee) {
                return res.status(400).json({ error: 'Assigned user must belong to the ticket branch.' });
            }
            if (!departmentId && assignee.departmentId) departmentId = assignee.departmentId;
        }

        // Generate ticket number
        const count = await req.prisma.ticket.count({ where: { ispId } });
        const ticketNumber = `TKT-${String(count + 1).padStart(5, '0')}`;

        const ticket = await req.prisma.ticket.create({
            data: {
                ticketNumber,
                title,
                description,
                priority: selectedPriority,
                category,
                customerId: customerId ? parseInt(customerId) : null,
                leadId: leadId ? parseInt(leadId) : null,
                assignedToId: assignedToId ? parseInt(assignedToId) : null,
                createdById,
                ispId,
                branchId,
                ticketTypeId: ticketTypeId ? Number(ticketTypeId) : null,
                departmentId: departmentId ? Number(departmentId) : null,
                contactName: contactName ? String(contactName).trim() : null,
                contactPhone: contactPhone ? String(contactPhone).trim() : null,
                contactEmail: contactEmail ? String(contactEmail).trim() : null,
                responseDueAt: dueAt(sla?.responseHours),
                resolutionDueAt: dueAt(sla?.resolutionHours),
                closeDueAt: dueAt(sla?.closeHours),
                updatedAt: new Date(),
            },
            include: {
                customer: customerIncludeBasic,
                lead: leadInclude,
                assignedTo: { select: { id: true, name: true, email: true } },
                createdBy: { select: { id: true, name: true, email: true } },
                branch: { select: { id: true, name: true } },
            }
        });

        // Emit WebSocket notification
        const wsManager = req.app.get('webSocketManager');
        if (wsManager) {
            wsManager.emitEvent('system.notification', {
                ispId,
                type: 'info',
                title: 'New Ticket Created',
                message: `Ticket ${ticketNumber}: ${title}`,
            });
        }

        if (assignedToId) {
            try {
                await createSystemNotification(req.prisma, {
                    userId: parseInt(assignedToId),
                    ispId,
                    branchId,
                    type: 'info',
                    title: 'New Ticket Assigned',
                    description: `Ticket ${ticketNumber} has been assigned to you: "${title}"`,
                    link: `/tickets/${ticket.id}`,
                    wsManager
                });
            } catch (err) {
                console.error('Failed to send ticket assignment notification:', err.message);
            }
        }

        // Trigger automated SMS
        const smsHelper = require('../utils/smsHelper');
        const subject = flattenCustomer(ticket).subject;
        if (subject && subject.phoneNumber) {
            await smsHelper.sendEventSms(ispId, 'ticket_creation', {
                firstName: subject.firstName,
                lastName: subject.lastName,
                phoneNumber: subject.phoneNumber,
                ticketNumber: ticketNumber,
                title: title,
                ispName: req.user?.isp?.companyName || 'ISP'
            });
        }

        // Email Notification to Customer/Branch/Assignee if enabled (default true)
        const shouldNotify = notifyEmail !== false;

        if (shouldNotify) {
            const mailHelper = require('../utils/mailHelper');
            const { renderTemplate, textToHtml } = require('../utils/templateHelper');
            const baseTemplateData = {
                ispName: req.user?.isp?.companyName || 'ISP',
                ticketNumber,
                title,
                description: description || '',
                priority: priority || 'MEDIUM',
                customerName: subject ? `${subject.firstName || ''} ${subject.lastName || ''}`.trim() : '',
                customerEmail: subject?.email || '',
                customerPhone: subject?.phoneNumber || '',
                branchName: ticket.branch?.name || ''
            };
            // 1) Email Notification to customer
            if (subject && subject.email) {
                try {
                    const rendered = await renderTemplate(ispId, 'EMAIL', 'support_ticket_customer', {
                        ...baseTemplateData,
                        customerName: baseTemplateData.customerName || 'Customer'
                    }, {
                        subject: `Ticket Created: ${ticketNumber}`,
                        body: `Dear ${subject.firstName || 'Customer'},\n\nA new support ticket (${ticketNumber}) has been created for you.\n\nTitle: ${title}\n\nWe will look into this and get back to you shortly.`
                    }, req.prisma);
                    mailHelper.queueMail(ispId, {
                        to: subject.email,
                        subject: rendered.subject,
                        html: textToHtml(rendered.body)
                    }, { ignoreNotificationSetting: true });
                } catch (e) {
                    console.error("Failed to send ticket email notification to customer:", e);
                }
            }

            // 2) Email Notification to Assignee
            if (ticket.assignedTo && ticket.assignedTo.email) {
                try {
                    const rendered = await renderTemplate(ispId, 'EMAIL', 'support_ticket_assignee', {
                        ...baseTemplateData,
                        userName: ticket.assignedTo.name || ticket.assignedTo.email
                    }, {
                        subject: `Ticket Assigned: ${ticketNumber}`,
                        body: `Dear ${ticket.assignedTo.name || 'Team Member'},\n\nA support ticket (${ticketNumber}) has been assigned to you.\n\nTitle: ${title}\nDescription: ${description || ''}\n\nPlease review and take action.`
                    }, req.prisma);
                    mailHelper.queueMail(ispId, {
                        to: ticket.assignedTo.email,
                        subject: rendered.subject,
                        html: textToHtml(rendered.body)
                    }, { ignoreNotificationSetting: true });
                } catch (e) {
                    console.error("Failed to send ticket assignee email notification:", e);
                }
            }

            // 3) Email Notification to branch support team
            if (branchId) {
                try {
                    const branchUsers = await req.prisma.user.findMany({
                        where: {
                            ispId,
                            isDeleted: false,
                            OR: [
                                { branchId },
                                { userBranches: { some: { branchId } } }
                            ],
                            role: {
                                isActive: true,
                            }
                        },
                        select: { email: true, name: true, role: { select: { name: true } } }
                    });

                    const supportRoles = ['support agent', 'support manager', 'technician', 'administrator', 'admin', 'branch admin', 'sub branch admin'];
                    const filteredUsers = branchUsers.filter(u => u.role && supportRoles.includes(String(u.role.name).toLowerCase()));

                    if (filteredUsers.length > 0) {
                        const mailHelper = require('../utils/mailHelper');
                        for (const user of filteredUsers) {
                            if (user.email) {
                                const rendered = await renderTemplate(ispId, 'EMAIL', 'support_ticket_branch', {
                                    ...baseTemplateData,
                                    userName: user.name || user.email
                                }, {
                                    subject: `New Ticket Created in your Branch: ${ticketNumber}`,
                                    body: `Dear ${user.name || 'Team Member'},\n\nA new support ticket (${ticketNumber}) has been created in your branch.\n\nTitle: ${title}\nDescription: ${description || ''}\n\nPlease review and take action.`
                                }, req.prisma);
                                mailHelper.queueMail(ispId, {
                                    to: user.email,
                                    subject: rendered.subject,
                                    html: textToHtml(rendered.body)
                                }, { ignoreNotificationSetting: true }).catch(err => console.error(`Error sending support notify email to ${user.email}:`, err));
                            }
                        }
                    }
                } catch (e) {
                    console.error("Failed to send branch support team email notifications:", e);
                }
            }
        }

        res.status(201).json(flattenCustomer(ticket));

    } catch (err) {
        next(err);
    }
}

/**
 * Get all tickets with pagination and filters
 */
async function getTickets(req, res, next) {
    try {
        const ispId = req.ispId;
        const branchId = req.branchId || null;
        const { page = 1, limit = 20, status, priority, search, customerId } = req.query;

        const where = {
            ispId,
            isDeleted: false,
            AND: [
                {
                    OR: [
                        { customerId: { not: null } },
                        { leadId: { not: null } },
                        { contactName: { not: null } }
                    ]
                }
            ],
            ...(branchId ? { branchId } : {}),
            ...(status ? { status } : {}),
            ...(priority ? { priority } : {}),
            ...(customerId ? { customerId: parseInt(customerId) } : {}),
            ...(search ? {
                OR: [
                    { title: { contains: search } },
                    { ticketNumber: { contains: search } },
                    { description: { contains: search } },
                ]
            } : {}),
        };

        const roleName = String(req.user?.role || '').toLowerCase();
        const isAdmin = roleName === 'administrator' || roleName === 'admin' || roleName === 'isp admin';

        if (!isAdmin) {
            const userId = req.user?.id;
            let categories = [];

            if (roleName.includes('field')) {
                where.AND.push({ assignedToId: userId });
            } else if (roleName.includes('tech')) {
                categories = ['technical', 'connectivity'];
            } else if (roleName.includes('support')) {
                categories = null; // Sees all unassigned
            } else if (roleName.includes('marketing') || roleName.includes('sales')) {
                categories = ['billing', 'account'];
            }

            if (roleName.includes('field')) {
                // Field staff only see tickets explicitly assigned to them.
            } else if (categories === null) {
                where.AND.push({
                    OR: [
                        { assignedToId: userId },
                        { assignedToId: null }
                    ]
                });
            } else if (categories.length > 0) {
                where.AND.push({
                    OR: [
                        { assignedToId: userId },
                        {
                            AND: [
                                { assignedToId: null },
                                { category: { in: categories } }
                            ]
                        }
                    ]
                });
            } else {
                where.AND.push({
                    assignedToId: userId
                });
            }
        }

        const [tickets, total] = await Promise.all([
            req.prisma.ticket.findMany({
                where,
                include: {
                    customer: customerIncludeBasic,
                    lead: leadInclude,
                    assignedTo: { select: { id: true, name: true, email: true } },
                    createdBy: { select: { id: true, name: true, email: true } },
                    branch: { select: { id: true, name: true } },
                },
                orderBy: { createdAt: 'desc' },
                take: parseInt(limit),
                skip: (parseInt(page) - 1) * parseInt(limit),
            }),
            req.prisma.ticket.count({ where }),
        ]);

        const commentCounts = await req.prisma.ticketComment.groupBy({
            by: ['ticketId'],
            where: { ticketId: { in: tickets.map(ticket => ticket.id) } },
            _count: true
        });
        const commentCountByTicket = new Map(commentCounts.map(row => [row.ticketId, row._count]));
        tickets.forEach(ticket => {
            ticket._count = { comments: commentCountByTicket.get(ticket.id) || 0 };
        });

        res.json({
            data: flattenCustomerList(tickets),
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(total / parseInt(limit)),
            }
        });
    } catch (err) {
        next(err);
    }
}

/**
 * Get single ticket by ID
 */
async function getTicketById(req, res, next) {
    try {
        const { id } = req.params;
        const ticket = await req.prisma.ticket.findUnique({
            where: { id: parseInt(id) },
            include: {
                customer: customerInclude,
                lead: leadInclude,
                assignedTo: { select: { id: true, name: true, email: true } },
                createdBy: { select: { id: true, name: true, email: true } },
                branch: { select: { id: true, name: true } },
                tasks: {
                    include: {
                        assignedTo: { select: { id: true, name: true, email: true } },
                        customer: { select: { id: true, customerUniqueId: true, lead: { select: { firstName: true, lastName: true, phoneNumber: true, address: true } } } },
                        activityLogs: { orderBy: { timestamp: 'desc' }, take: 5 },
                    },
                    orderBy: { createdAt: 'desc' },
                },
            },
        });

        if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
        
        let comments = await req.prisma.ticketComment.findMany({
            where: { ticketId: ticket.id },
            orderBy: { createdAt: 'asc' },
        });

        // Filter comments if user is a customer
        const roleName = String(req.user?.role || '').toLowerCase();
        if (roleName === 'customer') {
            const visibilitySetting = await req.prisma.iSPSettings.findUnique({
                where: { key: 'show_ticket_comments_to_customer' }
            });
            const showToCustomer = visibilitySetting ? (visibilitySetting.value === 'true' || visibilitySetting.value === 'Enable') : false;
            
            if (!showToCustomer) {
                comments = comments.filter(c => !c.isInternal);
            }
        }

        const userIds = [...new Set(comments.map(comment => comment.userId).filter(Boolean))];
        const users = userIds.length
            ? await req.prisma.user.findMany({
                where: { id: { in: userIds } },
                select: { id: true, name: true, email: true }
            })
            : [];
        const userById = new Map(users.map(user => [user.id, user]));
        ticket.comments = comments.map(comment => ({ ...comment, user: userById.get(comment.userId) || null }));
        res.json(flattenCustomer(ticket));
    } catch (err) {
        next(err);
    }
}

/**
 * Update a ticket
 */
async function updateTicket(req, res, next) {
    try {
        const { id } = req.params;
        const { title, description, status, priority, category, assignedToId, resolution, ticketTypeId, departmentId } = req.body;

        const existing = await req.prisma.ticket.findFirst({ where: { id: parseInt(id), ispId: req.ispId, isDeleted: false } });
        if (!existing || (req.branchId && existing.branchId !== req.branchId)) return res.status(404).json({ error: 'Ticket not found in your branch' });

        const userRoleName = String(req.user?.role || '').toLowerCase();
        const isFieldStaff = userRoleName.includes('field staff') || userRoleName.includes('field_staff');
        if (isFieldStaff && status !== undefined && status === 'CLOSED') {
            return res.status(403).json({ error: 'Field staff are not authorized to close tickets.' });
        }
        if (assignedToId) {
            const assignee = await req.prisma.user.findFirst({ where: { id: Number(assignedToId), ispId: req.ispId, isDeleted: false, ...(existing.branchId ? { OR: [{ branchId: existing.branchId }, { userBranches: { some: { branchId: existing.branchId } } }] } : {}) } });
            if (!assignee) return res.status(400).json({ error: 'Assignee must be a user of the ticket branch' });
        }

        const updateData = {};
        if (title !== undefined) updateData.title = title;
        if (description !== undefined) updateData.description = description;
        if (status !== undefined) updateData.status = status;
        if (priority !== undefined) updateData.priority = priority;
        if (category !== undefined) updateData.category = category;
        if (assignedToId !== undefined) updateData.assignedToId = assignedToId ? parseInt(assignedToId) : null;
        if (resolution !== undefined) updateData.resolution = resolution;
        if (ticketTypeId !== undefined) updateData.ticketTypeId = ticketTypeId ? Number(ticketTypeId) : null;
        if (departmentId !== undefined) updateData.departmentId = departmentId ? Number(departmentId) : null;
        if ((status === 'IN_PROGRESS' || resolution) && !existing.firstRespondedAt) updateData.firstRespondedAt = new Date();

        if (status === 'RESOLVED' || status === 'CLOSED') {
            updateData.resolvedAt = new Date();
        }
        if (status === 'RESOLVED') {
            const targetPriority = priority || existing.priority;
            const targetTypeId = ticketTypeId !== undefined ? (ticketTypeId ? Number(ticketTypeId) : null) : existing.ticketTypeId;
            let policy = await req.prisma.ticketSlaPolicy.findFirst({
                where: {
                    ispId: req.ispId,
                    priority: targetPriority,
                    ticketTypeId: targetTypeId,
                    isActive: true
                }
            });
            if (!policy && targetTypeId) {
                policy = await req.prisma.ticketSlaPolicy.findFirst({
                    where: {
                        ispId: req.ispId,
                        priority: targetPriority,
                        ticketTypeId: null,
                        isActive: true
                    }
                });
            }
            if (policy) updateData.closeDueAt = new Date(Date.now() + Number(policy.closeHours) * 3600000);
        }

        const ticket = await req.prisma.ticket.update({
            where: { id: parseInt(id) },
            data: updateData,
            include: {
                customer: customerIncludeBasic,
                assignedTo: { select: { id: true, name: true, email: true } },
            },
        });

        // Emit WebSocket notification
        const wsManager = req.app.get('webSocketManager');
        if (wsManager) {
            wsManager.emitEvent('system.notification', {
                ispId: ticket.ispId,
                type: 'info',
                title: 'Ticket Updated',
                message: `Ticket ${ticket.ticketNumber} status changed to ${status || 'updated'}`,
            });
        }

        if (assignedToId !== undefined && Number(assignedToId) !== existing.assignedToId && assignedToId) {
            try {
                await createSystemNotification(req.prisma, {
                    userId: parseInt(assignedToId),
                    ispId: ticket.ispId,
                    branchId: ticket.branchId,
                    type: 'info',
                    title: 'Ticket Reassigned',
                    description: `Ticket ${ticket.ticketNumber} has been reassigned to you: "${ticket.title}"`,
                    link: `/tickets/${ticket.id}`,
                    wsManager
                });
            } catch (err) {
                console.error('Failed to send ticket reassignment notification:', err.message);
            }
        }

        res.json(flattenCustomer(ticket));
    } catch (err) {
        next(err);
    }
}

/**
 * Add a comment to a ticket
 */
async function addComment(req, res, next) {
    try {
        const { id } = req.params;
        const { content, isInternal } = req.body;
        const userId = req.user?.id;

        if (!content || !String(content).trim()) {
            return res.status(400).json({ error: 'Comment content is required' });
        }

        const ticket = await req.prisma.ticket.findFirst({
            where: { id: parseInt(id), ispId: req.ispId, isDeleted: false },
            select: { id: true, assignedToId: true, createdById: true }
        });

        if (!ticket) {
            return res.status(404).json({ error: 'Ticket not found' });
        }

        if (req.user?.permissions?.includes('tickets_read_self') && !req.user.permissions.includes('tickets_read')) {
            const canComment = ticket.assignedToId === userId || ticket.createdById === userId;
            if (!canComment) {
                return res.status(403).json({ error: 'Access Denied' });
            }
        }

        const comment = await req.prisma.ticketComment.create({
            data: {
                ticketId: parseInt(id),
                userId,
                content: String(content).trim(),
                isInternal: isInternal || false,
            }
        });

        const user = userId
            ? await req.prisma.user.findUnique({
                where: { id: userId },
                select: { id: true, name: true, email: true }
            })
            : null;

        const commentPayload = { ...comment, user };

        // Update ticket's updatedAt
        await req.prisma.ticket.update({
            where: { id: parseInt(id) },
            data: { updatedAt: new Date() },
        });

        const wsManager = req.app.get('webSocketManager');
        if (wsManager) {
            wsManager.emitEvent('data.updated', {
                ispId: req.ispId,
                entity: 'ticket_comment',
                action: 'created',
                ticketId: ticket.id,
                commentId: comment.id
            });
        }

        res.status(201).json(commentPayload);
    } catch (err) {
        next(err);
    }
}

/**
 * Get tickets by customer ID
 */
async function getTicketsByCustomer(req, res, next) {
    try {
        const { customerId } = req.params;
        const tickets = await req.prisma.ticket.findMany({
            where: {
                customerId: parseInt(customerId),
                isDeleted: false,
            },
            include: {
                assignedTo: { select: { id: true, name: true, email: true } },
            },
            orderBy: { createdAt: 'desc' },
        });

        const commentCounts = tickets.length
            ? await req.prisma.ticketComment.groupBy({
                by: ['ticketId'],
                where: { ticketId: { in: tickets.map(ticket => ticket.id) } },
                _count: true
            })
            : [];
        const commentCountByTicket = new Map(commentCounts.map(row => [row.ticketId, row._count]));

        res.json(tickets.map(ticket => ({
            ...ticket,
            _count: { comments: commentCountByTicket.get(ticket.id) || 0 }
        })));
    } catch (err) {
        next(err);
    }
}

async function listTicketTypes(req, res, next) {
    try {
        await ensureDefaultTicketTypes(req.prisma, req.ispId);
        res.json(await req.prisma.ticketType.findMany({ where: { ispId: req.ispId, ...(req.query.active === 'true' ? { isActive: true } : {}) }, orderBy: { name: 'asc' } }));
    } catch (err) { next(err); }
}

async function saveTicketType(req, res, next) {
    try {
        const { name, code, description, departmentId, isActive = true } = req.body;
        if (!name || !code) return res.status(400).json({ error: 'Name and code are required' });
        const data = { name: String(name).trim(), code: String(code).trim().toUpperCase(), description: description || null, departmentId: departmentId ? Number(departmentId) : null, isActive: Boolean(isActive) };
        let row;
        if (req.params.id) {
            const current = await req.prisma.ticketType.findFirst({ where: { id: Number(req.params.id), ispId: req.ispId } });
            if (!current) return res.status(404).json({ error: 'Ticket type not found' });
            row = await req.prisma.ticketType.update({ where: { id: current.id }, data });
        } else row = await req.prisma.ticketType.create({ data: { ...data, ispId: req.ispId } });
        res.json(row);
    } catch (err) { next(err); }
}

async function listSlaPolicies(req, res, next) {
    try {
        const { ticketTypeId } = req.query;
        const parsedTypeId = ticketTypeId ? (ticketTypeId === 'null' ? null : Number(ticketTypeId)) : undefined;
        
        const where = {
            ispId: req.ispId,
            ...(parsedTypeId !== undefined ? { ticketTypeId: parsedTypeId } : {})
        };
        
        const rows = await req.prisma.ticketSlaPolicy.findMany({
            where,
            orderBy: { priority: 'asc' }
        });
        res.json(rows);
    } catch (err) { next(err); }
}

async function saveSlaPolicy(req, res, next) {
    try {
        const { priority, responseHours, resolutionHours, closeHours, isActive = true, ticketTypeId } = req.body;
        if (!['LOW','MEDIUM','HIGH','CRITICAL'].includes(priority) || [responseHours,resolutionHours,closeHours].some(v => Number(v) < 0)) {
            return res.status(400).json({ error: 'Valid priority and SLA hours are required' });
        }
        const parsedTypeId = ticketTypeId ? Number(ticketTypeId) : null;
        
        const row = await req.prisma.ticketSlaPolicy.upsert({ 
            where: { 
                ispId_priority_ticketTypeId: { 
                    ispId: req.ispId, 
                    priority, 
                    ticketTypeId: parsedTypeId 
                } 
            }, 
            update: { 
                responseHours: Number(responseHours), 
                resolutionHours: Number(resolutionHours), 
                closeHours: Number(closeHours), 
                isActive: Boolean(isActive) 
            }, 
            create: { 
                ispId: req.ispId, 
                priority, 
                ticketTypeId: parsedTypeId,
                responseHours: Number(responseHours), 
                resolutionHours: Number(resolutionHours), 
                closeHours: Number(closeHours), 
                isActive: Boolean(isActive) 
            } 
        });
        res.json(row);
    } catch (err) { next(err); }
}

async function getTicketDashboard(req, res, next) {
    try {
        const where = { ispId: req.ispId, isDeleted: false, ...(req.branchId ? { branchId: req.branchId } : {}) };
        const [statusRows, priorityRows, typeRows, total] = await Promise.all([
            req.prisma.ticket.groupBy({ by: ['status'], where, _count: true }),
            req.prisma.ticket.groupBy({ by: ['priority'], where, _count: true }),
            req.prisma.ticket.groupBy({ by: ['ticketTypeId'], where, _count: true }),
            req.prisma.ticket.count({ where })
        ]);
        const types = await req.prisma.ticketType.findMany({ where: { ispId: req.ispId } });
        const names = new Map(types.map(t => [t.id, t.name]));
        res.json({ total, byStatus: Object.fromEntries(statusRows.map(r => [r.status, r._count])), byPriority: Object.fromEntries(priorityRows.map(r => [r.priority, r._count])), byType: typeRows.map(r => ({ ticketTypeId: r.ticketTypeId, name: names.get(r.ticketTypeId) || 'Unclassified', count: r._count })) });
    } catch (err) { next(err); }
}

async function deleteTicket(req, res, next) {
    try {
        const { id } = req.params;
        await req.prisma.ticket.update({
            where: { id: Number(id) },
            data: { isDeleted: true }
        });
        res.json({ success: true, message: 'Ticket deleted successfully' });
    } catch (err) {
        next(err);
    }
}

module.exports = {
    createTicket,
    getTickets,
    getTicketById,
    updateTicket,
    addComment,
    getTicketsByCustomer,
    listTicketTypes,
    saveTicketType,
    listSlaPolicies,
    saveSlaPolicy,
    getTicketDashboard,
    deleteTicket,
};
