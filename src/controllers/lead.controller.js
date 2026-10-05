// leadController.js (updated backend)
const csv = require('csv-parser');
const stream = require('stream');
const { logAudit } = require('../utils/auditLogger');

async function createLead(req, res, next) {
  try {
    const {
      firstName,
      middleName,
      lastName,
      email,
      phoneNumber,
      secondaryContactNumber,
      source,
      status,
      memberShipId,
      notes,
      assignedUserId,
      interestedPackageId,
      branchId,
      subBranchId,
      address,
      street,
      district,
      province,
      city,
      zipCode,
      gender,
      age,
      fullAddress,
      latitude,
      longitude,
      serviceRadius
    } = req.body;

    // Validate branch and sub-branch based on global system settings
    const branchValidationSetting = await req.prisma.iSPSettings.findFirst({
      where: { ispId: req.ispId ? Number(req.ispId) : undefined, key: 'leadBranchValidation' }
    });
    const validationRule = branchValidationSetting?.value || 'optional';

    if (validationRule === 'branch_only' || validationRule === 'both') {
      if (!branchId) {
        return res.status(400).json({ error: 'Branch is required based on system settings.' });
      }
    }
    if (validationRule === 'both') {
      if (!subBranchId) {
        return res.status(400).json({ error: 'Sub-branch is required based on system settings.' });
      }
    }

    // Set default values for required fields if not provided
    const leadData = {
      firstName: firstName || 'Unknown',
      lastName: lastName || 'Unknown',
      email: email ? email.trim() : null,
      phoneNumber: phoneNumber ? phoneNumber.trim() : null,
      source: source || 'other',
      status: status || 'new',
      ispId: req.ispId ? Number(req.ispId) : null,
      branchId: branchId ? Number(branchId) : null,
      subBranchId: subBranchId ? Number(subBranchId) : null,
      // Optional fields
      middleName: middleName || null,
      secondaryContactNumber: secondaryContactNumber ? secondaryContactNumber.trim() : null,
      memberShipId: memberShipId ? Number(memberShipId) : null,
      notes: notes || null,
      assignedUserId: assignedUserId ? Number(assignedUserId) : null,
      interestedPackageId: interestedPackageId ? Number(interestedPackageId) : null,
      address: address || null,
      street: street || null,
      district: district || null,
      province: province || null,
      gender: gender || null,
      metadata: {
        city: city ? city.trim() : null,
        zipCode: zipCode ? zipCode.trim() : null,
        age: age || null,
        fullAddress: fullAddress || null,
        latitude: latitude || null,
        longitude: longitude || null,
        serviceRadius: serviceRadius || null
      }
    };

    // Fetch duplicate settings
    const dupSettings = await req.prisma.iSPSettings.findMany({
      where: {
        ispId: req.ispId ? Number(req.ispId) : undefined,
        key: { in: ['allowDuplicateLeadPhone', 'allowDuplicateLeadEmail'] }
      }
    });
    const allowDupPhone = dupSettings.find(s => s.key === 'allowDuplicateLeadPhone')?.value === 'true';
    const allowDupEmail = dupSettings.find(s => s.key === 'allowDuplicateLeadEmail')?.value === 'true';

    // Check for existing lead with same email or phone number
    const dupConditions = [];
    if (email && email.trim() && !allowDupEmail) {
      dupConditions.push({ email: email.trim() });
    }
    if (phoneNumber && phoneNumber.trim() && !allowDupPhone) {
      dupConditions.push({ phoneNumber: phoneNumber.trim() });
    }

    if (dupConditions.length > 0) {
      const existingLead = await req.prisma.lead.findFirst({
        where: {
          OR: dupConditions,
          ispId: req.ispId ? Number(req.ispId) : null,
          isDeleted: false
        }
      });

      if (existingLead) {
        return res.status(409).json({ error: "Lead with this email or phone already exists." });
      }
    }

    // Create new lead
    const newLead = await req.prisma.lead.create({
      data: leadData,
      include: {
        membership: true,
        assignedUser: {
          select: {
            id: true,
            name: true,
            email: true
          }
        },
        interestedPackage: true
      }
    });

    await logAudit(req.prisma, req.user?.id, 'LEAD_CREATE', { id: newLead.id, firstName: newLead.firstName, lastName: newLead.lastName }, req);

    return res.status(201).json(newLead);
  } catch (err) {
    if (err.code === 'P2002') { // Unique constraint failed
      return res.status(409).json({ error: "Lead with this email or phone already exists." });
    }
    if (err.code && err.code.startsWith('P')) { // Prisma specific errors
      return res.status(400).json({ error: "Database operation failed.", details: err.message });
    }
    return res.status(500).json({ error: "Internal server error", details: err.message || String(err) });
  }
}

const getAllLeads = async (req, res, next) => {
  try {
    const roleName = String(req.user?.role?.name || "").toLowerCase();
    const isFieldStaff = roleName.includes("field staff") || roleName.includes("field_staff");
    if (isFieldStaff && (!req.query.search || !String(req.query.search).trim())) {
      return res.json({ data: [], pagination: { total: 0, page: 1, limit: 20, totalPages: 0 } });
    }
    const userId = req.user.id;
    const userRole = req.user.role;
    const {
      page = 1,
      limit = 20,
      search,
      status,
      source,
      converted,
      qualified,
      unqualified,
      assigned_to_me // Frontend sends this for "My Leads" tab
    } = req.query;

    const where = {
      isDeleted: false,
      ispId: req.ispId || req.user.ispId,
    };

    // ROLE-BASED FILTERING (EXACTLY LIKE FOLLOW-UPS)
    // If the request specifically queries qualified leads, allow non-admins (like field staff) to see them all
    const isSearchingAllQualified = status === 'qualified' || qualified === 'true' || req.query.showAllQualified === 'true';
    if (userRole !== 'Administrator' && !isSearchingAllQualified) {
      // For non-admin users, show only their assigned leads
      where.assignedUserId = userId;
    } else {
      // For admins: if "assigned_to_me" is true, show only their leads
      // Otherwise, admins see all leads
      if (assigned_to_me === 'true') {
        where.assignedUserId = userId;
      }
    }

    // Status filter
    if (status && status !== 'all') {
      where.status = status;
    }

    // Source filter
    if (source && source !== 'all') {
      where.source = source;
    }

    // Area filter
    if (req.query.area) {
      const areas = String(req.query.area).split(',').map(s => s.trim()).filter(Boolean);
      if (areas.length > 0) {
        where.AND = where.AND || [];
        where.AND.push({
          OR: areas.flatMap(a => [
            { address: { contains: a } },
            { street: { contains: a } },
            { district: { contains: a } },
            { province: { contains: a } }
          ])
        });
      }
    }

    // Tab-based filters (qualified, unqualified, converted)
    if (qualified === 'true') {
      where.status = 'qualified';
    }

    if (unqualified === 'true') {
      where.status = 'unqualified';
    }

    if (converted === 'true') {
      where.convertedToCustomer = true;
    } else if (converted === 'false') {
      where.convertedToCustomer = false;
    }

    if (search) {
      const searchTerms = search.trim().split(/\s+/).filter(term => term.length > 0);

      if (searchTerms.length > 0) {
        // We use AND here because every search term must exist in the row
        where.AND = where.AND || [];

        searchTerms.forEach(term => {
          // For each specific word (term), it must be found in AT LEAST ONE of these fields
          where.AND.push({
            OR: [
              { firstName: { contains: term } },
              { lastName: { contains: term } },
              { email: { contains: term } },
              { phoneNumber: { contains: term } },
              { secondaryContactNumber: { contains: term } },
              { middleName: { contains: term } },
              { district: { contains: term } },
              { province: { contains: term } },
              { address: { contains: term } },
              { notes: { contains: term } }
            ]
          });
        });
      }
    }

    const fetchAll = String(limit).toLowerCase() === 'all';
    const parsedLimit = Math.max(1, parseInt(limit) || 20);
    const parsedPage = Math.max(1, parseInt(page) || 1);
    const offset = (parsedPage - 1) * parsedLimit;

    const [count, rows] = await Promise.all([
      req.prisma.lead.count({
        where
      }),
      req.prisma.lead.findMany({
        where,
        ...(fetchAll ? {} : { skip: parseInt(offset), take: parsedLimit }),
        include: {
          assignedUser: {
            select: {
              id: true,
              name: true,
              email: true,
              role: true
            }
          },
          membership: true,
          interestedPackage: true,
          convertedBy: true,
          customers: {
            select: {
              id: true
            }
          },
          followUps: {
            orderBy: { scheduledAt: 'desc' },
            take: 1
          }
        },
        orderBy: { createdAt: 'desc' }
      })
    ]);

    const leadIds = rows.map(r => r.id);
    const phoneNumbers = rows.map(r => r.phoneNumber).filter(Boolean);
    const secondaryPhones = rows.map(r => r.secondaryContactNumber).filter(Boolean);
    const allPhones = [...new Set([...phoneNumbers, ...secondaryPhones])];

    const sentSmsLeadIds = new Set();
    const sentSmsPhones = new Set();

    if (leadIds.length > 0) {
      const orConditions = [{ recipientId: { in: leadIds } }];
      if (allPhones.length > 0) {
        orConditions.push({ phone: { in: allPhones } });
      }

      const sentSmsLogs = await req.prisma.smsCampaignLog.findMany({
        where: {
          recipientType: 'lead',
          status: 'sent',
          OR: orConditions
        },
        select: {
          recipientId: true,
          phone: true
        }
      });
      sentSmsLogs.forEach(log => {
        if (log.recipientId) {
          sentSmsLeadIds.add(log.recipientId);
        }
        if (log.phone) {
          sentSmsPhones.add(log.phone);
        }
      });
    }

    const rowsWithSmsStatus = rows.map(row => ({
      ...row,
      smsSent: sentSmsLeadIds.has(row.id) || 
               (row.phoneNumber && sentSmsPhones.has(row.phoneNumber)) || 
               (row.secondaryContactNumber && sentSmsPhones.has(row.secondaryContactNumber))
    }));

    return res.status(200).json({
      success: true,
      data: rowsWithSmsStatus,
      pagination: {
        currentPage: fetchAll ? 1 : parsedPage,
        totalPages: fetchAll ? 1 : Math.ceil(count / parsedLimit),
        totalItems: count,
        itemsPerPage: fetchAll ? count : parsedLimit,
        hasNextPage: fetchAll ? false : parsedPage < Math.ceil(count / parsedLimit),
        hasPreviousPage: fetchAll ? false : parsedPage > 1
      },
      filters: {
        userRole,
        canViewAll: userRole === 'Administrator'
      }
    });
  } catch (err) {
    console.error("Get All Leads Error:", err.message);
    return res.status(500).json({
      error: "Failed to fetch leads",
      details: err.message
    });
  }
}

async function getLeadById(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid lead ID" });
    }

    const lead = await req.prisma.lead.findFirst({
      where: {
        id: id,
        ispId: req.ispId,
        isDeleted: false
      },
      include: {
        membership: true,
        branch: true,
        subBranch: true,
        assignedUser: {
          select: {
            id: true,
            name: true,
            email: true
          }
        },
        interestedPackage: {
          where: { isDeleted: false, isTrial: false },
          select: {
            id: true,
            packageName: true,
            price: true
          }
        },
        followUps: {
          where: { isDeleted: false },
          include: {
            assignedUser: {
              select: {
                id: true,
                name: true,
                email: true
              }
            }
          },
          orderBy: {
            scheduledAt: 'desc'
          }
        },
        customers: {
          select: {
            id: true,
            customerUniqueId: true,
            idNumber: true,
            status: true,
            isDeleted: true
          }
        }
      }
    });

    if (!lead) {
      return res.status(404).json({ error: "Lead not found." });
    }

    // If customer was deleted (or no active customer exists), ensure lead is reverted to qualified so it can be re-onboarded
    const hasActiveCustomer = lead.customers?.some(c => !c.isDeleted && c.status !== 'deleted');
    if (!hasActiveCustomer && (lead.convertedToCustomer || lead.status === 'converted')) {
      await req.prisma.lead.update({
        where: { id: lead.id },
        data: {
          convertedToCustomer: false,
          status: 'qualified'
        }
      });
      lead.convertedToCustomer = false;
      lead.status = 'qualified';
    }

    // Fetch SMS logs sent to this lead. Manual uploads can be logged as
    // recipientType "manual", so match by normalized phone variants too.
    const phoneVariants = new Set();
    [lead.phoneNumber, lead.secondaryContactNumber].filter(Boolean).forEach(phone => {
      const raw = String(phone).trim();
      const digits = raw.replace(/\D/g, '');
      if (raw) phoneVariants.add(raw);
      if (digits) phoneVariants.add(digits);
      if (digits.length >= 10) phoneVariants.add(digits.slice(-10));
      if (digits.length === 10) phoneVariants.add(`977${digits}`);
    });

    const orConditions = [
      { recipientType: 'lead', recipientId: id }
    ];
    if (phoneVariants.size > 0) {
      orConditions.push({ phone: { in: Array.from(phoneVariants) } });
    }

    const smsLogs = await req.prisma.smsCampaignLog.findMany({
      where: {
        OR: orConditions
      },
      include: {
        campaign: {
          select: {
            message: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    const leadWithSms = {
      ...lead,
      smsLogs: smsLogs.map(log => ({
        id: log.id,
        status: log.status,
        errorMessage: log.errorMessage,
        sentAt: log.sentAt || log.createdAt,
        message: log.campaign?.message || '',
        phone: log.phone,
        recipientType: log.recipientType,
        name: log.name
      }))
    };

    return res.status(200).json(leadWithSms);
  } catch (err) {
    console.error("Get Lead By ID Error:", err.message);
    if (err.code && err.code.startsWith('P')) {
      return res.status(400).json({ error: "Database operation failed.", details: err.message });
    }
    return res.status(500).json({ error: "Internal server error", details: err.message || String(err) });
  }
}

async function updateLead(req, res, next) {
  try {
    const id = Number(req.params.id);
    const {
      firstName,
      middleName,
      lastName,
      email,
      phoneNumber,
      secondaryContactNumber,
      source,
      status,
      memberShipId,
      notes,
      assignedUserId,
      interestedPackageId,
      branchId,
      subBranchId,
      address,
      street,
      district,
      province,
      city,
      zipCode,
      gender,
      age,
      fullAddress,
      latitude,
      longitude,
      serviceRadius
    } = req.body;

    const existingLead = await req.prisma.lead.findFirst({
      where: {
        id: id,
        ispId: req.ispId,
        isDeleted: false
      }
    });

    if (!existingLead) {
      return res.status(404).json({ error: "Lead not found." });
    }

    // Fetch duplicate settings
    const dupSettings = await req.prisma.iSPSettings.findMany({
      where: {
        ispId: req.ispId ? Number(req.ispId) : undefined,
        key: { in: ['allowDuplicateLeadPhone', 'allowDuplicateLeadEmail'] }
      }
    });
    const allowDupPhone = dupSettings.find(s => s.key === 'allowDuplicateLeadPhone')?.value === 'true';
    const allowDupEmail = dupSettings.find(s => s.key === 'allowDuplicateLeadEmail')?.value === 'true';

    // Check for duplicate email/phone when updating
    const dupConditions = [];
    if (email && email.trim() && !allowDupEmail) {
      dupConditions.push({ email: email.trim() });
    }
    if (phoneNumber && phoneNumber.trim() && !allowDupPhone) {
      dupConditions.push({ phoneNumber: phoneNumber.trim() });
    }

    if (dupConditions.length > 0) {
      const duplicateLead = await req.prisma.lead.findFirst({
        where: {
          OR: dupConditions,
          NOT: { id: id },
          ispId: req.ispId,
          isDeleted: false
        }
      });

      if (duplicateLead) {
        return res.status(409).json({ error: "Another lead with this email or phone already exists." });
      }
    }

    // Validate branch and sub-branch based on global system settings
    const branchValidationSetting = await req.prisma.iSPSettings.findFirst({
      where: { ispId: req.ispId ? Number(req.ispId) : undefined, key: 'leadBranchValidation' }
    });
    const validationRule = branchValidationSetting?.value || 'optional';

    if (validationRule === 'branch_only' || validationRule === 'both') {
      if (!branchId && !existingLead.branchId) {
        return res.status(400).json({ error: 'Branch is required based on system settings.' });
      }
    }
    if (validationRule === 'both') {
      if (!subBranchId && !existingLead.subBranchId) {
        return res.status(400).json({ error: 'Sub-branch is required based on system settings.' });
      }
    }

    const updateData = {};

    // Only include fields that are provided
    if (firstName !== undefined) updateData.firstName = firstName;
    if (middleName !== undefined) updateData.middleName = middleName;
    if (lastName !== undefined) updateData.lastName = lastName;
    if (email !== undefined) updateData.email = email && email.trim() ? email.trim() : null;
    if (phoneNumber !== undefined) updateData.phoneNumber = (phoneNumber && phoneNumber.trim()) ? phoneNumber.trim() : null;
    if (secondaryContactNumber !== undefined) updateData.secondaryContactNumber = (secondaryContactNumber && secondaryContactNumber.trim()) ? secondaryContactNumber.trim() : null;
    if (source !== undefined) updateData.source = source;
    if (status !== undefined) updateData.status = status;
    if (memberShipId !== undefined) updateData.memberShipId = memberShipId ? Number(memberShipId) : null;
    if (notes !== undefined) updateData.notes = notes;
    if (assignedUserId !== undefined) updateData.assignedUserId = assignedUserId ? Number(assignedUserId) : null;
    if (interestedPackageId !== undefined) updateData.interestedPackageId = interestedPackageId ? Number(interestedPackageId) : null;
    if (branchId !== undefined) updateData.branchId = branchId ? Number(branchId) : null;
    if (subBranchId !== undefined) updateData.subBranchId = subBranchId ? Number(subBranchId) : null;
    if (address !== undefined) updateData.address = address;
    if (street !== undefined) updateData.street = street;
    if (district !== undefined) updateData.district = district;
    if (province !== undefined) updateData.province = province;
    if (gender !== undefined) updateData.gender = gender;
    updateData.metadata = {
      ...existingLead.metadata,
      city: city !== undefined ? (city ? city.trim() : null) : existingLead.metadata?.city,
      zipCode: zipCode !== undefined ? (zipCode ? zipCode.trim() : null) : existingLead.metadata?.zipCode,
      age: age !== undefined ? age : existingLead.metadata?.age,
      fullAddress: fullAddress !== undefined ? fullAddress : existingLead.metadata?.fullAddress,
      latitude: latitude !== undefined ? latitude : existingLead.metadata?.latitude,
      longitude: longitude !== undefined ? longitude : existingLead.metadata?.longitude,
      serviceRadius: serviceRadius !== undefined ? serviceRadius : existingLead.metadata?.serviceRadius
    }

    const updatedLead = await req.prisma.lead.update({
      where: { id: id },
      data: updateData,
      include: {
        membership: true,
        assignedUser: {
          select: {
            id: true,
            name: true,
            email: true
          }
        },
        interestedPackage: true
      }
    });

    await logAudit(req.prisma, req.user?.id, 'LEAD_UPDATE', { id: updatedLead.id, firstName: updatedLead.firstName, lastName: updatedLead.lastName }, req);

    return res.status(200).json(updatedLead);
  } catch (err) {
    console.error("Update Lead Error:", err.message);
    if (err.code === 'P2002') {
      return res.status(409).json({ error: "Another lead with this email or phone already exists." });
    }
    return next(err);
  }
}

async function deleteLead(req, res, next) {
  try {
    const id = Number(req.params.id);
    const existingLead = await req.prisma.lead.findFirst({
      where: {
        id: id,
        ispId: req.ispId,
        isDeleted: false
      }
    });

    if (!existingLead) {
      return res.status(404).json({ error: "Lead not found." });
    }

    await req.prisma.lead.update({
      where: { id: id },
      data: { isDeleted: true }
    });

    await logAudit(req.prisma, req.user?.id, 'LEAD_DELETE', { id, firstName: existingLead.firstName, lastName: existingLead.lastName }, req);

    return res.status(200).json({ message: "Lead deleted successfully", id });
  } catch (err) {
    console.error("Delete Lead Error:", err.message);
    return next(err);
  }
}

async function convertLeadToCustomer(req, res, next) {
  try {
    const leadId = Number(req.params.id);
    const userId = req.user.id;
    const {
      idNumber,
      streetAddress,
      city,
      state,
      zipCode,
      lat,
      lon,
      deviceName,
      deviceMac,
      assignedPkg,
      rechargeable,
      membershipId,
      existingISPId,
      isReferenced,
      referencedById
    } = req.body;

    // Check if lead exists
    const lead = await req.prisma.lead.findFirst({
      where: {
        id: leadId,
        ispId: req.ispId,
        isDeleted: false
      },
      include: {
        membership: true,
        assignedUser: true,
        interestedPackage: true
      }
    });

    if (!lead) {
      return res.status(404).json({ error: "Lead not found." });
    }

    // Check if an existing customer for this lead or email exists (including soft-deleted)
    const existingCustomerForLead = await req.prisma.customer.findFirst({
      where: {
        OR: [
          { leadId: leadId },
          lead.email ? { lead: { email: lead.email } } : null
        ].filter(Boolean),
        ispId: req.ispId
      }
    });

    if (existingCustomerForLead) {
      if (!existingCustomerForLead.isDeleted) {
        return res.status(409).json({
          error: "Customer with this email or lead already exists."
        });
      }
    } else if (lead.convertedToCustomer) {
      return res.status(400).json({ error: "Lead already converted to customer." });
    }

    // Check if customer with same email already exists (active)
    if (lead.email) {
      const existingCustomer = await req.prisma.customer.findFirst({
        where: {
          lead: { email: lead.email },
          ispId: req.ispId,
          isDeleted: false
        }
      });

      if (existingCustomer && (!existingCustomerForLead || existingCustomer.id !== existingCustomerForLead.id)) {
        return res.status(409).json({
          error: "Customer with this email already exists."
        });
      }
    }

    // Use lead's interested package as assigned package if not provided
    const packageId = assignedPkg || lead.interestedPackageId;

    // Verify package exists if provided
    if (packageId) {
      const packageExists = await req.prisma.packagePrice.findFirst({
        where: {
          id: Number(packageId),
          isActive: true,
          isDeleted: false
        }
      });

      if (!packageExists) {
        return res.status(400).json({
          error: "Selected package is not available."
        });
      }
    }

    // Create customer from lead data
    const customerData = {
      idNumber: idNumber || String(leadId),
      assignedPkg: packageId ? Number(packageId) : null,
      isRechargeable: rechargeable || false,
      ispId: req.ispId ? Number(req.ispId) : null,
      membershipId: membershipId ? Number(membershipId) : lead.memberShipId || null,
      installedById: lead.assignedUserId || null,
      existingISPId: existingISPId ? Number(existingISPId) : null,
      leadId: leadId,
      subscribedPkgId: packageId ? Number(packageId) : null,
      branchId: lead.branchId || null,
      subBranchId: lead.subBranchId || null
    };

    let customerOperation;
    if (existingCustomerForLead && existingCustomerForLead.isDeleted) {
      // Reactivate from deleted to active with updated values
      customerOperation = req.prisma.customer.update({
        where: { id: existingCustomerForLead.id },
        data: {
          ...customerData,
          isDeleted: false,
          status: 'active',
          onboardStatus: 'active',
          updatedAt: new Date()
        },
        include: {
          packagePrice: true,
          subscribedPkg: true,
          membership: true,
          lead: true
        }
      });
    } else {
      customerOperation = req.prisma.customer.create({
        data: customerData,
        include: {
          packagePrice: true,
          subscribedPkg: true,
          membership: true,
          lead: true
        }
      });
    }

    // Start transaction
    const [newCustomer, updatedLead] = await req.prisma.$transaction([
      customerOperation,

      // Update lead conversion status
      req.prisma.lead.update({
        where: { id: leadId },
        data: {
          convertedToCustomer: true,
          convertedAt: new Date(),
          convertedById: Number(userId),
          status: 'converted'
        }
      })
    ]);

    try {
      const isp = await req.prisma.iSP.findUnique({ where: { id: req.ispId } });
      const ispName = isp?.companyName || isp?.name || 'ISP';
      const customerName = `${lead.firstName || ''} ${lead.lastName || ''}`.trim() || 'Customer';
      const packageName = newCustomer.subscribedPkg?.packagePlanDetails?.planName || newCustomer.subscribedPkg?.packageName || newCustomer.packagePrice?.packageName || 'Package';
      const templateData = {
        ispName,
        customerName,
        customerUniqueId: newCustomer.customerUniqueId || `CUST-${newCustomer.id}`,
        packageName,
        planStart: '',
        planEnd: '',
        username: '',
        password: '',
        phoneNumber: lead.phoneNumber || ''
      };

      if (lead.email) {
        const mailHelper = require('../utils/mailHelper');
        const { renderTemplate, textToHtml } = require('../utils/templateHelper');
        const rendered = await renderTemplate(req.ispId, 'EMAIL', 'customer_new_connection', templateData, {
          subject: 'Customer Account Created',
          body: `Dear ${customerName},\n\nYour customer account has been created successfully.\n\nCustomer ID: ${templateData.customerUniqueId}`
        }, req.prisma);
        mailHelper.queueMail(req.ispId, {
          to: lead.email,
          subject: rendered.subject,
          html: textToHtml(rendered.body)
        }, { ignoreNotificationSetting: true });
      }

      if (lead.phoneNumber) {
        const smsHelper = require('../utils/smsHelper');
        await smsHelper.sendEventSms(req.ispId, 'customer_new_connection', templateData);
      }
    } catch (notifyErr) {
      console.error('Lead conversion notification dispatch error:', notifyErr.message);
    }

    await logAudit(req.prisma, req.user?.id, 'LEAD_CONVERTED', { id: leadId, customerId: newCustomer.id, customerUniqueId: newCustomer.customerUniqueId }, req);

    return res.status(201).json({
      message: "Lead successfully converted to customer",
      customer: newCustomer,
      lead: updatedLead
    });

  } catch (err) {
    console.error("Convert Lead Error:", err.message);

    if (err.code === 'P2002') { // Unique constraint failed
      return res.status(409).json({
        error: "Customer with this email or ID number already exists."
      });
    }

    return res.status(500).json({
      error: "Failed to convert lead to customer",
      details: err.message || String(err)
    });
  }
}

async function getConvertedLeads(req, res, next) {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || '';
    const skip = (page - 1) * limit;

    // Build where clause
    const where = {
      ispId: req.ispId || req.user.ispId,
      convertedToCustomer: true,
      isDeleted: false
    };

    // Add search functionality (MySQL doesn't support mode: 'insensitive')
    if (search) {
      where.OR = [
        { firstName: { contains: search } },
        { lastName: { contains: search } },
        { email: { contains: search } },
        { phoneNumber: { contains: search } }
      ];
    }

    // Get total count
    const total = await req.prisma.lead.count({ where });

    // Get paginated converted leads
    const leads = await req.prisma.lead.findMany({
      where,
      include: {
        membership: true,
        assignedUser: {
          select: {
            id: true,
            name: true,
            email: true
          }
        },
        interestedPackage: true,
        convertedBy: {
          select: {
            id: true,
            name: true,
            email: true
          }
        },
        customers: {
          select: {
            id: true,
            customerUniqueId: true,
            idNumber: true,
            status: true
          }
        }
      },
      orderBy: {
        convertedAt: 'desc'
      },
      skip,
      take: limit
    });

    return res.status(200).json({
      data: leads,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: limit,
        hasNextPage: page < Math.ceil(total / limit),
        hasPreviousPage: page > 1
      }
    });
  } catch (err) {
    console.error("Get Converted Leads Error:", err.message);
    return res.status(500).json({
      error: "Failed to fetch converted leads",
      details: err.message
    });
  }
}

async function importLeadsFromCSV(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });

    const results = [];
    let importedCount = 0;
    let failedCount = 0;
    const errors = [];

    const bufferStream = new stream.PassThrough();
    bufferStream.end(req.file.buffer);

    await new Promise((resolve, reject) => {
      bufferStream
        .pipe(csv())
        .on('data', (data) => results.push(data))
        .on('end', resolve)
        .on('error', reject);
    });

    const branchCache = new Map();

    for (let i = 0; i < results.length; i++) {
      const row = results[i];
      try {
        let firstName = (row.firstName || row.first_name || row['First Name'] || '').toString().trim();
        let middleName = (row.middleName || row.middle_name || row['Middle Name'] || '').toString().trim() || null;
        let lastName = (row.lastName || row.last_name || row['Last Name'] || '').toString().trim();
        const fullName = (row.name || row.fullName || row['Full Name'] || row['Lead Name'] || '').toString().trim();

        if (!firstName && !lastName && fullName) {
          const parts = fullName.split(/\s+/).filter(Boolean);
          if (parts.length === 1) {
            firstName = parts[0];
            lastName = 'Prospect';
          } else if (parts.length === 2) {
            firstName = parts[0];
            lastName = parts[1];
          } else if (parts.length > 2) {
            firstName = parts[0];
            middleName = parts.slice(1, parts.length - 1).join(' ');
            lastName = parts[parts.length - 1];
          }
        }

        if (!firstName && !lastName) {
          firstName = `Lead-${i + 1}`;
          lastName = 'Prospect';
        }

        const phone = (row.phoneNumber || row.phone || row.mobile || row.contact || row['Phone Number'] || row['Mobile'] || '').toString().trim();
        const rawEmail = (row.email || row['Email'] || row['Email Address'] || '').toString().trim().toLowerCase();
        const cleanEmail = rawEmail || null;

        if (!phone && !cleanEmail) {
          failedCount++;
          errors.push(`Row ${i + 2}: Skipped - missing both phone number and email.`);
          continue;
        }

        const branchName = (row.branch || row.branchName || row['Branch Name'] || row.HeadBranch || '').toString().trim();
        const subBranchName = (row.subBranch || row.subBranchName || row['Sub-Branch Name'] || '').toString().trim();
        let branchId = row.branchId ? Number(row.branchId) : null;
        let subBranchId = row.subBranchId ? Number(row.subBranchId) : null;

        if (branchName && !branchId) {
          const bKey = branchName.toLowerCase();
          if (!branchCache.has(bKey)) {
            const br = await req.prisma.branch.findFirst({
              where: {
                name: branchName,
                parentId: null,
                ...(req.ispId ? { ispId: Number(req.ispId) } : {}),
                isDeleted: false
              }
            });
            branchCache.set(bKey, br ? br.id : null);
          }
          branchId = branchCache.get(bKey);
        }

        if (subBranchName && !subBranchId) {
          const sbKey = `${branchName}>${subBranchName}`.toLowerCase();
          if (!branchCache.has(sbKey)) {
            const sbr = await req.prisma.branch.findFirst({
              where: {
                name: subBranchName,
                ...(branchId ? { parentId: branchId } : {}),
                ...(req.ispId ? { ispId: Number(req.ispId) } : {}),
                isDeleted: false
              }
            });
            branchCache.set(sbKey, sbr ? sbr.id : null);
          }
          subBranchId = branchCache.get(sbKey);
        }

        const existingLead = await req.prisma.lead.findFirst({
          where: {
            OR: [
              ...(cleanEmail ? [{ email: cleanEmail }] : []),
              ...(phone ? [{ phoneNumber: phone }] : [])
            ],
            ...(req.ispId ? { ispId: Number(req.ispId) } : {}),
            isDeleted: false
          }
        });

        const validStatus = ['new', 'contacted', 'qualified', 'unqualified', 'converted'].includes(String(row.status || '').toLowerCase())
          ? String(row.status).toLowerCase()
          : 'new';

        if (!existingLead) {
          await req.prisma.lead.create({
            data: {
              firstName,
              middleName,
              lastName,
              email: cleanEmail,
              phoneNumber: phone || null,
              secondaryContactNumber: (row.secondaryContactNumber || row['Secondary Contact'] || row.altPhone || '').toString().trim() || null,
              source: (row.source || row['Source'] || 'import').toString().trim(),
              status: validStatus,
              ispId: req.ispId ? Number(req.ispId) : null,
              branchId: branchId || null,
              subBranchId: subBranchId || null,
              memberShipId: row.memberShipId ? Number(row.memberShipId) : null,
              notes: (row.notes || row['Notes'] || '').toString().trim() || null,
              assignedUserId: row.assignedUserId ? Number(row.assignedUserId) : null,
              interestedPackageId: row.interestedPackageId ? Number(row.interestedPackageId) : null,
              address: (row.address || row['Address'] || '').toString().trim() || null,
              street: (row.street || row['Street'] || '').toString().trim() || null,
              district: (row.district || row.city || row['District'] || row['City'] || '').toString().trim() || null,
              province: (row.province || row.state || row['Province'] || row['State'] || '').toString().trim() || null,
              gender: (row.gender || row['Gender'] || '').toString().trim() || null,
              metadata: {
                age: row.age || row['Age'] || null,
                fullAddress: row.fullAddress || row['Full Address'] || null
              }
            }
          });
          importedCount++;
        } else {
          failedCount++;
          errors.push(`Row ${i + 2}: Lead already exists (${cleanEmail || phone}) with ID #${existingLead.id}`);
        }
      } catch (error) {
        failedCount++;
        errors.push(`Row ${i + 2}: ${error.message}`);
      }
    }

    return res.status(200).json({
      message: `Import completed. Imported: ${importedCount}, Failed: ${failedCount}`,
      importedCount,
      failedCount,
      totalRows: results.length,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (err) {
    console.error("Import Leads Error:", err.message);
    return res.status(500).json({ error: "Failed to import leads", details: err.message || String(err) });
  }
}

async function downloadCSVTemplate(req, res, next) {
  try {
    const headers = [
      'firstName', 'middleName', 'lastName', 'email', 'phoneNumber',
      'secondaryContactNumber', 'source', 'status', 'address',
      'street', 'district', 'province', 'gender', 'notes',
      'memberShipId', 'assignedUserId', 'interestedPackageId',
      'age', 'fullAddress' // new dynamic fields
    ];

    const exampleData = {
      firstName: 'John', middleName: 'Michael', lastName: 'Doe',
      email: 'john.doe@example.com', phoneNumber: '+977-9812345678',
      secondaryContactNumber: '+977-9823456789', source: 'website', status: 'new',
      address: 'Kathmandu, Nepal', street: 'New Road', district: 'Kathmandu',
      province: 'Bagmati', gender: 'MALE', notes: 'Interested in high-speed package',
      memberShipId: '1', assignedUserId: '2', interestedPackageId: '3',
      age: '30', fullAddress: 'Kathmandu, New Road, Bagmati, Nepal'
    };

    let csvContent = headers.join(',') + '\n';
    csvContent += headers.map(header => `"${exampleData[header] || ''}"`).join(',') + '\n';

    const BOM = '\uFEFF';
    csvContent = BOM + csvContent;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="leads_import_template.csv"');
    res.setHeader('Content-Length', Buffer.byteLength(csvContent, 'utf8'));
    res.send(csvContent);
  } catch (err) {
    console.error("Download Template Error:", err.message);
    return res.status(500).json({ error: "Failed to generate template" });
  }
}

async function getLeadReports(req, res) {
  try {
    const {
      startDate,
      endDate,
      userId,
      status
    } = req.query;

    // Build filter conditions
    const whereConditions = {
      ispId: req.ispId,
      isDeleted: false
    };

    // Add date range filter
    if (startDate || endDate) {
      whereConditions.createdAt = {};
      if (startDate) {
        whereConditions.createdAt.gte = new Date(startDate);
      }
      if (endDate) {
        whereConditions.createdAt.lte = new Date(endDate);
      }
    }

    // Add user filter
    if (userId && userId !== 'all') {
      whereConditions.assignedUserId = parseInt(userId);
    }

    // Add status filter
    if (status && status !== 'all') {
      whereConditions.status = status;
    }

    // Get all leads with the filters
    const leads = await req.prisma.lead.findMany({
      where: whereConditions,
      include: {
        assignedUser: {
          select: { id: true, name: true, email: true }
        },
        interestedPackage: true,
        customers: true
      },
      orderBy: { createdAt: 'desc' }
    });

    // Calculate statistics
    const totalLeads = leads.length;
    const qualifiedLeads = leads.filter(lead => lead.status === 'qualified').length;
    const unqualifiedLeads = leads.filter(lead => lead.status === 'unqualified').length;
    const newLeads = leads.filter(lead => lead.status === 'new').length;
    const contactedLeads = leads.filter(lead => lead.status === 'contacted').length;
    const convertedLeads = leads.filter(lead => lead.convertedToCustomer).length;

    // Calculate percentages
    const qualifiedPercentage = totalLeads > 0 ? Math.round((qualifiedLeads / totalLeads) * 100) : 0;
    const unqualifiedPercentage = totalLeads > 0 ? Math.round((unqualifiedLeads / totalLeads) * 100) : 0;
    const conversionRate = totalLeads > 0 ? Math.round((convertedLeads / totalLeads) * 100) : 0;

    // Group by source
    const sourceDistribution = {};
    leads.forEach(lead => {
      const source = lead.source || 'unknown';
      sourceDistribution[source] = (sourceDistribution[source] || 0) + 1;
    });

    // Group by status
    const statusCounts = {
      new: newLeads,
      contacted: contactedLeads,
      qualified: qualifiedLeads,
      unqualified: unqualifiedLeads,
      converted: convertedLeads
    };

    // Calculate daily activity for the last 30 days
    const dailyActivity = {};
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const recentLeads = leads.filter(lead => new Date(lead.createdAt) >= thirtyDaysAgo);
    recentLeads.forEach(lead => {
      const date = new Date(lead.createdAt).toISOString().split('T')[0];
      dailyActivity[date] = (dailyActivity[date] || 0) + 1;
    });

    // Calculate average leads per day
    const daysWithLeads = Object.keys(dailyActivity).length;
    const averageLeadsPerDay = daysWithLeads > 0 ? (recentLeads.length / daysWithLeads).toFixed(1) : 0;

    // Return the report data
    res.json({
      success: true,
      data: {
        totalLeads,
        qualifiedLeads,
        unqualifiedLeads,
        newLeads,
        contactedLeads,
        convertedLeads,
        qualifiedPercentage,
        unqualifiedPercentage,
        conversionRate,
        sourceDistribution,
        statusCounts,
        dailyActivity,
        averageLeadsPerDay,
        leads: leads.slice(0, 50) // Return first 50 leads for detailed view
      }
    });
  } catch (error) {
    console.error('Error generating lead report:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate lead report'
    });
  }
}

async function exportLeadReport(req, res) {
  try {
    const {
      startDate,
      endDate,
      userId,
      status
    } = req.query;

    // Build filter conditions (same as getLeadReports)
    const whereConditions = {
      ispId: req.ispId,
      isDeleted: false
    };

    if (startDate || endDate) {
      whereConditions.createdAt = {};
      if (startDate) {
        whereConditions.createdAt.gte = new Date(startDate);
      }
      if (endDate) {
        whereConditions.createdAt.lte = new Date(endDate);
      }
    }

    if (userId && userId !== 'all') {
      whereConditions.assignedUserId = parseInt(userId);
    }

    if (status && status !== 'all') {
      whereConditions.status = status;
    }

    const leads = await req.prisma.lead.findMany({
      where: whereConditions,
      include: {
        assignedUser: {
          select: { name: true, email: true }
        },
        interestedPackage: {
          select: { packageName: true }
        },
        membership: {
          select: { name: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Convert to CSV
    const csvData = [
      ['ID', 'First Name', 'Last Name', 'Email', 'Phone', 'Status', 'Source', 'Assigned To', 'Package', 'Membership', 'Created At', 'Converted'].join(',')
    ];

    leads.forEach(lead => {
      const row = [
        lead.id,
        `"${lead.firstName || ''}"`,
        `"${lead.lastName || ''}"`,
        `"${lead.email || ''}"`,
        `"${lead.phoneNumber || ''}"`,
        lead.status,
        lead.source || '',
        `"${lead.assignedUser?.name || ''}"`,
        `"${lead.interestedPackage?.packageName || ''}"`,
        `"${lead.membership?.name || ''}"`,
        new Date(lead.createdAt).toISOString(),
        lead.convertedToCustomer ? 'Yes' : 'No'
      ];
      csvData.push(row.join(','));
    });

    const csvString = csvData.join('\n');

    // Set headers for file download
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=lead_report_${new Date().toISOString().split('T')[0]}.csv`);

    res.send(csvString);
  } catch (error) {
    console.error('Error exporting lead report:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to export lead report'
    });
  }
}

module.exports = {
  createLead,
  getAllLeads,
  getLeadById,
  updateLead,
  deleteLead,
  convertLeadToCustomer,
  getConvertedLeads,
  importLeadsFromCSV,
  downloadCSVTemplate,
  getLeadReports,
  exportLeadReport
};
