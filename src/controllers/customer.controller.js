// src/controllers/customerController.js
const { getBranchFilter, getAllSubBranchIds } = require('../utils/branchHelper');
const { logAudit } = require('../utils/auditLogger');
const { logSystem } = require('../utils/systemLogger');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const { ServiceFactory } = require('../lib/clients/ServiceFactory');
const { SERVICE_CODES } = require('../lib/serviceConstants');  // <-- add this line
const { formatRadiusExpiration } = require('../utils/radiusExpiration');
const getDriver = require('../drivers');
const { syncOrderToAccounting } = require('../services/accountingInvoice.service');
const { atPlanBoundary, getDeductibleRenewalBase } = require('../utils/dateHelper');

function getSubscriptionRenewalBase(subscription, now = new Date()) {
  return getDeductibleRenewalBase(subscription, now);
}

async function getSubscriptionRenewalWindow(prisma, ispId, subscription) {
  const now = atPlanBoundary();
  if (Number(subscription?.graceDaysBalance || 0) + Number(subscription?.adminExtensionDays || 0) > 0) {
    return { planStart: getSubscriptionRenewalBase(subscription, now), trialDeductionDays: 0 };
  }
  if (!subscription?.isTrial) return { planStart: getSubscriptionRenewalBase(subscription, now), trialDeductionDays: 0 };
  const setting = await prisma.iSPSettings.findFirst({ where: { ispId: Number(ispId), key: 'trialDeductionOnSubscriptionActivation' } });
  const trialMs = Math.max(0, new Date(subscription.planEnd) - new Date(subscription.planStart));
  return { planStart: now, trialDeductionDays: setting?.value === 'true' ? Math.ceil(trialMs / 86400000) : 0 };
}
// ----------------------------------------------------------------------
// Multer configuration
// ----------------------------------------------------------------------
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = 'uploads/customers/documents/';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|pdf|doc|docx/;
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedTypes.test(file.mimetype);

  if (mimetype && extname) {
    return cb(null, true);
  }
  cb(new Error('Only image and document files are allowed'));
};

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: fileFilter
}).fields([
  { name: 'idProof', maxCount: 1 },
  { name: 'addressProof', maxCount: 1 },
  { name: 'photo', maxCount: 1 },
  { name: 'otherDocuments', maxCount: 5 }
]);

// ----------------------------------------------------------------------
// Helper functions
// ----------------------------------------------------------------------

function normalizeUploadPath(filePath) {
  if (!filePath) return null;
  const normalized = String(filePath).replace(/\\/g, '/');
  const uploadsIndex = normalized.indexOf('uploads/');
  if (uploadsIndex >= 0) return `/${normalized.slice(uploadsIndex)}`;
  return null;
}

function enrichCustomerDocument(doc) {
  if (!doc) return doc;
  const previewUrl = normalizeUploadPath(doc.filePath);
  const isInlinePreview = /^image\//i.test(doc.mimeType || '') || String(doc.mimeType || '').toLowerCase() === 'application/pdf';

  return {
    ...doc,
    filePath: undefined,
    previewUrl,
    canPreviewInline: Boolean(previewUrl && isInlinePreview),
    downloadUrl: `/customer/${doc.customerId}/documents/${doc.id}/download`,
  };
}

function enrichCustomerDocuments(docs = []) {
  return Array.isArray(docs) ? docs.map(enrichCustomerDocument) : [];
}

function enrichCustomerDocumentFields(customer) {
  if (!customer || !Array.isArray(customer.documents)) return customer;
  return {
    ...customer,
    documents: enrichCustomerDocuments(customer.documents),
  };
}

async function findCustomerForAuthenticatedUser(prisma, req, extraInclude = {}) {
  const email = req.user?.email;
  if (!email) return null;

  // Direct lookup if customerId is present in req.user
  if (req.user?.customerId) {
    const customer = await prisma.customer.findFirst({
      where: {
        id: req.user.customerId,
        ispId: req.ispId,
        isDeleted: false
      },
      include: {
        lead: true,
        isp: { select: { id: true, companyName: true } },
        branch: { select: { id: true, name: true } },
        subBranch: { select: { id: true, name: true } },
        subscribedPkg: { include: { packagePlanDetails: true } },
        packagePrice: { include: { packagePlanDetails: true } },
        connectionUsers: { where: { isDeleted: false }, orderBy: { createdAt: 'desc' } },
        portalUser: { select: { id: true, email: true, name: true, profilePicture: true } },
        devices: { orderBy: { createdAt: 'desc' } },
        serviceDetails: true,
        documents: {
          where: { isDeleted: false },
          orderBy: { uploadedAt: 'desc' },
          select: {
            id: true,
            documentType: true,
            fileName: true,
            filePath: true,
            mimeType: true,
            size: true,
            uploadedAt: true,
            customerId: true,
          },
        },
        customerSubscriptions: {
          orderBy: { createdAt: 'desc' },
          take: 3,
          include: { packagePrice: { include: { packagePlanDetails: true } } },
        },
        orders: {
          where: { isDeleted: false },
          orderBy: { orderDate: 'desc' },
          take: 10,
          include: { items: true, packagePrice: { include: { packagePlanDetails: true } } },
        },
        tickets: {
          where: { isDeleted: false },
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
        wifiCredentials: {
          orderBy: { ssidIndex: 'asc' },
        },
        referrals: {
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
        ...extraInclude,
      }
    });
    if (customer) return customer;
  }

  // First check if the user has a Customer role and match by portal user criteria
  if (req.user?.role === 'Customer' || req.user?.role === 'customer') {
    const dbUser = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: { role: true }
    });

    if (dbUser) {
      // Find by candidate emails first
      const matchedCustomer = await prisma.customer.findFirst({
        where: {
          ispId: req.ispId,
          isDeleted: false,
          OR: [
            { lead: { email: dbUser.email } },
            { customerUniqueId: dbUser.email.split('@')[0] },
            { connectionUsers: { some: { username: dbUser.email, isDeleted: false } } }
          ]
        },
        include: {
          lead: true,
          isp: { select: { id: true, companyName: true } },
          branch: { select: { id: true, name: true } },
          subBranch: { select: { id: true, name: true } },
          subscribedPkg: { include: { packagePlanDetails: true } },
          packagePrice: { include: { packagePlanDetails: true } },
          connectionUsers: { where: { isDeleted: false }, orderBy: { createdAt: 'desc' } },
          portalUser: { select: { id: true, email: true, name: true, profilePicture: true } },
          devices: { orderBy: { createdAt: 'desc' } },
          serviceDetails: true,
          documents: {
            where: { isDeleted: false },
            orderBy: { uploadedAt: 'desc' },
            select: {
              id: true,
              documentType: true,
              fileName: true,
              filePath: true,
              mimeType: true,
              size: true,
              uploadedAt: true,
              customerId: true,
            },
          },
          customerSubscriptions: {
            orderBy: { createdAt: 'desc' },
            take: 3,
            include: { packagePrice: { include: { packagePlanDetails: true } } },
          },
          orders: {
            where: { isDeleted: false },
            orderBy: { orderDate: 'desc' },
            take: 10,
            include: { items: true, packagePrice: { include: { packagePlanDetails: true } } },
          },
          tickets: {
            where: { isDeleted: false },
            orderBy: { createdAt: 'desc' },
            take: 10,
          },
          wifiCredentials: {
            orderBy: { ssidIndex: 'asc' },
          },
          referrals: {
            orderBy: { createdAt: 'desc' },
            take: 20,
          },
          ...extraInclude,
        }
      });

      if (matchedCustomer) {
        // Proactively link customerId to the user
        if (dbUser.customerId !== matchedCustomer.id) {
          await prisma.user.update({
            where: { id: dbUser.id },
            data: { customerId: matchedCustomer.id }
          });
        }
        return matchedCustomer;
      }

      // If not found by candidate emails, search all customers and match using findPortalUserForCustomer
      const customers = await prisma.customer.findMany({
        where: { ispId: req.ispId, isDeleted: false },
        include: {
          lead: true,
          isp: { select: { id: true, companyName: true } },
          branch: { select: { id: true, name: true } },
          subBranch: { select: { id: true, name: true } },
          subscribedPkg: { include: { packagePlanDetails: true } },
          packagePrice: { include: { packagePlanDetails: true } },
          connectionUsers: { where: { isDeleted: false }, orderBy: { createdAt: 'desc' } },
          portalUser: { select: { id: true, email: true, name: true, profilePicture: true } },
          devices: { orderBy: { createdAt: 'desc' } },
          serviceDetails: true,
          documents: {
            where: { isDeleted: false },
            orderBy: { uploadedAt: 'desc' },
            select: {
              id: true,
              documentType: true,
              fileName: true,
              filePath: true,
              mimeType: true,
              size: true,
              uploadedAt: true,
              customerId: true,
            },
          },
          customerSubscriptions: {
            orderBy: { createdAt: 'desc' },
            take: 3,
            include: { packagePrice: { include: { packagePlanDetails: true } } },
          },
          orders: {
            where: { isDeleted: false },
            orderBy: { orderDate: 'desc' },
            take: 10,
            include: { items: true, packagePrice: { include: { packagePlanDetails: true } } },
          },
          tickets: {
            where: { isDeleted: false },
            orderBy: { createdAt: 'desc' },
            take: 10,
          },
          wifiCredentials: {
            orderBy: { ssidIndex: 'asc' },
          },
          referrals: {
            orderBy: { createdAt: 'desc' },
            take: 20,
          },
          ...extraInclude,
        }
      });

      for (const customer of customers) {
        const portalUser = await findPortalUserForCustomer(prisma, customer);
        if (portalUser && portalUser.id === dbUser.id) {
          // Proactively link customerId to the user
          if (dbUser.customerId !== customer.id) {
            await prisma.user.update({
              where: { id: dbUser.id },
              data: { customerId: customer.id }
            });
          }
          return customer;
        }
      }
    }
  }

  return prisma.customer.findFirst({
    where: {
      ispId: req.ispId,
      isDeleted: false,
      OR: [
        { lead: { email } },
        { connectionUsers: { some: { username: email, isDeleted: false } } },
      ],
    },
    include: {
      lead: true,
      isp: { select: { id: true, companyName: true } },
      branch: { select: { id: true, name: true } },
      subBranch: { select: { id: true, name: true } },
      subscribedPkg: { include: { packagePlanDetails: true } },
      packagePrice: { include: { packagePlanDetails: true } },
      connectionUsers: { where: { isDeleted: false }, orderBy: { createdAt: 'desc' } },
      portalUser: { select: { id: true, email: true, name: true, profilePicture: true } },
      devices: { orderBy: { createdAt: 'desc' } },
      serviceDetails: true,
      documents: {
        where: { isDeleted: false },
        orderBy: { uploadedAt: 'desc' },
        select: {
          id: true,
          documentType: true,
          fileName: true,
          filePath: true,
          mimeType: true,
          size: true,
          uploadedAt: true,
          customerId: true,
        },
      },
      customerSubscriptions: {
        orderBy: { createdAt: 'desc' },
        take: 3,
        include: { packagePrice: { include: { packagePlanDetails: true } } },
      },
      orders: {
        where: { isDeleted: false },
        orderBy: { orderDate: 'desc' },
        take: 10,
        include: { items: true, packagePrice: { include: { packagePlanDetails: true } } },
      },
      tickets: {
        where: { isDeleted: false },
        orderBy: { createdAt: 'desc' },
        take: 10,
      },
      wifiCredentials: {
        orderBy: { ssidIndex: 'asc' },
      },
      referrals: {
        orderBy: { createdAt: 'desc' },
        take: 20,
      },
      ...extraInclude,
    },
  });
}

async function getCustomerOwnedDeviceSerials(prisma, customer) {
  const serials = new Set();
  (customer?.devices || []).forEach((device) => {
    if (device.serialNumber) serials.add(device.serialNumber);
    if (device.ponSerial) serials.add(device.ponSerial);
  });

  const orConditions = [];
  if (customer?.leadId) {
    orConditions.push({ leadId: customer.leadId });
  }
  if (serials.size > 0) {
    orConditions.push({ serialNumber: { in: Array.from(serials) } });
  }

  if (orConditions.length > 0) {
    const tr069Devices = await prisma.tr069Device.findMany({
      where: {
        OR: orConditions,
        ispId: customer.ispId,
        isDeleted: false,
      },
      select: {
        serialNumber: true,
        modelName: true,
        manufacturer: true,
        productClass: true,
        ipAddress: true,
        status: true,
        lastContact: true,
        leadId: true,
      },
    });

    tr069Devices.forEach((device) => {
      if (device.serialNumber) serials.add(device.serialNumber);
    });

    // Proactively link leadId if missing on the device
    if (customer.leadId) {
      const unlinkedDevices = tr069Devices.filter((d) => d.leadId !== customer.leadId);
      if (unlinkedDevices.length > 0) {
        prisma.tr069Device.updateMany({
          where: { serialNumber: { in: unlinkedDevices.map(d => d.serialNumber) } },
          data: { leadId: customer.leadId }
        }).catch(err => console.error("Error linking leadId on tr069Device:", err));
      }
    }

    return { serials: Array.from(serials), tr069Devices };
  }

  return { serials: Array.from(serials), tr069Devices: [] };
}

async function deactivateExpiredCustomers(prisma, ispId) {
  if (!ispId) return 0;

  const expired = await prisma.customerSubscription.findMany({
    where: {
      isActive: true,
      planEnd: { lt: new Date() },
      customer: {
        ispId,
        isDeleted: false,
        status: 'active'
      }
    },
    select: { customerId: true }
  });

  const customerIds = [...new Set(expired.map((item) => item.customerId).filter(Boolean))];
  if (customerIds.length === 0) return 0;

  await prisma.customer.updateMany({
    where: { id: { in: customerIds }, ispId, isDeleted: false, status: 'active' },
    data: { status: 'inactive', onboardStatus: 'expired_package' }
  });

  await prisma.customerServiceConnection.updateMany({
    where: { customerId: { in: customerIds }, status: 'active' },
    data: { status: 'inactive' }
  });

  return customerIds.length;
}

async function assertCustomerOwnsSerial(req, res, next) {
  try {
    const serialNumber = req.params.serialNumber;
    const customer = await findCustomerForAuthenticatedUser(req.prisma, req);
    if (!customer) {
      return res.status(404).json({ success: false, error: 'Customer profile not found for this user.' });
    }

    const { serials } = await getCustomerOwnedDeviceSerials(req.prisma, customer);
    const targetSerial = String(serialNumber || '').trim().toLowerCase();
    const ownsSerial = (serials || []).some(s => String(s || '').trim().toLowerCase() === targetSerial);
    if (!ownsSerial) {
      return res.status(403).json({ success: false, error: 'You do not have access to this device.' });
    }

    req.customerProfile = customer;
    next();
  } catch (err) {
    next(err);
  }
}

function setNepalMidnight(dateInput) {
  const d = dateInput instanceof Date ? new Date(dateInput) : new Date(dateInput || Date.now());
  if (isNaN(d.getTime())) return d;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kathmandu',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(d);
  const getVal = type => parts.find(p => p.type === type)?.value;
  return new Date(`${getVal('year')}-${getVal('month')}-${getVal('day')}T00:00:00+05:45`);
}

/**
 * Compute expiry date from a base date + duration string.
 */
function computeExpiryFromBase(baseDateOrDuration, maybeDuration) {
  let baseDate;
  let durationString;

  const isProbablyDate = (v) => {
    if (v instanceof Date) return true;
    if (typeof v === 'number') return true;
    if (typeof v === 'string') {
      return /^\d{4}-\d{2}-\d{2}/.test(v);
    }
    return false;
  };

  if (baseDateOrDuration === undefined || baseDateOrDuration === null) {
    baseDate = new Date();
    durationString = maybeDuration;
  } else if (isProbablyDate(baseDateOrDuration) && maybeDuration !== undefined) {
    baseDate = new Date(baseDateOrDuration);
    durationString = maybeDuration;
  } else if (isProbablyDate(baseDateOrDuration) && maybeDuration === undefined) {
    baseDate = new Date(baseDateOrDuration);
    durationString = undefined;
  } else {
    baseDate = new Date();
    durationString = String(baseDateOrDuration);
  }

  if (!(baseDate instanceof Date) || isNaN(baseDate.getTime())) {
    baseDate = new Date();
  }

  const date = new Date(baseDate);

  if (!durationString && durationString !== 0) {
    date.setMonth(date.getMonth() + 1);
    return setNepalMidnight(date);
  }

  let s = String(durationString).trim().toLowerCase()
    .replace(/\u00A0/g, ' ')
    .replace(/–|—/g, '-')
    .replace(/\s+/g, ' ');

  const isoMatch = s.match(/^p\s*(\d+)\s*([dmy])$/i);
  if (isoMatch) {
    const v = parseInt(isoMatch[1], 10);
    const u = isoMatch[2].toLowerCase();
    if (u === 'd') { date.setDate(date.getDate() + v); return setNepalMidnight(date); }
    if (u === 'm') { date.setMonth(date.getMonth() + v); return setNepalMidnight(date); }
    if (u === 'y') { date.setFullYear(date.getFullYear() + v); return setNepalMidnight(date); }
  }

  const re = /(\d+)\s*(?:-?\s*)?(d(?:ays?)?|day|m(?:o(?:nths?)?)?|mo|month(?:s)?|months?|y(?:ears?|r)?|yr|year(?:s)?)/i;
  const m = s.match(re);

  if (!m) {
    const anyNum = s.match(/(\d+)/);
    if (anyNum) {
      date.setMonth(date.getMonth() + parseInt(anyNum[1], 10));
      return setNepalMidnight(date);
    }
    date.setMonth(date.getMonth() + 1);
    return setNepalMidnight(date);
  }

  const value = parseInt(m[1], 10);
  let unit = m[2].toLowerCase();

  if (unit.startsWith('d')) unit = 'day';
  else if (unit.startsWith('m')) unit = 'month';
  else if (unit.startsWith('y') || unit === 'yr') unit = 'year';

  if (unit === 'day') date.setDate(date.getDate() + value);
  else if (unit === 'month') date.setMonth(date.getMonth() + value);
  else if (unit === 'year') date.setFullYear(date.getFullYear() + value);

  return setNepalMidnight(date);
}

/**
 * Generate unique PAN number
 */
async function generateUniquePAN(prisma, panNo = null) {
  if (panNo && panNo.trim() !== '') {
    if (!/^\d{9}$/.test(panNo)) {
      console.warn('⚠️ Invalid PAN format, generating new');
      panNo = null;
    } else {
      const existingPAN = await prisma.customer.findFirst({
        where: { panNo: panNo, isDeleted: false }
      });
      if (existingPAN) {
        console.warn('⚠️ PAN already exists, generating new');
        panNo = null;
      }
    }
  }

  if (!panNo) {
    let attempts = 0;
    while (attempts < 20) {
      panNo = (Math.floor(100000000 + Math.random() * 900000000)).toString();
      const existing = await prisma.customer.findFirst({
        where: { panNo: panNo, isDeleted: false }
      });
      if (!existing) return panNo;
      attempts++;
    }
    panNo = Date.now().toString().slice(-9).padStart(9, '0');
  }
  return panNo;
}

/**
 * Generate customer unique ID – uses lead names
 */
async function generateCustomerUniqueId(tx, customerId, firstName = '', lastName = '', membershipCode = 'GEN', branchId = null, subBranchId = null, ispId = null) {
  let settingsObj = {};
  if (ispId) {
    try {
      const settings = await tx.ISPSettings.findMany({
        where: { ispId }
      });
      settingsObj = settings.reduce((acc, s) => {
        acc[s.key] = s.value;
        return acc;
      }, {});
    } catch (e) {
      console.warn("Failed to load ISP settings for customer ID generation:", e);
    }
  }

  // Fetch branch and subBranch codes if needed
  let branchCode = '';
  if (branchId && settingsObj.customerIdIncludeBranch === 'true') {
    try {
      const br = await tx.branch.findUnique({ where: { id: Number(branchId) } });
      if (br) branchCode = br.code || br.name.substring(0, 3).toUpperCase();
    } catch (e) {
      console.warn("Failed to fetch branch code:", e);
    }
  }

  let subBranchCode = '';
  if (subBranchId && settingsObj.customerIdIncludeSubBranch === 'true') {
    try {
      const sb = await tx.branch.findUnique({ where: { id: Number(subBranchId) } });
      if (sb) subBranchCode = sb.code || sb.name.substring(0, 3).toUpperCase();
    } catch (e) {
      console.warn("Failed to fetch sub-branch code:", e);
    }
  }

  // Prefix
  const prefix = settingsObj.hasOwnProperty('customerIdPrefix') ? settingsObj.customerIdPrefix : 'CUS';
  
  // Membership
  const includeMembership = settingsObj.customerIdIncludeMembership !== 'false';
  const memPart = includeMembership ? membershipCode : '';

  // Padding length for ID
  const paddingLen = parseInt(settingsObj.customerIdPaddingLength || '5', 10);
  const paddedId = customerId.toString().padStart(paddingLen, '0');

  // Name part
  let namePart = '';
  if (settingsObj.customerIdIncludeNamePart !== 'false') {
    const nameLen = parseInt(settingsObj.customerIdNamePartLength || '5', 10);
    let nameStr = (firstName || '').substring(0, nameLen).toUpperCase();
    if (nameStr.length < nameLen && lastName) {
      const needed = nameLen - nameStr.length;
      nameStr += lastName.substring(0, needed).toUpperCase();
    }
    if (nameStr.length < nameLen) {
      nameStr = nameStr.padEnd(nameLen, 'X');
    }
    namePart = nameStr;
  }

  // Combine components
  const parts = [];
  if (prefix) parts.push(prefix);
  if (memPart) parts.push(memPart);
  if (branchCode) parts.push(branchCode);
  if (subBranchCode) parts.push(subBranchCode);
  parts.push(paddedId);
  if (namePart) parts.push(namePart);

  return parts.join('-');
}

/**
 * Generate a secure random password
 */
function generateSecurePassword(length = 12) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()';
  let password = '';
  for (let i = 0; i < length; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

/**
 * Generate a unique username – uses lead names
 */
async function generateUniqueUsername(prisma, ispId, firstName, lastName) {
  const base = (firstName + lastName).replace(/[^a-zA-Z0-9]/g, '').toLowerCase().substring(0, 15);
  let username = base;
  let counter = 1;
  while (true) {
    const existing = await prisma.connectionUser.findFirst({
      where: { username, isDeleted: false, ispId }
    });
    if (!existing) break;
    username = base + counter;
    counter++;
    if (counter > 100) username = base + Date.now();
  }
  return username;
}

/**
 * Validate email
 */
function isValidEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

/**
 * Validate phone number (Nepali format approx)
 */
function isValidPhoneNumber(phone) {
  const re = /^(\+977)?\d{9,10}$/;
  return re.test(phone.replace(/\s/g, ''));
}

/**
 * Save documents to database
 */
async function saveCustomerDocuments(prisma, customerId, files, ispId) {
  const documents = [];

  if (files) {
    // Process ID Proof
    if (files.idProof && files.idProof[0]) {
      const doc = await prisma.customerDocument.create({
        data: {
          customerId: customerId,
          documentType: 'idProof',
          fileName: files.idProof[0].originalname,
          filePath: files.idProof[0].path,
          mimeType: files.idProof[0].mimetype,
          size: files.idProof[0].size,
          ispId: ispId
        }
      });
      documents.push(doc);
    }

    // Process Address Proof
    if (files.addressProof && files.addressProof[0]) {
      const doc = await prisma.customerDocument.create({
        data: {
          customerId: customerId,
          documentType: 'addressProof',
          fileName: files.addressProof[0].originalname,
          filePath: files.addressProof[0].path,
          mimeType: files.addressProof[0].mimetype,
          size: files.addressProof[0].size,
          ispId: ispId
        }
      });
      documents.push(doc);
    }

    // Process Photo
    if (files.photo && files.photo[0]) {
      const doc = await prisma.customerDocument.create({
        data: {
          customerId: customerId,
          documentType: 'photo',
          fileName: files.photo[0].originalname,
          filePath: files.photo[0].path,
          mimeType: files.photo[0].mimetype,
          size: files.photo[0].size,
          ispId: ispId
        }
      });
      documents.push(doc);
    }

    // Process Other Documents
    if (files.otherDocuments) {
      for (const file of files.otherDocuments) {
        const doc = await prisma.customerDocument.create({
          data: {
            customerId: customerId,
            documentType: 'other',
            fileName: file.originalname,
            filePath: file.path,
            mimeType: file.mimetype,
            size: file.size,
            ispId: ispId
          }
        });
        documents.push(doc);
      }
    }
  }

  return documents;
}

// ==================== CREATE CUSTOMER ====================

async function createCustomer(req, res, next) {
  const prisma = req.prisma;
  console.log('🔍 [DEBUG] Starting createCustomer');

  try {
    // ---------- Parse incoming form data ----------
    const {
      leadId,
      membershipId,
      branchId,
      subBranchId,
      customerTypeId,
      installedById,
      existingISPId,
      subscribedPkgId,
      idNumber,
      panNumber,
      devices,
      wirelessCredentials,
      customerLoginUsername,
      customerLoginPassword,
      serviceConnection,
      subscribedServices,
      isFree,
      freeCustomerSecretKey,
    } = req.body;

    // Parse JSON fields (same as before)
    let parsedDevices = [];
    let parsedWirelessCredentials = [];
    let parsedServiceConnection = {};
    let parsedSubscribedServices = [];
    let finalWirelessCredentials = [];

    try {
      if (devices) parsedDevices = typeof devices === 'string' ? JSON.parse(devices) : devices;
      if (wirelessCredentials) parsedWirelessCredentials = typeof wirelessCredentials === 'string' ? JSON.parse(wirelessCredentials) : wirelessCredentials;
      if (serviceConnection) parsedServiceConnection = typeof serviceConnection === 'string' ? JSON.parse(serviceConnection) : serviceConnection;
      if (subscribedServices) parsedSubscribedServices = typeof subscribedServices === 'string' ? JSON.parse(subscribedServices) : subscribedServices;
    } catch (e) {
      return res.status(400).json({ success: false, error: 'Invalid JSON format in one of the fields' });
    }

    // Validation
    const errors = [];
    if (!leadId) errors.push('leadId is required');
    if (!idNumber) errors.push('idNumber is required');
    if (!customerTypeId) errors.push('customerTypeId is required');
    if (errors.length > 0) {
      return res.status(400).json({ success: false, error: 'Validation failed', details: errors });
    }

    // Validate Free Customer parameters if isFree is true
    const parsedIsFree = isFree === true || isFree === 'true';
    if (parsedIsFree) {
      const role = String(req.user?.role || '').toLowerCase();
      const isAdmin = role === 'admin' || role === 'isp_admin' || role === 'administrator' || role.startsWith('global ');
      if (!isAdmin) {
        return res.status(403).json({ success: false, error: 'Only administrators can create a Free customer.' });
      }

      const secretSetting = await prisma.iSPSettings.findFirst({
        where: { key: 'freeCustomerSecretKey', ispId: req.ispId }
      });
      const systemSecret = secretSetting ? secretSetting.value : 'admin123';
      if (freeCustomerSecretKey !== systemSecret) {
        return res.status(400).json({ success: false, error: 'Invalid Free Customer Secret Key.' });
      }
    }

    // Fetch lead
    const lead = await prisma.lead.findFirst({
      where: { id: Number(leadId), isDeleted: false, ispId: req.ispId },
    });
    if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });

    // Check if an existing customer record exists for this lead (active or deleted)
    const existingCustomerForLead = await prisma.customer.findFirst({
      where: { leadId: Number(leadId), ispId: req.ispId }
    });

    if (existingCustomerForLead) {
      if (!existingCustomerForLead.isDeleted) {
        return res.status(409).json({ success: false, error: 'Customer already exists for this lead' });
      }
      // If customer was deleted, we allow reactivation/re-onboarding!
    } else if (lead.convertedToCustomer) {
      const activeCustomer = await prisma.customer.findFirst({
        where: { leadId: Number(leadId), isDeleted: false }
      });
      if (activeCustomer) {
        return res.status(409).json({ success: false, error: 'Lead already converted' });
      }
    }

    if (lead.status !== 'qualified' && !existingCustomerForLead?.isDeleted) {
      return res.status(400).json({ success: false, error: 'Only qualified leads can be converted to customers' });
    }

    const effectiveBranchId = branchId || lead.branchId;
    const effectiveSubBranchId = subBranchId || lead.subBranchId;

    const requirementRows = await prisma.iSPSettings.findMany({
      where: { ispId: req.ispId, key: { in: ['customerDocumentsRequired', 'customerDeviceRequired', 'fiberOnuRequired'] } }
    });
    const requirements = Object.fromEntries(requirementRows.map(row => [row.key, String(row.value).toLowerCase() === 'true']));
    const uploadedFileCount = req.files ? Object.values(req.files).reduce((total, files) => total + (Array.isArray(files) ? files.length : 0), 0) : 0;
    if (requirements.customerDocumentsRequired && uploadedFileCount === 0) {
      return res.status(400).json({ success: false, error: 'Customer documents are required by system settings.' });
    }
    if (requirements.customerDeviceRequired && parsedDevices.length === 0) {
      return res.status(400).json({ success: false, error: 'A customer device is required by system settings.' });
    }
    if (requirements.fiberOnuRequired && parsedServiceConnection.connectionType === 'fiber') {
      const hasOnu = parsedDevices.some(device => ['ONU', 'ONT'].includes(String(device.deviceType || device.type || '').toUpperCase()) && String(device.serialNumber || device.ponSerial || '').trim());
      if (!hasOnu) return res.status(400).json({ success: false, error: 'An ONU/ONT with a serial number is required for Fiber customers.' });
    }

    if (parsedServiceConnection.connectionType === 'infra_share') {
      const devicePolicyBranchId = Number(effectiveSubBranchId || effectiveBranchId || 0);
      if (devicePolicyBranchId) {
        const devicePolicy = await prisma.branch.findFirst({
          where: { id: devicePolicyBranchId, ispId: req.ispId, isDeleted: false },
          select: { infraShareDeviceRequired: true }
        });
        if (devicePolicy?.infraShareDeviceRequired && parsedDevices.length === 0) {
          return res.status(400).json({ success: false, error: 'A device is required for Infra Share customers in the selected branch.' });
        }
      }
    }

    // Validate duplicate Mobile and Email based on CustomerType rules
    const targetTypeId = customerTypeId ? Number(customerTypeId) : null;
    const cleanLeadPhone = (lead.phoneNumber && String(lead.phoneNumber).trim()) || null;
    const cleanLeadEmail = (lead.email && String(lead.email).trim()) || null;

    if (targetTypeId) {
      const cType = await prisma.customerType.findUnique({
        where: { id: targetTypeId }
      });
      if (cType) {
        if (cType.allowDuplicateMobile === false && cleanLeadPhone) {
          const dupMobile = await prisma.customer.findFirst({
            where: {
              ...(existingCustomerForLead?.id ? { id: { not: existingCustomerForLead.id } } : {}),
              isDeleted: false,
              lead: { phoneNumber: cleanLeadPhone }
            }
          });
          if (dupMobile) {
            return res.status(400).json({ success: false, error: 'Mobile number already exists for another customer. Duplication is disabled for this customer type.' });
          }
        }
        if (cType.allowDuplicateEmail === false && cleanLeadEmail) {
          const dupEmail = await prisma.customer.findFirst({
            where: {
              ...(existingCustomerForLead?.id ? { id: { not: existingCustomerForLead.id } } : {}),
              isDeleted: false,
              lead: { email: cleanLeadEmail }
            }
          });
          if (dupEmail) {
            return res.status(400).json({ success: false, error: 'Email already exists for another customer. Duplication is disabled for this customer type.' });
          }
        }
      }
    }

    const selectedSubscribedPkgId = subscribedPkgId || lead.interestedPackageId;
    if (!selectedSubscribedPkgId) {
      return res.status(400).json({ success: false, error: 'subscribedPkgId is required' });
    }

    // Validate subscribed package. New customers get a fixed 3-day test period
    // on this package instead of selecting a separate trial package.
    const subscribedPackage = await prisma.packagePrice.findFirst({
      where: { id: Number(selectedSubscribedPkgId), isActive: true, isDeleted: false, isTrial: false, ispId: req.ispId },
      include: { oneTimeCharges: { where: { isDeleted: false } } },
    });
    if (!subscribedPackage) {
      return res.status(400).json({ success: false, error: 'Invalid subscribed package selected' });
    }

    const requestedLoginUsername = normalizeCustomerLoginUsername(customerLoginUsername);
    if (requestedLoginUsername) {
      const requestedLoginEmail = toCustomerLoginEmail(requestedLoginUsername);
      const existingLogin = await prisma.user.findUnique({ where: { email: requestedLoginEmail } });
      if (existingLogin && (!existingCustomerForLead || existingLogin.customerId !== existingCustomerForLead.id)) {
        return res.status(409).json({
          success: false,
          error: 'Customer login username already exists',
          details: `The username "${requestedLoginUsername}" is already used by another login account.`
        });
      }
    }

    // Data preparation
    const panCandidate = panNumber || (existingCustomerForLead?.panNo ? existingCustomerForLead.panNo : null);
    const finalPan = await generateUniquePAN(prisma, panCandidate);
    const membership = membershipId
      ? await prisma.membership.findFirst({ where: { id: Number(membershipId), ispId: req.ispId } })
      : null;
    const membershipCode = membership?.code || 'GEN';

    // Transaction
    let createdCustomer;
    let subscription;
    let order;
    let customerLogin = null;
    const skippedDevices = []; // track duplicates

    await prisma.$transaction(async (tx) => {
      // Get settings for auto-generation
      const autoGenSettings = await tx.iSPSettings.findMany({
        where: { ispId: req.ispId ? Number(req.ispId) : null, key: { in: ['autoGenerateRadius', 'autoGenerateCustomerLogin'] } }
      });
      const settingsObj = Object.fromEntries(autoGenSettings.map(s => [s.key, s.value]));
      const autoGenRadius = settingsObj.autoGenerateRadius === 'true';
      const autoGenLogin = settingsObj.autoGenerateCustomerLogin === 'true';

      // 1. Create or Reactivate Customer
      const customerPayload = {
        panNo: finalPan,
        idNumber: idNumber.trim(),
        ...(membershipId ? { membership: { connect: { id: Number(membershipId) } } } : { membership: { disconnect: true } }),
        ...(effectiveBranchId ? { branch: { connect: { id: Number(effectiveBranchId) } } } : {}),
        ...(effectiveSubBranchId ? { subBranch: { connect: { id: Number(effectiveSubBranchId) } } } : {}),
        ...(targetTypeId ? { customerType: { connect: { id: targetTypeId } } } : {}),
        ...(req.ispId ? { isp: { connect: { id: Number(req.ispId) } } } : {}),
        ...(installedById ? { installedBy: { connect: { id: Number(installedById) } } } : {}),
        ...(existingISPId ? { existingISP: { connect: { id: Number(existingISPId) } } } : {}),
        packagePrice: { connect: { id: subscribedPackage.id } },
        subscribedPkg: { connect: { id: subscribedPackage.id } },
        status: 'draft',
        onboardStatus: 'pending',
        isFree: parsedIsFree,
        isDeleted: false,
        updatedAt: new Date()
      };

      if (existingCustomerForLead && existingCustomerForLead.isDeleted) {
        createdCustomer = await tx.customer.update({
          where: { id: existingCustomerForLead.id },
          data: customerPayload
        });
      } else {
        createdCustomer = await tx.customer.create({
          data: {
            lead: { connect: { id: lead.id } },
            ...customerPayload
          }
        });
      }

      // 2. Generate unique customer ID (preserve if already exists, or generate)
      let customerUniqueId = (existingCustomerForLead && existingCustomerForLead.customerUniqueId) || null;
      if (!customerUniqueId) {
        customerUniqueId = await generateCustomerUniqueId(tx, createdCustomer.id, lead.firstName, lead.lastName, membershipCode, effectiveBranchId, effectiveSubBranchId, req.ispId);
        createdCustomer = await tx.customer.update({
          where: { id: createdCustomer.id },
          data: { customerUniqueId },
        });
      } else {
        createdCustomer = await tx.customer.update({
          where: { id: createdCustomer.id },
          data: { customerUniqueId },
        });
      }

      // Populate finalWirelessCredentials
      finalWirelessCredentials.push(...parsedWirelessCredentials);
      if (finalWirelessCredentials.length === 0 && autoGenRadius) {
        finalWirelessCredentials.push({
          username: customerUniqueId.toLowerCase(),
          password: generateSecurePassword(10)
        });
      }

      // Check if we should create a login user (if explicitly provided or if autoGenLogin is enabled)
      const shouldCreateLogin = Boolean(requestedLoginUsername || autoGenLogin);

      if (shouldCreateLogin) {
        const loginUsername = requestedLoginUsername || normalizeCustomerLoginUsername(customerUniqueId);
        const loginEmail = toCustomerLoginEmail(loginUsername);
        const loginPassword = String(customerLoginPassword || '').trim() || generateSecurePassword(10);

        if (loginEmail) {
          const customerRole = await tx.role.upsert({
            where: { name: 'Customer' },
            update: { isActive: true },
            create: { name: 'Customer', isActive: true },
          });

          // Check if there is already a portal user linked to this customer
          const existingUserForCustomer = await tx.user.findUnique({
            where: { customerId: createdCustomer.id }
          });
          // Check if there is a portal user with this email
          const existingUserWithEmail = await tx.user.findUnique({
            where: { email: loginEmail }
          });

          if (existingUserWithEmail && existingUserForCustomer && existingUserWithEmail.id !== existingUserForCustomer.id) {
            // Email is already used by a different user
            throw new Error('Customer login username already exists');
          } else if (existingUserWithEmail && !existingUserForCustomer) {
            // Email matches an unlinked or existing user
            if (existingUserWithEmail.customerId && existingUserWithEmail.customerId !== createdCustomer.id) {
              throw new Error('Customer login username already exists');
            }
            await tx.user.update({
              where: { id: existingUserWithEmail.id },
              data: {
                customerId: createdCustomer.id,
                roleId: customerRole.id,
                status: 'active',
                isDeleted: false,
                passwordHash: await bcrypt.hash(loginPassword, 10),
                name: `${lead.firstName || ''} ${lead.lastName || ''}`.trim() || customerUniqueId,
                branchId: effectiveBranchId ? Number(effectiveBranchId) : null,
                ispId: req.ispId ? Number(req.ispId) : null,
                updatedAt: new Date()
              }
            });
          } else if (existingUserForCustomer) {
            // Re-activate and update the existing portal user for this customer
            await tx.user.update({
              where: { id: existingUserForCustomer.id },
              data: {
                email: loginEmail,
                roleId: customerRole.id,
                status: 'active',
                isDeleted: false,
                passwordHash: await bcrypt.hash(loginPassword, 10),
                name: `${lead.firstName || ''} ${lead.lastName || ''}`.trim() || customerUniqueId,
                branchId: effectiveBranchId ? Number(effectiveBranchId) : null,
                ispId: req.ispId ? Number(req.ispId) : null,
                updatedAt: new Date()
              }
            });
          } else {
            // Brand new portal user
            await tx.user.create({
              data: {
                email: loginEmail,
                passwordHash: await bcrypt.hash(loginPassword, 10),
                name: `${lead.firstName || ''} ${lead.lastName || ''}`.trim() || customerUniqueId,
                roleId: customerRole.id,
                status: 'active',
                isDeleted: false,
                ispId: req.ispId ? Number(req.ispId) : null,
                branchId: effectiveBranchId ? Number(effectiveBranchId) : null,
                customerId: createdCustomer.id,
              },
            });
          }

          customerLogin = {
            username: loginUsername,
            loginEmail,
            password: loginPassword,
            generatedPassword: !String(customerLoginPassword || '').trim(),
          };
        }
      } else if (existingCustomerForLead) {
        // If login not requested but reactivating existing customer, ensure their existing portal user is un-suspended
        await tx.user.updateMany({
          where: { customerId: createdCustomer.id },
          data: { status: 'active', isDeleted: false, updatedAt: new Date() }
        });
      }

      // 3. Create Devices – handle duplicates or reactivations individually
      if (parsedDevices.length > 0) {
        for (const device of parsedDevices) {
          try {
            // Check if serial or MAC already exists
            const existing = await tx.customerDevice.findFirst({
              where: {
                OR: [
                  { serialNumber: device.serialNumber },
                  { macAddress: device.macAddress },
                ].filter(cond => cond.serialNumber || cond.macAddress)
              },
              include: { customer: true }
            });

            if (existing) {
              if (existing.customerId === createdCustomer.id || existing.customer?.isDeleted) {
                // Update / reassign this device record to the customer
                await tx.customerDevice.update({
                  where: { id: existing.id },
                  data: {
                    customerId: createdCustomer.id,
                    deviceType: device.deviceType || existing.deviceType || 'ONT',
                    brand: device.brand || existing.brand,
                    model: device.model || existing.model,
                    serialNumber: device.serialNumber || existing.serialNumber,
                    macAddress: device.macAddress || existing.macAddress,
                    ponSerial: device.ponSerial || device.serialNumber || existing.ponSerial,
                    ponVendorIdIncluded: device.ponVendorIdIncluded !== false,
                    provisioningStatus: 'pending',
                    updatedAt: new Date()
                  }
                });
              } else {
                skippedDevices.push({
                  serial: device.serialNumber,
                  mac: device.macAddress,
                  reason: 'Duplicate serial or MAC already assigned to another active customer'
                });
                continue; // skip this device
              }
            } else {
              await tx.customerDevice.create({
                data: {
                  customerId: createdCustomer.id,
                  deviceType: device.deviceType || 'ONT',
                  brand: device.brand,
                  model: device.model,
                  serialNumber: device.serialNumber,
                  macAddress: device.macAddress,
                  ponSerial: device.ponSerial || device.serialNumber || null,
                  ponVendorIdIncluded: device.ponVendorIdIncluded !== false,
                  provisioningStatus: 'pending',
                },
              });
            }

            let inventoryItem = null;
            if (device.inventoryItemId) {
              inventoryItem = await tx.InventoryItem.findFirst({
                where: {
                  id: Number(device.inventoryItemId),
                  ispId: req.ispId,
                  OR: [
                    { status: 'ASSIGNED_TO_USER', userId: req.user.id },
                    { customerId: createdCustomer.id }
                  ]
                },
              });

              if (!inventoryItem) {
                const anyItem = await tx.InventoryItem.findFirst({
                  where: { id: Number(device.inventoryItemId), ispId: req.ispId }
                });
                if (anyItem) {
                  inventoryItem = anyItem;
                }
              }
            }

            if (inventoryItem) {
              await tx.InventoryItem.update({
                where: { id: inventoryItem.id },
                data: {
                  status: 'ASSIGNED_TO_CUSTOMER',
                  customerId: createdCustomer.id,
                  userId: null,
                  updatedAt: new Date(),
                },
              });

              await tx.InventoryLog.create({
                data: {
                  inventoryItemId: inventoryItem.id,
                  fromStatus: inventoryItem.status,
                  toStatus: 'ASSIGNED_TO_CUSTOMER',
                  entityType: 'CUSTOMER',
                  toEntityId: createdCustomer.id,
                  actionByUserId: req.user.id,
                  note: `Assigned to customer ${createdCustomer.customerUniqueId}`,
                },
              });
            }

            // Link TR069 device to leadId if device exists
            const tr069Serials = [...new Set([device.serialNumber, device.ponSerial].filter(Boolean))];
            if (tr069Serials.length > 0 && lead.id) {
              await tx.tr069Device.updateMany({
                where: { ispId: req.ispId, serialNumber: { in: tr069Serials } },
                data: { leadId: lead.id, updatedAt: new Date() }
              });

              // Reactivate ONT if exists in inventory/OLT cache
              await tx.oNT.updateMany({
                where: { serialNumber: { in: tr069Serials } },
                data: { isDeleted: false, status: 'online', updatedAt: new Date() }
              });
            }
          } catch (deviceErr) {
            // Log but don't stop the whole transaction
            console.warn('Device creation error (skipped):', deviceErr.message);
            skippedDevices.push({
              serial: device.serialNumber,
              mac: device.macAddress,
              reason: deviceErr.message
            });
          }
        }
      }

      // 4. Create Service Connection – only store fields that exist in your schema
      if (Object.keys(parsedServiceConnection).length > 0) {
        // Clean up previous deleted service connection if reactivating
        await tx.customerServiceConnection.deleteMany({
          where: { customerId: createdCustomer.id }
        });

        await tx.customerServiceConnection.create({
          data: {
            customerId: createdCustomer.id,
            oltId: parsedServiceConnection.oltId ? Number(parsedServiceConnection.oltId) : null,
            splitterId: parsedServiceConnection.splitterId ? Number(parsedServiceConnection.splitterId) : null,
            oltPort: parsedServiceConnection.oltPort?.toString(),
            splitterPort: parsedServiceConnection.splitterPort?.toString(),
            vlanId: parsedServiceConnection.vlanIds ? parsedServiceConnection.vlanIds.join(',') : null,
            connectionType: parsedServiceConnection.connectionType || 'fiber',
            status: 'pending',
          },
        });
      }

      // 5. Connection Users
      for (const cu of finalWirelessCredentials) {
        if (cu.username && cu.password) {
          const existingConnUser = await tx.connectionUser.findFirst({
            where: { username: cu.username }
          });
          if (existingConnUser) {
            if (existingConnUser.customerId === createdCustomer.id || existingConnUser.isDeleted) {
              await tx.connectionUser.update({
                where: { id: existingConnUser.id },
                data: {
                  customerId: createdCustomer.id,
                  password: cu.password,
                  branchId: effectiveBranchId ? Number(effectiveBranchId) : null,
                  ispId: req.ispId ? Number(req.ispId) : null,
                  isActive: true,
                  isDeleted: false,
                  updatedAt: new Date()
                }
              });
            } else {
              throw new Error(`Connection username "${cu.username}" already in use by another customer`);
            }
          } else {
            await tx.connectionUser.create({
              data: {
                customerId: createdCustomer.id,
                username: cu.username,
                password: cu.password,
                branchId: effectiveBranchId ? Number(effectiveBranchId) : null,
                ispId: req.ispId ? Number(req.ispId) : null,
                isActive: true,
                isDeleted: false,
              },
            });
          }
        }
      }

      // 6. Optional free test subscription based on master settings.
      const [, autoTrialSetting, trialSetting] = await Promise.all([
        tx.iSPSettings.findFirst({ where: { key: 'pushTrialPackageToAccount', ispId: req.ispId } }),
        tx.iSPSettings.findFirst({ where: { key: 'autoTrialEnabled', ispId: req.ispId } }),
        tx.iSPSettings.findFirst({ where: { key: 'trialDurationDays', ispId: req.ispId } })
      ]);
      const autoTrialEnabled = autoTrialSetting
        ? autoTrialSetting.value !== 'false'
        : true;

      if (autoTrialEnabled) {
        const parsedTrialDays = trialSetting ? parseInt(trialSetting.value, 10) : 3;
        const trialDays = Number.isFinite(parsedTrialDays) && parsedTrialDays > 0 ? parsedTrialDays : 3;
        const testStart = setNepalMidnight(new Date());
        const testEnd = setNepalMidnight(new Date(testStart.getTime() + trialDays * 24 * 60 * 60 * 1000));

        // Clean up previous subscriptions if reactivating customer
        await tx.customerSubscription.updateMany({
          where: { customerId: createdCustomer.id },
          data: { isActive: false, isInvoicing: false }
        });

        subscription = await tx.customerSubscription.create({
          data: {
            customer: { connect: { id: createdCustomer.id } },
            packagePrice: { connect: { id: subscribedPackage.id } },
            planStart: testStart,
            planEnd: testEnd,
            isTrial: true,
            isActive: true,
            isInvoicing: false,
          },
        });

        // A trial is subscription state, not a billable event. Keep the package
        // on the subscription for provisioning/display, but do not create a
        // zero-value order or package items. The first paid activation creates
        // the first order and flips customer.isRechargeable.
        order = null;
      }

      // 8. Update lead
      await tx.lead.update({
        where: { id: lead.id },
        data: {
          isDeleted: false,
          isActive: true,
          status: 'converted',
          convertedToCustomer: true,
          convertedAt: new Date()
        },
      });

      await logAudit(tx, req.user.id, 'CUSTOMER_CREATE', { id: createdCustomer.id, customerUniqueId: customerUniqueId, customerTypeId: targetTypeId }, req);
    });

    // Sync to Radius during new customer creation
    if (finalWirelessCredentials.length > 0) {
      try {
        const { RadiusClient } = require('../services/radiusClient');
        const radius = await RadiusClient.create(req.ispId);
        
        let radiusGroupName = '';
        if (subscribedPackage) {
          radiusGroupName = subscribedPackage.packagePlanDetails?.planCode ||
                            subscribedPackage.packagePlanDetails?.planName ||
                            subscribedPackage.packageName ||
                            '';
        }
        
        const expiryDate = subscription?.planEnd ? formatRadiusExpiration(subscription.planEnd) : null;
        const attributes = {};
        if (expiryDate) attributes.Expiration = expiryDate;

        let selectedNasName = null;
        if (createdCustomer.nasId || req.body.nasId) {
          const nasRecord = await prisma.nas.findFirst({
            where: { id: Number(createdCustomer.nasId || req.body.nasId), ispId: req.ispId, isActive: true, isDeleted: false }
          });
          if (nasRecord) selectedNasName = nasRecord.nasname;
        }
        if (!selectedNasName) {
          const defaultNas = await prisma.nas.findFirst({
            where: { ispId: req.ispId, isActive: true, isDeleted: false },
            orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }]
          });
          if (defaultNas) selectedNasName = defaultNas.nasname;
        }
        if (selectedNasName) {
          attributes['NAS-IP-Address'] = selectedNasName;
        }

        const groups = radiusGroupName ? [radiusGroupName] : [];

        // Get Service ID
        const getServiceIdByCode = async (code) => {
          const ispService = await prisma.iSPService.findFirst({
            where: {
              ispId: req.ispId,
              isActive: true,
              isDeleted: false,
              service: { code: code, isActive: true, isDeleted: false },
            },
            include: { service: true },
          });
          return ispService?.service?.id;
        };
        const serviceId = await getServiceIdByCode('RADIUS');

        let provisioningSucceeded = false;
        for (const cu of finalWirelessCredentials) {
          if (cu.username && cu.password) {
            const result = await radius.createUser(cu.username, cu.password, attributes, groups);
            provisioningSucceeded = true;

            try {
              await radius.sendCoA(cu.username, { action: 'disconnect' });
            } catch (err) {
              console.warn(`[RADIUS CREATE] sendCoA disconnect failed: ${err.message}`);
            }

            if (serviceId) {
              await prisma.customerSubscribedService.upsert({
                where: { customerId_serviceId: { customerId: createdCustomer.id, serviceId } },
                update: { status: 'active', serviceData: result },
                create: { customerId: createdCustomer.id, serviceId, status: 'active', serviceData: result }
              });
            }
          }
        }

        if (provisioningSucceeded) {
          await prisma.customer.update({
            where: { id: createdCustomer.id },
            data: { status: 'active', onboardStatus: 'fully_onboarded' }
          });
          createdCustomer.status = 'active';
          createdCustomer.onboardStatus = 'fully_onboarded';
        }
      } catch (e) {
        console.error('Radius sync failed during customer creation:', e.message);
      }
    }

    // ---------- Documents ----------
    if (req.files) {
      try {
        await saveCustomerDocuments(prisma, createdCustomer.id, req.files, req.ispId);
      } catch (err) {
        console.error('⚠️ Document saving failed:', err);
      }
    }

    // ---------- Build response ----------
    const customerName = `${lead.firstName || ''} ${lead.lastName || ''}`.trim() || `Customer ${createdCustomer.id}`;
    const { getRequestBaseUrl } = require('../utils/requestBaseUrl');
    const customerTemplateData = {
      customerName,
      customerUniqueId: createdCustomer.customerUniqueId,
      packageName: subscribedPackage?.packageName || 'Package',
      planStart: subscription?.planStart ? new Date(subscription.planStart).toLocaleDateString() : '',
      planEnd: subscription?.planEnd ? new Date(subscription.planEnd).toLocaleDateString() : '',
      // Welcome emails contain subscriber portal credentials, never RADIUS /
      // wireless credentials. customerLogin also contains generated defaults.
      username: customerLogin?.username || '',
      password: customerLogin?.password || '',
      loginUrl: getRequestBaseUrl(req),
      phoneNumber: lead.phoneNumber || ''
    };

    if (lead.email) {
      const { enqueueJob } = require('../utils/backgroundQueue');
      enqueueJob(`new connection email for customer ${createdCustomer.id}`, async () => {
        const mailHelper = require('../utils/mailHelper');
        const { renderTemplate, textToHtml } = require('../utils/templateHelper');
        const rendered = await renderTemplate(req.ispId, 'EMAIL', 'customer_new_connection', customerTemplateData, {
          subject: 'Customer Account Created',
          body: `Dear ${customerName},\n\nYour customer account has been created successfully.\n\nCustomer ID: ${createdCustomer.customerUniqueId}`
        }, req.prisma);
        const mailResult = await mailHelper.sendMail(req.ispId, {
          to: lead.email,
          subject: rendered.subject,
          html: textToHtml(rendered.body)
        }, { ignoreNotificationSetting: true });
        if (!mailResult?.success) {
          console.warn('[customer.controller] customer_new_connection email was not accepted by SMTP', {
            ispId: req.ispId,
            customerId: createdCustomer.id,
            to: lead.email,
            result: mailResult
          });
        }
      });
    }

    if (lead.phoneNumber) {
      try {
        console.log('[customer.controller] Dispatching customer_new_connection SMS', {
          ispId: req.ispId,
          customerId: createdCustomer.id,
          phone: lead.phoneNumber
        });
        const smsHelper = require('../utils/smsHelper');
        const smsResult = await smsHelper.sendEventSms(req.ispId, 'customer_new_connection', customerTemplateData);
        if (!smsResult?.success) {
          console.warn('[customer.controller] customer_new_connection SMS was not accepted by provider', {
            ispId: req.ispId,
            customerId: createdCustomer.id,
            phone: lead.phoneNumber,
            result: smsResult
          });
        } else {
          console.log('[customer.controller] customer_new_connection SMS dispatch finished', {
            ispId: req.ispId,
            customerId: createdCustomer.id,
            phone: lead.phoneNumber,
            result: smsResult
          });
        }
      } catch (err) {
        console.error('Failed to send customer creation SMS:', err.message);
      }
    }

    const response = {
      success: true,
      customer: {
        id: createdCustomer.id,
        customerUniqueId: createdCustomer.customerUniqueId,
        name: customerName,
        status: createdCustomer.status,
        onboardStatus: createdCustomer.onboardStatus,
      },
      subscription: subscription ? {
        id: subscription.id,
        planStart: subscription.planStart,
        planEnd: subscription.planEnd,
      } : null,
      order: order ? {
        id: order.id,
        totalAmount: order.totalAmount,
      } : null,
      customerLogin,
      message: 'Customer created successfully in draft status',
    };

    // If any devices were skipped, include that info
    if (skippedDevices.length > 0) {
      response.warning = `${skippedDevices.length} device(s) were skipped due to duplicates.`;
      response.skippedDevices = skippedDevices;
    }

    return res.status(201).json(response);

  } catch (err) {
    console.error('❌ Final error in createCustomer:', err);
    // Handle Prisma unique errors
    if (err.code === 'P2002') {
      return res.status(409).json({
        success: false,
        error: 'Duplicate value',
        details: `A record with this ${err.meta?.target} already exists.`,
      });
    }
    if (err.message === 'Customer login username already exists') {
      return res.status(409).json({
        success: false,
        error: 'Customer login username already exists',
        details: 'Choose another customer login username.'
      });
    }
    return res.status(500).json({
      success: false,
      error: 'Failed to create customer',
      details: err.message,
    });
  }
}

function normalizeCustomerLoginUsername(username) {
  return String(username || '').trim().replace(/\s+/g, '').toLowerCase();
}

function toCustomerLoginEmail(username) {
  const normalized = normalizeCustomerLoginUsername(username);
  if (!normalized) return null;
  return normalized;
}

function isValidPortalLoginIdentifier(value) {
  const normalized = normalizeCustomerLoginUsername(value);
  if (!normalized) return false;
  if (normalized.includes('@')) return isValidEmail(normalized);
  return /^[a-z0-9._+-]{2,100}$/.test(normalized);
}

function getCustomerPortalLoginEmail(customer) {
  const leadEmail = normalizeCustomerLoginUsername(customer?.lead?.email);
  if (leadEmail && isValidEmail(leadEmail)) return leadEmail;
  const loginUsername = normalizeCustomerLoginUsername(customer?.customerUniqueId || `customer-${customer?.id}`);
  return toCustomerLoginEmail(loginUsername);
}

async function getCustomerRole(prisma) {
  return prisma.role.upsert({
    where: { name: 'Customer' },
    update: { isActive: true },
    create: { name: 'Customer', isActive: true },
  });
}

async function findPortalUserForCustomer(prisma, customer) {
  // Try finding by explicit customerId field first
  const explicit = await prisma.user.findFirst({
    where: {
      customerId: customer.id,
      ispId: customer.ispId,
      isDeleted: false
    },
    select: {
      id: true,
      email: true,
      name: true,
      profilePicture: true,
      status: true,
      createdAt: true,
      updatedAt: true
    }
  });
  if (explicit) return explicit;

  // Fallback to matching candidate emails (to migrate old accounts)
  const customerRole = await getCustomerRole(prisma);
  const candidateEmails = [
    getCustomerPortalLoginEmail(customer),
    toCustomerLoginEmail(customer?.customerUniqueId),
    customer?.lead?.email && normalizeCustomerLoginUsername(customer.lead.email)
  ].filter(Boolean);

  const exact = await prisma.user.findFirst({
    where: {
      ispId: customer.ispId,
      isDeleted: false,
      roleId: customerRole.id,
      email: { in: [...new Set(candidateEmails)] }
    },
    select: {
      id: true,
      email: true,
      name: true,
      profilePicture: true,
      status: true,
      createdAt: true,
      updatedAt: true
    }
  });
  if (exact) {
    // Proactively link the customerId to migrate the account!
    await prisma.user.update({
      where: { id: exact.id },
      data: { customerId: customer.id }
    });
    return exact;
  }

  const fullName = `${customer?.lead?.firstName || ''} ${customer?.lead?.lastName || ''}`.trim();
  if (!fullName) return null;

  const byName = await prisma.user.findFirst({
    where: {
      ispId: customer.ispId,
      isDeleted: false,
      roleId: customerRole.id,
      name: fullName
    },
    select: {
      id: true,
      email: true,
      name: true,
      profilePicture: true,
      status: true,
      createdAt: true,
      updatedAt: true
    }
  });

  if (byName) {
    // Proactively link the customerId to migrate the account!
    await prisma.user.update({
      where: { id: byName.id },
      data: { customerId: customer.id }
    });
    return byName;
  }

  return null;
}

async function upsertRadiusPassword(ispId, username, password) {
  const client = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, ispId);
  const entries = await client.getRadcheckByUsername(username);
  const passwordEntry = Array.isArray(entries)
    ? entries.find((entry) => ['Cleartext-Password', 'User-Password', 'Password'].includes(entry.attribute))
    : null;

  if (passwordEntry) {
    return client.updateRadcheck(passwordEntry.id, { value: password, op: passwordEntry.op || ':=' });
  }

  return client.createRadcheck({
    username,
    attribute: 'Cleartext-Password',
    op: ':=',
    value: password
  });
}

async function renameRadiusUsername(ispId, oldUsername, newUsername) {
  const client = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, ispId);
  const [radcheck, radreply, radusergroup, destinationRadcheck] = await Promise.all([
    client.getRadcheckByUsername(oldUsername),
    client.getRadreply().then((entries) => Array.isArray(entries) ? entries.filter((entry) => entry.username === oldUsername) : []),
    client.getRadusergroupByUsername(oldUsername),
    client.getRadcheckByUsername(newUsername),
  ]);
  const updated = [];
  const operations = [
    ...(Array.isArray(radcheck) ? radcheck : []).map((entry) => ({ method: 'updateRadcheck', id: entry.id })),
    ...(Array.isArray(radreply) ? radreply : []).map((entry) => ({ method: 'updateRadreply', id: entry.id })),
    ...(Array.isArray(radusergroup) ? radusergroup : []).map((entry) => ({ method: 'updateRadusergroup', id: entry.id })),
  ];

  if (operations.length === 0) throw new Error(`Radius user '${oldUsername}' was not found`);
  if (Array.isArray(destinationRadcheck) && destinationRadcheck.length > 0) {
    throw new Error(`Radius username '${newUsername}' already exists`);
  }

  try {
    for (const operation of operations) {
      await client[operation.method](operation.id, { username: newUsername });
      updated.push(operation);
    }
  } catch (error) {
    await Promise.allSettled(updated.map((operation) => client[operation.method](operation.id, { username: oldUsername })));
    throw error;
  }

  return { radcheck: radcheck.length, radreply: radreply.length, radusergroup: radusergroup.length };
}

async function getRealtimeNetworkStatus(prisma, customer) {
  let primaryDevice = null;
  let ontRealtimeStatus = 'offline';
  let radiusRealtimeStatus = 'offline';
  let radiusAccounting = null;

  try {
    const { serials, tr069Devices } = await getCustomerOwnedDeviceSerials(prisma, customer);
    const assignedSerials = new Set((customer?.devices || [])
      .flatMap(device => [device.serialNumber, device.ponSerial])
      .filter(Boolean)
      .map(serial => String(serial).trim().toUpperCase()));
    primaryDevice = tr069Devices.find(device => assignedSerials.has(String(device.serialNumber || '').trim().toUpperCase()))
      || (assignedSerials.size === 0 ? tr069Devices.find(device => device.serialNumber) : null)
      || null;
    
    if (primaryDevice && primaryDevice.serialNumber) {
      const genieClient = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, customer.ispId).catch(() => null);
      if (genieClient) {
        const acsDevice = await genieClient.getDeviceBySerial(primaryDevice.serialNumber, {
          projection: '_id,_deviceId,_lastInform'
        }).catch(() => null);
        if (acsDevice) {
          const lastInform = acsDevice._lastInform;
          const isOnline = lastInform && (Date.now() - new Date(lastInform).getTime() < 5 * 60 * 1000);
          ontRealtimeStatus = isOnline ? 'online' : 'offline';

          // Auto-sync back to the database
          await prisma.tr069Device.updateMany({
            where: {
              serialNumber: primaryDevice.serialNumber,
              ispId: customer.ispId,
              isDeleted: false
            },
            data: {
              status: ontRealtimeStatus,
              lastContact: lastInform ? new Date(lastInform) : null,
              updatedAt: new Date()
            }
          }).catch((err) => console.error("Error auto-syncing TR-069 device status:", err.message));
        }
      } else {
        ontRealtimeStatus = primaryDevice.status || 'offline';
      }
    } else {
      ontRealtimeStatus = 'N/A';
    }
  } catch (err) {
    console.error('Error fetching realtime ONT status from ACS:', err.message);
    ontRealtimeStatus = 'N/A';
  }

  try {
    const username = customer.connectionUsers?.[0]?.username;
    if (username) {
      const radiusClient = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, customer.ispId).catch(() => null);
      if (radiusClient) {
        const [sessions, postAuthLogs] = await Promise.all([
          radiusClient.getRadacctByUsername(username).catch(() => []),
          radiusClient.getRadpostauthByUsername(username).catch(() => [])
        ]);
        // For the customer profile, a successful RADIUS authentication is the
        // source of truth requested by operations. Accounting records are used
        // for traffic details only and do not decide the online/offline badge.
        const hasAccessAccept = Array.isArray(postAuthLogs) && postAuthLogs.some(
          log => String(log.reply || '').trim().toLowerCase() === 'access-accept'
        );
        radiusRealtimeStatus = hasAccessAccept ? 'online' : 'offline';
        if (Array.isArray(sessions)) {
          const activeSession = sessions.find(session => {
            const stopTime = session.acctstoptime ?? session.acctStopTime;
            return !stopTime || stopTime === '0000-00-00 00:00:00';
          });
          const sortedSessions = [...sessions].sort((a, b) => {
            const timeA = a.acctstarttime ? new Date(a.acctstarttime).getTime() : 0;
            const timeB = b.acctstarttime ? new Date(b.acctstarttime).getTime() : 0;
            return timeB - timeA;
          });
          const latestSession = sortedSessions[0] || null;
          const targetSession = activeSession || latestSession;

          radiusAccounting = {
            status: hasAccessAccept ? 'online' : 'offline',
            sessionDownload: targetSession ? (Number(targetSession.acctoutputoctets || 0) + Number(targetSession.acctoutputoctets64 || 0)) : 0,
            sessionUpload: targetSession ? (Number(targetSession.acctinputoctets || 0) + Number(targetSession.acctinputoctets64 || 0)) : 0,
            nasIp: targetSession ? (targetSession.nasipaddress || 'N/A') : 'N/A',
            framedIp: targetSession ? (targetSession.framedipaddress || 'N/A') : 'N/A',
            onlineDuration: targetSession ? (Number(targetSession.acctsessiontime || 0)) : 0
          };
        }
      }
    } else {
      radiusRealtimeStatus = 'N/A';
    }
  } catch (err) {
    console.error('Error fetching realtime Radius status:', err.message);
    radiusRealtimeStatus = 'N/A';
  }

  return {
    ontRealtimeStatus,
    radiusRealtimeStatus,
    radiusAccounting,
    acsSerial: primaryDevice?.serialNumber || null
  };
}

async function attachPaymentMethodNames(prisma, ispId, orders = []) {
  const ids = [...new Set(orders.map(order => order.paymentMethodId).filter(Boolean))];
  if (!ids.length) return orders;
  const methods = await prisma.billingPaymentMethod.findMany({
    where: { id: { in: ids }, ispId },
    select: { id: true, name: true }
  });
  const names = new Map(methods.map(method => [method.id, method.name]));
  orders.forEach(order => { order.paymentMethodName = names.get(order.paymentMethodId) || null; });
  return orders;
}

async function getCustomerProfile(req, res, next) {
  try {
    const customer = enrichCustomerDocumentFields(await findCustomerForAuthenticatedUser(req.prisma, req));
    if (!customer) {
      return res.status(404).json({
        success: false,
        error: 'Customer profile not found for this login.',
      });
    }

    const { serials, tr069Devices } = await getCustomerOwnedDeviceSerials(req.prisma, customer);
    const primaryTr069Device = tr069Devices.find((device) => device.serialNumber) || null;
    const primaryDeviceSerial = primaryTr069Device?.serialNumber || null;
    await attachPaymentMethodNames(req.prisma, customer.ispId, customer.orders);
    const activeSubscription = customer.customerSubscriptions.find((subscription) => subscription.isActive) || customer.customerSubscriptions[0] || null;
    const unpaidOrders = customer.orders.filter((order) => !order.isPaid);
    const outstandingAmount = unpaidOrders.reduce((sum, order) => sum + Number(order.totalAmount || 0), 0);

    // Fetch realtime ONT and Radius statuses
    const realtimeNet = await getRealtimeNetworkStatus(req.prisma, customer);

    // Let's enrich tr069Devices in the response with realtime status
    const enrichedTr069Devices = tr069Devices.map(d => {
      if (d.serialNumber && primaryTr069Device && d.serialNumber === primaryTr069Device.serialNumber) {
        return {
          ...d,
          status: realtimeNet.ontRealtimeStatus !== 'N/A' ? realtimeNet.ontRealtimeStatus : d.status
        };
      }
      return d;
    });

    return res.json({
      success: true,
      data: {
        ...customer,
        primaryDeviceSerial,
        deviceSerials: serials,
        tr069Devices: enrichedTr069Devices,
        activeSubscription,
        billingSummary: {
          outstandingAmount,
          unpaidCount: unpaidOrders.length,
          lastOrder: customer.orders[0] || null,
          recentOrders: customer.orders,
        },
        ontRealtimeStatus: realtimeNet.ontRealtimeStatus,
        radiusRealtimeStatus: realtimeNet.radiusRealtimeStatus,
        radiusAccounting: realtimeNet.radiusAccounting,
        primaryDeviceSerial: realtimeNet.acsSerial
      },
    });
  } catch (err) {
    console.error('getCustomerProfile error:', err);
    return next(err);
  }
}


async function provisionCustomer(req, res, next) {
  const prisma = req.prisma;
  const customerId = Number(req.params.id);
  if (isNaN(customerId)) return res.status(400).json({ error: 'Invalid customer ID' });

  const { services } = req.body; // array of { service: string, data: any }

  try {
    const customer = await prisma.customer.findFirst({
      where: { id: customerId, isDeleted: false, ispId: req.ispId },
      include: {
        lead: true,
        customerSubscriptions: {
          where: { isActive: true },
          include: { packagePrice: { include: { packagePlanDetails: true } } },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        devices: true,
        serviceDetails: true,
        connectionUsers: { where: { isDeleted: false } },
      },
    });

    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    if (customer.status === 'active' && (!Array.isArray(services) || services.length === 0)) {
      return res.status(200).json({
        success: true,
        message: 'Customer is already active. No additional services were requested.',
        customer: {
          id: customer.id,
          customerUniqueId: customer.customerUniqueId,
          name: `${customer.lead?.firstName || ''} ${customer.lead?.lastName || ''}`.trim(),
          status: customer.status,
          onboardStatus: customer.onboardStatus,
        },
        services: [],
      });
    }

    const testSubscription = customer.customerSubscriptions[0];
    if (!testSubscription) {
      return res.status(400).json({ error: 'No active subscription found' });
    }

    // Prepare results for each service
    const serviceResults = [];

    // Helper to find service ID by code and ISP
    const getServiceIdByCode = async (code) => {
      const ispService = await prisma.iSPService.findFirst({
        where: {
          ispId: req.ispId,
          isActive: true,
          isDeleted: false,
          service: {
            code: code,
            isActive: true,
            isDeleted: false,
          },
        },
        include: { service: true },
      });
      if (!ispService) {
        throw new Error(`Service ${code} not available for this ISP`);
      }
      return ispService.service.id;
    };

    // Process each service
    if (services && Array.isArray(services)) {
      const pushTrialSetting = await prisma.iSPSettings.findFirst({
        where: { key: 'pushTrialProvisionToAccount', ispId: req.ispId }
      });
      const pushTrialEnabled = pushTrialSetting ? pushTrialSetting.value === 'true' : false;

      for (const svc of services) {
        const { service, data } = svc;
        try {
          let result = {};
          
          const isTrial = testSubscription?.isTrial === true;
          if (!isTrial || pushTrialEnabled) {
            const isAccountService = service === SERVICE_CODES.TSHUL || service === SERVICE_CODES.NEPURIX;
            let client = null;
            if (!isAccountService) {
              try {
                client = await ServiceFactory.getClient(service, req.ispId);
              } catch (clientErr) {
                console.warn(`[CUSTOMER ONBOARDING] Service client initialization failed for ${service}:`, clientErr.message);
                client = null;
              }
              if (!client) {
                console.log(`[CUSTOMER ONBOARDING] Skipping provisioning for ${service} because service is not configured/enabled`);
                continue;
              }
            }

            switch (service) {
              case SERVICE_CODES.TSHUL:
              case SERVICE_CODES.NEPURIX: {
                const activeBillingClients = await ServiceFactory.getActiveBillingClients(req.ispId, prisma);
                // Provision the accounting provider explicitly selected by the
                // onboarding UI. Multiple configured providers must not create
                // duplicate accounting customers.
                let clientsToProvision = activeBillingClients.filter(item => item.code === service);
                if (clientsToProvision.length === 0) {
                  console.log(`[CUSTOMER ONBOARDING] Skipping accounting provisioning for ${service} because service is not configured/enabled for ISP ${req.ispId}`);
                  break;
                }

                const results = [];
                for (const billingClient of clientsToProvision) {
                  try {
                    const resData = await billingClient.client.customer.create(data);
                    const sId = await getServiceIdByCode(billingClient.code);
                    await prisma.customerSubscribedService.upsert({
                      where: { customerId_serviceId: { customerId, serviceId: sId } },
                      update: { status: 'active', serviceData: resData },
                      create: {
                        customerId,
                        serviceId: sId,
                        status: 'active',
                        serviceData: resData,
                      },
                    });
                    results.push({ service: billingClient.code, success: true, data: resData });
                  } catch (err) {
                    console.error(`${billingClient.code} provisioning error:`, err);
                    results.push({ service: billingClient.code, success: false, message: err.message });
                  }
                }

                const mainResult = results.find(r => r.service === service) || results[0];
                if (mainResult) {
                  if (mainResult.success) {
                    result = mainResult.data;
                  } else {
                    throw new Error(mainResult.message);
                  }
                }
                for (const r of results) {
                  if (r.service !== service) {
                    serviceResults.push(r);
                  }
                }
                break;
              }
              case SERVICE_CODES.RADIUS:
                data.attributes = {
                  ...(data.attributes || {}),
                  Expiration: formatRadiusExpiration(testSubscription.planEnd)
                };
                let nasIp = data.attributes?.['NAS-IP-Address'];
                if (!nasIp) {
                  const availableNas = await prisma.nas.findMany({
                    where: { ispId: req.ispId, isActive: true, isDeleted: false },
                    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }]
                  });
                  let selectedNas = null;
                  if (data.nasId) {
                    selectedNas = availableNas.find(n => n.id === Number(data.nasId));
                  }
                  if (!selectedNas) {
                    selectedNas = availableNas.find(nas => nas.isDefault) || availableNas[0] || null;
                  }
                  if (selectedNas) {
                    nasIp = selectedNas.nasname;
                  }
                }
                if (nasIp) {
                  data.attributes = { ...(data.attributes || {}), 'NAS-IP-Address': nasIp };
                }
                if (testSubscription?.packagePrice) {
                  const radiusGroupName =
                    data.planCode ||
                    testSubscription.packagePrice.packagePlanDetails?.planCode ||
                    testSubscription.packagePrice.packagePlanDetails?.planName ||
                    testSubscription.packagePrice.packageName;
                  if (radiusGroupName) data.groups = [radiusGroupName];
                }
                result = await client.createUser(
                  data.username,
                  data.password,
                  data.attributes || {},
                  data.groups || []
                );
                await client.createRadcheck({
                  username: data.username,
                  attribute: 'Simultaneous-Use',
                  op: ':=',
                  value: '1'
                });
                break;
              case SERVICE_CODES.NETTV: {
                const nettvUsername = String(data?.username || '').trim();
                if (!nettvUsername) throw new Error('NetTV username is required');
                const nettvServiceId = await getServiceIdByCode(SERVICE_CODES.NETTV);
                const existingLink = await prisma.customerSubscribedService.findFirst({
                  where: {
                    serviceId: nettvServiceId,
                    externalUsername: nettvUsername,
                    customerId: { not: customerId }
                  },
                  select: { customerId: true }
                });
                if (existingLink) throw new Error(`NetTV username '${nettvUsername}' is already linked to another customer`);
                const { provisioning: nettvProvisioning, ...subscriberData } = data;
                result = await client.createSubscriber(subscriberData);
                if (nettvProvisioning?.stb?.serial) {
                  await client.addSTBToSubscriber(nettvUsername, nettvProvisioning.stb);
                  if (nettvProvisioning.package?.packages?.length) {
                    await client.subscribePackages(nettvProvisioning.stb.serial, nettvProvisioning.package);
                  }
                }
                const overviewData = await client.getSubscriberOverview(nettvUsername).catch(error => {
                  console.warn('Failed to fetch full overview on NetTV provision:', error.message);
                  return null;
                });
                if (overviewData) {
                  result = { ...result, ...overviewData, lastNetTVSync: new Date().toISOString() };
                }
                break;
              }
              default:
                throw new Error(`Unsupported service: ${service}`);
            }

            // Store successful result in database (only if not already stored by the custom block)
            if (service !== SERVICE_CODES.TSHUL && service !== SERVICE_CODES.NEPURIX) {
              const serviceId = await getServiceIdByCode(service);
              const externalUsername = service === SERVICE_CODES.NETTV ? String(data?.username || '').trim() : null;
              const storedServiceData = service === SERVICE_CODES.NETTV
                ? { ...data, ...result, username: externalUsername }
                : result;
              await prisma.customerSubscribedService.upsert({
                where: { customerId_serviceId: { customerId, serviceId } },
                update: { status: 'active', externalUsername, serviceData: storedServiceData },
                create: {
                  customerId,
                  serviceId,
                  status: 'active',
                  externalUsername,
                  serviceData: storedServiceData,
                },
              });
            }
          } else {
            console.log(`Bypassing external push for service ${service} since pushTrialProvisionToAccount is disabled.`);
            const serviceId = await getServiceIdByCode(service);
            const externalUsername = service === SERVICE_CODES.NETTV ? String(data?.username || '').trim() || null : null;
            await prisma.customerSubscribedService.upsert({
              where: { customerId_serviceId: { customerId, serviceId } },
              update: { status: 'active', externalUsername, serviceData: { ...data, username: externalUsername, bypassed: true } },
              create: {
                customerId,
                serviceId,
                status: 'active',
                externalUsername,
                serviceData: { ...data, username: externalUsername, bypassed: true },
              },
            });
          }

          serviceResults.push({ service, success: true, data: result });
        } catch (error) {
          console.error(`${service} provision error:`, error);
          serviceResults.push({ service, success: false, message: error.message });
        }
      }
    }

    // Update customer status and device/service connection statuses. This endpoint can also add
    // missing add-on services for an already-active customer.
    const provisioningSucceeded = serviceResults.length > 0 && serviceResults.every(item => item.success);
    if (provisioningSucceeded) {
      await prisma.$transaction([
        prisma.customer.update({
          where: { id: customerId },
          data: { status: 'active', onboardStatus: 'fully_onboarded' },
        }),
        prisma.customerDevice.updateMany({
          where: { customerId, deviceType: 'ONT' },
          data: { provisioningStatus: 'active' },
        }),
        prisma.customerServiceConnection.updateMany({
          where: { customerId },
          data: {
            status: 'active',
            provisioningNotes: `Provisioned via ${customer.serviceDetails?.[0]?.connectionType || 'service connection'} on ${new Date().toISOString()}`,
          },
        }),
      ]);
    }

    // Extract results for convenience
    const tshulResult = serviceResults.find(r => r.service === SERVICE_CODES.TSHUL);
    const nepurixResult = serviceResults.find(r => r.service === SERVICE_CODES.NEPURIX);
    const radiusResult = serviceResults.find(r => r.service === SERVICE_CODES.RADIUS);
    const nettvResult = serviceResults.find(r => r.service === SERVICE_CODES.NETTV);

    const customerName = `${customer.lead.firstName || ''} ${customer.lead.lastName || ''}`.trim();
    return res.status(200).json({
      success: true,
      message: 'Customer provisioned successfully',
      customer: {
        id: customer.id,
        customerUniqueId: customer.customerUniqueId,
        name: customerName,
        status: 'active',
        onboardStatus: 'fully_onboarded',
      },
      subscription: {
        id: testSubscription.id,
        planStart: testSubscription.planStart,
        planEnd: testSubscription.planEnd,
        packageName: testSubscription.packagePrice?.packageName,
      },
      order: null,
      provisioning: {
        radius: customer.connectionUsers,
        tshul: tshulResult?.success ? tshulResult.data : null,
        nepurix: nepurixResult?.success ? nepurixResult.data : null,
        radiusResult: radiusResult?.success ? radiusResult.data : null,
        nettvResult: nettvResult?.success ? nettvResult.data : null,
        connectionUsers: customer.connectionUsers.length,
        ont: customer.devices.filter(d => d.deviceType === 'ONT').length > 0 ? { status: 'provisioned' } : null,
      },
      services: serviceResults,
    });
  } catch (err) {
    console.error('❌ Provisioning error:', err);
    return res.status(500).json({ success: false, error: 'Provisioning failed', details: err.message });
  }
}


/**
 * List customers with lead and other relations
 */
async function enrichServiceDetailsWithVlans(prisma, customers) {
  // Normalize input to always be an array
  const customerArray = Array.isArray(customers) ? customers : [customers];

  // Collect all unique VLAN IDs from all service details of all customers
  const vlanIdsSet = new Set();
  for (const cust of customerArray) {
    if (cust.serviceDetails && Array.isArray(cust.serviceDetails)) {
      for (const sd of cust.serviceDetails) {
        if (sd.vlanId && typeof sd.vlanId === 'string') {
          sd.vlanId.split(',').forEach(id => {
            const trimmed = id.trim();
            if (trimmed) vlanIdsSet.add(parseInt(trimmed, 10));
          });
        }
      }
    }
  }

  let vlanMap = new Map();
  if (vlanIdsSet.size > 0) {
    const vlans = await prisma.oLTVLAN.findMany({
      where: { id: { in: Array.from(vlanIdsSet) } }
    });
    vlanMap = new Map(vlans.map(v => [v.id, v]));
  }

  // Enrich each service detail and sanitize OLT object to hide sensitive credentials
  for (const cust of customerArray) {
    if (cust.serviceDetails && Array.isArray(cust.serviceDetails)) {
      for (const sd of cust.serviceDetails) {
        if (sd.vlanId && typeof sd.vlanId === 'string') {
          const ids = sd.vlanId.split(',')
            .map(id => parseInt(id.trim(), 10))
            .filter(id => !isNaN(id));
          sd.vlanDetails = ids.map(id => vlanMap.get(id)).filter(Boolean);
        } else {
          sd.vlanDetails = [];
        }

        // Sanitize sensitive OLT SSH and SNMP credentials before sending to customer/profile APIs
        if (sd.olt) {
          const { sshUsername, sshPassword, sshEnablePassword, sshKey, snmpCommunity, ...safeOlt } = sd.olt;
          sd.olt = safeOlt;
        }
      }
    }
  }

  return customers;
}

// ==================== LIST CUSTOMERS ====================
/**
 * List customers with lead and other relations
 */
async function listCustomers(req, res, next) {
  try {
    await deactivateExpiredCustomers(req.prisma, req.ispId);
    const roleName = String(req.user?.role?.name || "").toLowerCase();
    const isFieldStaff = roleName.includes("field staff") || roleName.includes("field_staff");
    if (isFieldStaff && (!req.query.search || !String(req.query.search).trim())) {
      return res.json({ data: [], pagination: { total: 0, page: 1, limit: 20, totalPages: 0 } });
    }
    const {
      search,
      status,
      onboardStatus,
      page = 1,
      limit = 20,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      oltId,
      splitterId,
      oltPort,
      subBranchId,
      branchId: queryBranchId,
      area,
      packageId,
      planId,
      connectionType
    } = req.query;

    const branchFilter = await getBranchFilter(req);
    const where = { 
      isDeleted: false, 
      ispId: req.ispId,
      ...(branchFilter || {})
    };
    if (status && status !== 'all') where.status = status;
    if (onboardStatus && onboardStatus !== 'all') where.onboardStatus = onboardStatus;

    // Extra filters for SMS campaign targeting
    // Only apply query-provided branchId if branchFilter didn't already set one (i.e. admin/global users)
    if (queryBranchId && queryBranchId !== 'all' && !branchFilter) {
      where.branchId = parseInt(queryBranchId);
    }
    if (subBranchId && subBranchId !== 'all') where.subBranchId = parseInt(subBranchId);

    const serviceDetailWhere = {};
    if (connectionType && connectionType !== 'all') {
      serviceDetailWhere.connectionType = connectionType;
    }
    if (oltId && oltId !== 'all') {
      serviceDetailWhere.oltId = parseInt(oltId);
      if (oltPort && oltPort !== 'all') serviceDetailWhere.oltPort = String(oltPort);
      if (splitterId && splitterId !== 'all') serviceDetailWhere.splitterId = parseInt(splitterId);
    } else if (splitterId && splitterId !== 'all') {
      serviceDetailWhere.splitterId = parseInt(splitterId);
    }
    if (Object.keys(serviceDetailWhere).length > 0) {
      where.serviceDetails = { some: serviceDetailWhere };
    }

    if (area) {
      const areas = String(area).split(',').map(s => s.trim()).filter(Boolean);
      if (areas.length > 0) {
        where.lead = {
          ...where.lead,
          OR: areas.flatMap(a => [
            { address: { contains: a } },
            { street: { contains: a } },
            { district: { contains: a } },
            { province: { contains: a } }
          ])
        };
      }
    }

    const andConditions = [];

    if (search && String(search).trim()) {
      const q = String(search).trim();
      const parts = q.split(/\s+/);
      const orList = [
        { lead: { firstName: { contains: q } } },
        { lead: { lastName: { contains: q } } },
        { lead: { email: { contains: q } } },
        { lead: { phoneNumber: { contains: q } } },
        { lead: { secondaryContactNumber: { contains: q } } },
        { portalUser: { email: { contains: q } } },
        { connectionUsers: { some: { username: { contains: q }, isDeleted: false } } },
        { customerUniqueId: { contains: q } },
        { idNumber: { contains: q } },
        { panNo: { contains: q } }
      ];
      if (parts.length > 1) {
        orList.push({
          AND: [
            { lead: { firstName: { contains: parts[0] } } },
            { lead: { lastName: { contains: parts.slice(1).join(' ') } } }
          ]
        });
      }
      andConditions.push({ OR: orList });
    }

    const targetPkg = packageId || planId;
    if (targetPkg && targetPkg !== 'all') {
      const parsedPkgId = parseInt(targetPkg);
      if (!isNaN(parsedPkgId)) {
        andConditions.push({
          OR: [
            { subscribedPkgId: parsedPkgId },
            { assignedPkg: parsedPkgId },
            { packagePrice: { id: parsedPkgId } },
            { customerSubscriptions: { some: { package: parsedPkgId, isActive: true } } }
          ]
        });
      }
    }

    if (andConditions.length > 0) {
      where.AND = andConditions;
    }

    const fetchAll = String(limit).toLowerCase() === 'all';
    const parsedLimit = Math.max(1, parseInt(limit) || 20);
    const parsedPage = Math.max(1, parseInt(page) || 1);
    const skip = (parsedPage - 1) * parsedLimit;
    const [customers, total] = await Promise.all([
      req.prisma.customer.findMany({
        where,
        include: {
          lead: true,
          packagePrice: { include: { packagePlanDetails: true } },
          subscribedPkg: { include: { packagePlanDetails: true } },
          membership: true,
          devices: true,
          serviceDetails: { include: { olt: true, splitter: true } },
          documents: { where: { isDeleted: false }, take: 1 },
          connectionUsers: { where: { isDeleted: false } },
          customerSubscriptions: {
            where: { isActive: true },
            take: 1,
            orderBy: { createdAt: 'desc' },
            include: { packagePrice: { include: { packagePlanDetails: true } } }
          },
          // NEW: include subscribed services with full service details
          subscribedApps: {
            include: { service: true }
          },
          customerType: true,
          branch: { select: { id: true, name: true } },
          subBranch: { select: { id: true, name: true } }
        },
        orderBy: { [sortBy]: sortOrder },
        ...(fetchAll ? {} : { skip, take: parsedLimit })
      }),
      req.prisma.customer.count({ where })
    ]);

    // Enrich serviceDetails with VLAN objects
    await enrichServiceDetailsWithVlans(req.prisma, customers);

    // Flatten lead fields for API consistency
    const portalUsers = await req.prisma.user.findMany({
      where: {
        ispId: req.ispId,
        isDeleted: false,
        customerId: { in: customers.map(c => c.id) }
      },
      select: {
        id: true,
        customerId: true,
        profilePicture: true
      }
    });
    const portalUserMap = new Map(portalUsers.map(user => [user.customerId, user]));

    const transformed = customers.map(c => {
      const meta = c.lead?.metadata ? (typeof c.lead.metadata === 'string' ? JSON.parse(c.lead.metadata) : c.lead.metadata) : null;
      const portalUser = portalUserMap.get(c.id) || null;
      return {
        ...c,
        portalUser,
        profilePicture: portalUser?.profilePicture || null,
        firstName: c.lead?.firstName,
        middleName: c.lead?.middleName || null,
        lastName: c.lead?.lastName,
        email: c.lead?.email,
        phoneNumber: c.lead?.phoneNumber,
        secondaryPhone: c.lead?.secondaryContactNumber,
        secondaryContactNumber: c.lead?.secondaryContactNumber || null,
        gender: c.lead?.gender,
        street: c.lead?.street,
        city: meta?.city || null,
        district: c.lead?.district,
        state: c.lead?.province,
        zipCode: meta?.zipCode || null,
        address: c.lead?.address,
        convertedAt: c.lead?.convertedAt,
        source: c.lead?.source || null,
        notes: c.lead?.notes || null,
        age: meta?.age || null,
        fullAddress: meta?.fullAddress || c.lead?.address || null,
        lead: undefined
      };
    });

    return res.json({
      data: transformed,
      pagination: {
        page: fetchAll ? 1 : parsedPage,
        limit: fetchAll ? total : parsedLimit,
        total,
        totalPages: fetchAll ? 1 : Math.ceil(total / parsedLimit)
      }
    });
  } catch (err) {
    console.error("listCustomers error:", err);
    return next(err);
  }
}

// ==================== GET SINGLE CUSTOMER ====================
/**
 * Get single customer by ID
 */
async function getCustomerById(req, res, next) {
  try {
    await deactivateExpiredCustomers(req.prisma, req.ispId);
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

    const customer = await req.prisma.customer.findUnique({
      where: { id },
      include: {
        lead: true,
        packagePrice: { include: { packagePlanDetails: true } },
        subscribedPkg: { include: { packagePlanDetails: true } },
        membership: true,
        devices: true,
        serviceDetails: { include: { olt: true, splitter: true } },
        documents: { where: { isDeleted: false }, orderBy: { uploadedAt: 'desc' } },
        connectionUsers: { where: { isDeleted: false }, orderBy: { createdAt: 'desc' } },
        customerSubscriptions: {
          where: { isActive: true },
          include: { packagePrice: { include: { packagePlanDetails: true } } },
          orderBy: { createdAt: 'desc' }
        },
        // NEW: include subscribed services with full service details
        subscribedApps: {
          include: { service: true }
        },
        customerType: true,
        subBranch: { select: { id: true, name: true } },
        orders: {
          where: { isActive: true, isDeleted: false },
          include: { items: true, packagePrice: { include: { packagePlanDetails: true } } },
          orderBy: { orderDate: 'desc' }
        },
        isp: { select: { companyName: true, phoneNumber: true, masterEmail: true } }
      }
    });

    if (!customer || customer.isDeleted || customer.ispId !== req.ispId) {
      return res.status(404).json({ error: "Customer not found" });
    }

    // Package creation stores its configured add-ons in the explicit join
    // table. Attach those definitions to every order so profile billing can
    // show the same itemized amounts, tax and TSC rules as the invoice.
    const packageIds = [...new Set((customer.orders || []).map(order => order.package).filter(Boolean))];
    const packagesWithCharges = packageIds.length
      ? await req.prisma.packagePrice.findMany({
          where: { id: { in: packageIds } },
          include: { oneTimeCharges: { where: { isDeleted: false }, orderBy: { id: 'asc' } } }
        })
      : [];
    const chargesByPackage = new Map();
    for (const pkg of packagesWithCharges) {
      chargesByPackage.set(pkg.id, pkg.oneTimeCharges || []);
    }
    const firstOrderIdByPackage = new Map();
    for (const order of customer.orders || []) {
      if (!order.package || Number(order.totalAmount || 0) <= 0) continue;
      const current = firstOrderIdByPackage.get(order.package);
      if (current === undefined || order.id < current) firstOrderIdByPackage.set(order.package, order.id);
    }
    customer.orders = (customer.orders || []).map(order => {
      const isTrialOrder = Number(order.totalAmount || 0) === 0;
      const isRenewalOrder = !isTrialOrder && firstOrderIdByPackage.has(order.package) && order.id !== firstOrderIdByPackage.get(order.package);
      const customPrices = order.packagePrice?.addonPricesJson ? JSON.parse(order.packagePrice.addonPricesJson) : {};
      return {
        ...order,
        isTrialOrder,
        isRenewalOrder,
        packageItems: isTrialOrder ? [] : (chargesByPackage.get(order.package) || order.packagePrice?.oneTimeCharges || [])
          .filter(item => !isRenewalOrder || item.isRenewal)
          .map(item => ({
            ...item,
            amount: customPrices[String(item.id)] !== undefined ? customPrices[String(item.id)] : item.amount
          }))
      };
    });

    // Enrich serviceDetails with VLAN objects
    await enrichServiceDetailsWithVlans(req.prisma, customer);

    const inventoryItems = await req.prisma.InventoryItem.findMany({
      where: { customerId: id, ispId: req.ispId },
      orderBy: { updatedAt: 'desc' }
    });

    const portalUser = await findPortalUserForCustomer(req.prisma, customer);

    // Fetch realtime ONT and Radius statuses
    const realtimeNet = await getRealtimeNetworkStatus(req.prisma, customer);

    // Let's enrich tr069Devices in response with realtime status if available
    const enrichedDevices = (customer.devices || []).map(d => {
      if (d.serialNumber && realtimeNet.ontRealtimeStatus !== 'N/A') {
        return {
          ...d,
          status: realtimeNet.ontRealtimeStatus
        };
      }
      return d;
    });

    // Flatten lead fields
    const leadMeta = customer.lead?.metadata ? (typeof customer.lead.metadata === 'string' ? JSON.parse(customer.lead.metadata) : customer.lead.metadata) : null;
    const response = {
      ...enrichCustomerDocumentFields(customer),
      devices: enrichedDevices,
      portalUser,
      profilePicture: portalUser?.profilePicture || null,
      inventoryItems,
      firstName: customer.lead?.firstName,
      lastName: customer.lead?.lastName,
      middleName: customer.lead?.middleName,
      email: customer.lead?.email,
      phoneNumber: customer.lead?.phoneNumber,
      secondaryPhone: customer.lead?.secondaryContactNumber,
      gender: customer.lead?.gender,
      street: customer.lead?.street,
      city: leadMeta?.city || customer.city || '',
      district: customer.lead?.district,
      state: customer.lead?.province,
      zipCode: leadMeta?.zipCode || customer.zipCode || '',
      // Keep the source lead available to provisioning forms. Location data is
      // commonly stored in lead.metadata and was previously discarded here.
      lead: customer.lead,
      latitude: customer.lead?.metadata?.latitude ?? customer.lead?.metadata?.lat ?? null,
      longitude: customer.lead?.metadata?.longitude ?? customer.lead?.metadata?.lng ?? customer.lead?.metadata?.lon ?? null,
      ontRealtimeStatus: realtimeNet.ontRealtimeStatus,
      radiusRealtimeStatus: realtimeNet.radiusRealtimeStatus,
      radiusAccounting: realtimeNet.radiusAccounting,
      primaryDeviceSerial: realtimeNet.acsSerial
    };

    return res.json(response);
  } catch (err) {
    console.error("getCustomerById error:", err);
    return next(err);
  }
}

/**
 * Get customer by phone number (searches in lead)
 */
async function getCustomerByPhoneNumber(req, res, next) {
  try {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: "Phone number is required" });

    const cleanPhoneNumber = phoneNumber
      .replace(/^\+977/, '')
      .replace(/^977/, '')
      .replace(/\D/g, '');

    if (cleanPhoneNumber.length < 10) {
      return res.status(400).json({ error: "Invalid phone number format" });
    }

    const customer = await req.prisma.customer.findFirst({
      where: {
        lead: {
          OR: [
            { phoneNumber: { contains: cleanPhoneNumber } },
            { phoneNumber: { contains: `+977${cleanPhoneNumber}` } },
            { phoneNumber: { contains: `977${cleanPhoneNumber}` } },
            { secondaryContactNumber: { contains: cleanPhoneNumber } },
            { secondaryContactNumber: { contains: `+977${cleanPhoneNumber}` } },
            { secondaryContactNumber: { contains: `977${cleanPhoneNumber}` } }
          ]
        },
        isDeleted: false,
        ispId: req.ispId
      },
      include: {
        lead: true,
        packagePrice: { include: { packagePlanDetails: true } },
        subscribedPkg: { include: { packagePlanDetails: true } },
        membership: true,
        devices: true,
        serviceDetails: { include: { olt: true, splitter: true } },
        documents: { where: { isDeleted: false }, orderBy: { uploadedAt: 'desc' } },
        connectionUsers: { where: { isDeleted: false }, orderBy: { createdAt: 'desc' } },
        customerSubscriptions: {
          where: { isActive: true },
          include: { packagePrice: { include: { packagePlanDetails: true } } },
          orderBy: { createdAt: 'desc' }
        },
        orders: {
          where: { isActive: true, isDeleted: false },
          include: { items: true, packagePrice: { include: { packagePlanDetails: true } } },
          orderBy: { orderDate: 'desc' }
        },
        isp: { select: { companyName: true, phoneNumber: true, masterEmail: true } }
      }
    });

    if (!customer) {
      return res.status(404).json({
        error: "Customer not found",
        message: `No customer found with phone number: ${phoneNumber}`
      });
    }

    // Flatten lead
    const leadMeta = customer.lead?.metadata ? (typeof customer.lead.metadata === 'string' ? JSON.parse(customer.lead.metadata) : customer.lead.metadata) : null;
    const response = {
      ...enrichCustomerDocumentFields(customer),
      firstName: customer.lead?.firstName,
      lastName: customer.lead?.lastName,
      middleName: customer.lead?.middleName,
      email: customer.lead?.email,
      phoneNumber: customer.lead?.phoneNumber,
      secondaryPhone: customer.lead?.secondaryContactNumber,
      gender: customer.lead?.gender,
      street: customer.lead?.street,
      city: leadMeta?.city || '',
      district: customer.lead?.district,
      state: customer.lead?.province,
      zipCode: leadMeta?.zipCode || '',
      lead: undefined
    };

    return res.json(response);
  } catch (err) {
    console.error("getCustomerByPhoneNumber error:", err);
    return next(err);
  }
}

/**
 * Update customer – updates Lead and Customer records, optionally devices/service connection
 */
async function updateCustomer(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

    const existing = await req.prisma.customer.findUnique({
      where: { id },
      include: { lead: true }
    });
    if (!existing || existing.isDeleted || existing.ispId !== req.ispId) {
      return res.status(404).json({ error: "Customer not found" });
    }

    const {
      // Lead fields
      firstName, middleName, lastName,
      email, phoneNumber, secondaryPhone, secondaryContactNumber, gender,
      streetAddress, street, city, district, state, province, zipCode, lat, lon,

      // Customer fields
      idNumber, panNumber,
      status, onboardStatus,
      membershipId, existingISPId, customerTypeId, subBranchId, installedById, subscribedPkgId,
      isFree, freeCustomerSecretKey,
      deviceName, deviceMac, deviceBrand, deviceSerial, devicePonSerial,
      connectionType, vlanId, vlanPriority, oltId, splitterId, oltPort, splitterPort,
      connectionUsername, connectionPassword,

      ...rest
    } = req.body;

    const targetTypeId = customerTypeId !== undefined ? (customerTypeId ? Number(customerTypeId) : null) : existing.customerTypeId;
    
    // Normalize phone, secondary phone, email to null if empty/whitespace
    const cleanPhone = phoneNumber !== undefined ? (phoneNumber && String(phoneNumber).trim() ? String(phoneNumber).trim() : null) : undefined;
    const cleanEmail = email !== undefined ? (email && String(email).trim() ? String(email).trim() : null) : undefined;
    const rawSecondary = secondaryPhone !== undefined ? secondaryPhone : secondaryContactNumber;
    const cleanSecondary = rawSecondary !== undefined ? (rawSecondary && String(rawSecondary).trim() ? String(rawSecondary).trim() : null) : undefined;

    const checkPhone = cleanPhone !== undefined ? cleanPhone : existing.lead?.phoneNumber;
    const checkEmail = cleanEmail !== undefined ? cleanEmail : existing.lead?.email;

    if (targetTypeId) {
      const cType = await req.prisma.customerType.findUnique({
        where: { id: targetTypeId }
      });
      if (cType) {
        if (cType.allowDuplicateMobile === false && checkPhone) {
          const dupMobile = await req.prisma.customer.findFirst({
            where: {
              id: { not: id },
              isDeleted: false,
              lead: { phoneNumber: checkPhone }
            }
          });
          if (dupMobile) {
            return res.status(400).json({ error: 'Mobile number already exists for another customer. Duplication is disabled for this customer type.' });
          }
        }
        if (cType.allowDuplicateEmail === false && checkEmail) {
          const dupEmail = await req.prisma.customer.findFirst({
            where: {
              id: { not: id },
              isDeleted: false,
              lead: { email: checkEmail }
            }
          });
          if (dupEmail) {
            return res.status(400).json({ error: 'Email already exists for another customer. Duplication is disabled for this customer type.' });
          }
        }
      }
    }

    // Build Customer update
    const customerUpdate = {};
    if (idNumber !== undefined) {
      const trimmedId = idNumber ? String(idNumber).trim() : '';
      customerUpdate.idNumber = trimmedId || existing.idNumber || String(id);
    }
    if (panNumber !== undefined) {
      customerUpdate.panNo = (panNumber && String(panNumber).trim()) || null;
    }
    if (status !== undefined) customerUpdate.status = status;
    if (onboardStatus !== undefined) customerUpdate.onboardStatus = onboardStatus;
    if (membershipId !== undefined) customerUpdate.membershipId = membershipId ? Number(membershipId) : null;
    if (existingISPId !== undefined) customerUpdate.existingISPId = existingISPId ? Number(existingISPId) : null;
    if (customerTypeId !== undefined) customerUpdate.customerTypeId = customerTypeId ? Number(customerTypeId) : null;
    if (subBranchId !== undefined) customerUpdate.subBranchId = subBranchId ? Number(subBranchId) : null;
    if (installedById !== undefined) customerUpdate.installedById = installedById ? Number(installedById) : null;
    if (subscribedPkgId !== undefined) {
      customerUpdate.subscribedPkgId = subscribedPkgId ? Number(subscribedPkgId) : null;
      customerUpdate.assignedPkg = subscribedPkgId ? Number(subscribedPkgId) : null;
    }
    if (isFree !== undefined) {
      const parsedIsFree = isFree === true || isFree === 'true';
      if (parsedIsFree !== Boolean(existing.isFree)) {
        const role = String(req.user?.role || '').toLowerCase();
        const isAdmin = role === 'admin' || role === 'isp_admin' || role === 'administrator' || role.startsWith('global ');
        if (!isAdmin) {
          return res.status(403).json({ success: false, error: 'Only administrators can update Free customer status.' });
        }
        if (parsedIsFree) {
          const secretSetting = await req.prisma.iSPSettings.findFirst({
            where: { key: 'freeCustomerSecretKey', ispId: req.ispId }
          });
          const systemSecret = secretSetting ? secretSetting.value : 'admin123';
          if (freeCustomerSecretKey !== systemSecret) {
            return res.status(400).json({ success: false, error: 'Invalid Free Customer Secret Key.' });
          }
        }
      }
      customerUpdate.isFree = parsedIsFree;
    }

    // Build Lead update
    const leadUpdate = {};
    if (firstName !== undefined) leadUpdate.firstName = (firstName && String(firstName).trim()) || null;
    if (middleName !== undefined) leadUpdate.middleName = (middleName && String(middleName).trim()) || null;
    if (lastName !== undefined) leadUpdate.lastName = (lastName && String(lastName).trim()) || null;
    if (cleanEmail !== undefined) leadUpdate.email = cleanEmail;
    if (cleanPhone !== undefined) leadUpdate.phoneNumber = cleanPhone;
    if (cleanSecondary !== undefined) leadUpdate.secondaryContactNumber = cleanSecondary;
    if (gender !== undefined) leadUpdate.gender = (gender && String(gender).trim()) || null;

    const rawStreet = streetAddress !== undefined ? streetAddress : street;
    const rawProvince = state !== undefined ? state : province;

    if (rawStreet !== undefined) leadUpdate.street = (rawStreet && String(rawStreet).trim()) || null;
    if (district !== undefined) leadUpdate.district = (district && String(district).trim()) || null;
    if (rawProvince !== undefined) leadUpdate.province = (rawProvince && String(rawProvince).trim()) || null;

    // city, zipCode, lat, lon belong in Lead.metadata (NOT direct columns on Lead)
    let existingMeta = {};
    try {
      if (existing.lead?.metadata) {
        existingMeta = typeof existing.lead.metadata === 'string'
          ? JSON.parse(existing.lead.metadata)
          : { ...existing.lead.metadata };
      }
    } catch (e) {
      existingMeta = {};
    }

    let metaChanged = false;
    if (city !== undefined) {
      existingMeta.city = (city && String(city).trim()) || null;
      metaChanged = true;
    }
    if (zipCode !== undefined) {
      existingMeta.zipCode = (zipCode && String(zipCode).trim()) || null;
      metaChanged = true;
    }
    if (lat !== undefined) {
      existingMeta.lat = lat ? Number(lat) : null;
      existingMeta.latitude = lat ? Number(lat) : null;
      metaChanged = true;
    }
    if (lon !== undefined) {
      existingMeta.lon = lon ? Number(lon) : null;
      existingMeta.longitude = lon ? Number(lon) : null;
      metaChanged = true;
    }

    if (metaChanged) {
      leadUpdate.metadata = existingMeta;
    }

    // Update formatted address if any address component is changed
    if (rawStreet !== undefined || city !== undefined || district !== undefined || rawProvince !== undefined) {
      const curStreet = rawStreet !== undefined ? ((rawStreet && String(rawStreet).trim()) || null) : existing.lead?.street;
      const curCity = city !== undefined ? ((city && String(city).trim()) || null) : existingMeta.city;
      const curDistrict = district !== undefined ? ((district && String(district).trim()) || null) : existing.lead?.district;
      const curProvince = rawProvince !== undefined ? ((rawProvince && String(rawProvince).trim()) || null) : existing.lead?.province;
      const fullAddress = [curStreet, curCity, curDistrict, curProvince].filter(Boolean).join(', ');
      leadUpdate.address = fullAddress || null;
    }

    // Update Device (find first ONT device or create)
    if (deviceName !== undefined || deviceMac !== undefined || deviceBrand !== undefined || deviceSerial !== undefined || devicePonSerial !== undefined) {
      const device = await req.prisma.customerDevice.findFirst({
        where: { customerId: id, deviceType: 'ONT' }
      });
      const deviceData = {};
      if (deviceBrand !== undefined) deviceData.brand = deviceBrand;
      if (deviceName !== undefined) deviceData.model = deviceName;
      if (deviceSerial !== undefined) deviceData.serialNumber = deviceSerial;
      if (deviceMac !== undefined) deviceData.macAddress = deviceMac?.toUpperCase();
      if (devicePonSerial !== undefined) deviceData.ponSerial = devicePonSerial;
      if (device) {
        await req.prisma.customerDevice.update({
          where: { id: device.id },
          data: deviceData
        });
      } else {
        await req.prisma.customerDevice.create({
          data: {
            customerId: id,
            deviceType: 'ONT',
            ...deviceData,
            provisioningStatus: 'pending'
          }
        });
      }
    }

    // Update Service Connection (find first or create)
    if (connectionType !== undefined || vlanId !== undefined || vlanPriority !== undefined ||
      oltId !== undefined || splitterId !== undefined || oltPort !== undefined || splitterPort !== undefined) {
      const serviceConn = await req.prisma.customerServiceConnection.findFirst({
        where: { customerId: id }
      });
      const serviceData = {};
      if (connectionType !== undefined) serviceData.connectionType = connectionType;
      if (vlanId !== undefined) serviceData.vlanId = vlanId;
      if (vlanPriority !== undefined) serviceData.vlanPriority = vlanPriority;
      if (oltId !== undefined) serviceData.oltId = oltId ? Number(oltId) : null;
      if (splitterId !== undefined) serviceData.splitterId = splitterId ? Number(splitterId) : null;
      if (oltPort !== undefined) serviceData.oltPort = oltPort ? String(oltPort) : null;
      if (splitterPort !== undefined) serviceData.splitterPort = splitterPort ? String(splitterPort) : null;
      if (serviceConn) {
        await req.prisma.customerServiceConnection.update({
          where: { id: serviceConn.id },
          data: serviceData
        });
      } else {
        await req.prisma.customerServiceConnection.create({
          data: { customerId: id, ...serviceData, status: 'pending' }
        });
      }
    }

    // Update Connection User (PPPoE / Radius Credentials)
    if (connectionUsername !== undefined && connectionPassword !== undefined) {
      if (connectionUsername || connectionPassword) {
        // Validate required fields if one is provided
        if (!connectionUsername || !connectionPassword) {
          return res.status(400).json({ error: "Both connection username and password are required to update credentials." });
        }

        // Check duplicate
        const duplicateUser = await req.prisma.connectionUser.findFirst({
          where: {
            username: connectionUsername,
            customerId: { not: id },
            isDeleted: false
          }
        });
        if (duplicateUser) {
          return res.status(400).json({ error: `Connection username '${connectionUsername}' is already in use by another customer.` });
        }

        const existingConnectionUser = await req.prisma.connectionUser.findFirst({
          where: { customerId: id, isDeleted: false }
        });

        const oldUsername = existingConnectionUser?.username;

        if (existingConnectionUser) {
          await req.prisma.connectionUser.update({
            where: { id: existingConnectionUser.id },
            data: { username: connectionUsername, password: connectionPassword }
          });
        } else {
          await req.prisma.connectionUser.create({
            data: {
              customerId: id,
              username: connectionUsername,
              password: connectionPassword,
              branchId: existing.branchId,
              ispId: req.ispId
            }
          });
        }

        // Sync to Radius
        try {
          const { RadiusClient } = require('../services/radiusClient');
          const radius = await RadiusClient.create(req.ispId);

          if (oldUsername) {
            try {
              await radius.deleteUser(oldUsername);
            } catch (err) {
              console.warn(`[RADIUS UPDATE] Delete old user failed: ${err.message}`);
            }
          }
          if (connectionUsername !== oldUsername) {
            try {
              await radius.deleteUser(connectionUsername);
            } catch (err) {
              console.warn(`[RADIUS UPDATE] Delete final user failed: ${err.message}`);
            }
          }

          // Fetch active subscription for expiry and package for group
          const subscription = await req.prisma.customerSubscription.findFirst({
            where: { customerId: id, isActive: true },
            include: { packagePrice: { include: { packagePlanDetails: true } } }
          });

          const expiryDate = subscription?.planEnd ? formatRadiusExpiration(subscription.planEnd) : null;

          const radiusGroupName =
            subscription?.packagePrice?.packagePlanDetails?.planCode ||
            subscription?.packagePrice?.referenceId ||
            subscription?.packagePrice?.packageName ||
            '';

          const attributes = {};
          if (expiryDate) attributes.Expiration = expiryDate;
          const groups = radiusGroupName ? [radiusGroupName] : [];

          await radius.createUser(connectionUsername, connectionPassword, attributes, groups);

          try {
            await radius.sendCoA(connectionUsername, { action: 'disconnect' });
          } catch (err) {
            console.warn(`[RADIUS UPDATE] sendCoA disconnect failed: ${err.message}`);
          }
        } catch (e) {
          console.error('Radius sync failed during customer update:', e.message);
        }
      }
    }

    // Perform updates in transaction
    const updated = await req.prisma.$transaction(async (tx) => {
      if (Object.keys(customerUpdate).length > 0) {
        await tx.customer.update({ where: { id }, data: customerUpdate });

        if (status !== undefined) {
          await tx.customerServiceConnection.updateMany({
            where: { customerId: id },
            data: { status: status === 'active' ? 'active' : 'inactive' }
          });

          // Sync with Radius if status is updated
          const pppUsers = await tx.connectionUser.findMany({
            where: { customerId: id, isDeleted: false },
            select: { username: true }
          });

          if (pppUsers.length > 0) {
            const subscription = await tx.customerSubscription.findFirst({
              where: { customerId: id, isActive: true }
            });
            const expiryDate = (status === 'active' && subscription) ? subscription.planEnd : new Date();
            
            const { RadiusClient } = require('../services/radiusClient');
            try {
              const radius = await RadiusClient.create(req.ispId);
              for (const cu of pppUsers) {
                await radius.updateExpiration(cu.username, expiryDate);
                await radius.disconnectAllSessions(cu.username).catch((err) => {
                  console.warn(`[RADIUS UPDATE] disconnect failed for ${cu.username}: ${err.message}`);
                });
              }
            } catch (e) {
              console.error('Radius sync failed during manual status update:', e.message);
            }
          }
        }
      }
      if (Object.keys(leadUpdate).length > 0) {
        await tx.lead.update({ where: { id: existing.leadId }, data: leadUpdate });
      }
      
      await logAudit(tx, req.user.id, 'CUSTOMER_UPDATE', { id, customerTypeId: targetTypeId }, req);
      
      return tx.customer.findUnique({
        where: { id },
        include: {
          lead: true,
          packagePrice: { include: { packagePlanDetails: true } },
          subscribedPkg: { include: { packagePlanDetails: true } },
          devices: true,
          serviceDetails: true,
          documents: { where: { isDeleted: false }, take: 1 },
          customerType: true,
          subBranch: { select: { id: true, name: true } }
        }
      });
    });

    // Flatten response
    const updatedMeta = updated?.lead?.metadata
      ? (typeof updated.lead.metadata === 'string' ? JSON.parse(updated.lead.metadata) : updated.lead.metadata)
      : {};
    const response = {
      ...updated,
      firstName: updated?.lead?.firstName || '',
      lastName: updated?.lead?.lastName || '',
      middleName: updated?.lead?.middleName || '',
      email: updated?.lead?.email || '',
      phoneNumber: updated?.lead?.phoneNumber || '',
      secondaryPhone: updated?.lead?.secondaryContactNumber || '',
      secondaryContactNumber: updated?.lead?.secondaryContactNumber || '',
      gender: updated?.lead?.gender || '',
      street: updated?.lead?.street || '',
      city: updatedMeta?.city || '',
      district: updated?.lead?.district || '',
      state: updated?.lead?.province || '',
      province: updated?.lead?.province || '',
      zipCode: updatedMeta?.zipCode || '',
      address: updated?.lead?.address || '',
      lead: undefined
    };

    return res.json({
      success: true,
      message: "Customer updated successfully",
      customer: response
    });
  } catch (err) {
    console.error("updateCustomer error:", err);
    return next(err);
  }
}

/**
 * Delete customer (soft delete) – also soft delete lead
 */
async function deleteCustomer(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

    const existing = await req.prisma.customer.findUnique({
      where: { id },
      include: {
        lead: true,
        serviceDetails: true,
        connectionUsers: true,
      }
    });
    if (!existing || existing.isDeleted || existing.ispId !== req.ispId) {
      return res.status(404).json({ error: "Customer not found" });
    }

    // Teardown / disconnect RADIUS users if present
    try {
      const { RadiusClient } = require('../services/radiusClient');
      const radius = await RadiusClient.create(req.ispId).catch(() => null);
      if (radius && existing.connectionUsers) {
        for (const cu of existing.connectionUsers) {
          if (cu.username) {
            await radius.deleteUser(cu.username).catch(() => {});
            await radius.sendCoA(cu.username, { action: 'disconnect' }).catch(() => {});
          }
        }
      }
    } catch (radErr) {
      console.warn('[deleteCustomer] Warning during RADIUS teardown:', radErr.message);
    }

    // Fetch all active inventory items assigned to this customer
    const assignedInventory = await req.prisma.InventoryItem.findMany({
      where: { customerId: id, ispId: req.ispId },
      select: { id: true, name: true, type: true, serialNumber: true, macAddress: true, status: true, branchId: true }
    });

    // Fetch all customer device records
    const customerDevices = await req.prisma.customerDevice.findMany({
      where: { customerId: id },
      select: { id: true, deviceType: true, brand: true, model: true, serialNumber: true, macAddress: true, ponSerial: true }
    });

    // Attempt to delete ONT from physical OLT prior to database deletion
    const oltId = Number(existing.serviceDetails?.[0]?.oltId || existing.oltId);
    for (const device of customerDevices) {
      const isOnt = String(device.deviceType || '').toUpperCase() === 'ONT' || Boolean(device.ponSerial);
      if (isOnt) {
        try {
          const printedSerial = String(device.ponSerial || device.serialNumber || '').trim().toUpperCase();
          const encodedSerial = /^[0-9A-F]{16}$/.test(printedSerial)
            ? printedSerial
            : printedSerial.length >= 8
              ? [...printedSerial.slice(0, 4)].map(char => char.charCodeAt(0).toString(16).padStart(2, '0')).join('').toUpperCase() + printedSerial.slice(4)
              : printedSerial;
          const serialCandidates = [...new Set([printedSerial, encodedSerial].filter(Boolean))];

          let ontRecord = null;
          if (oltId) {
            ontRecord = await req.prisma.oNT.findFirst({
              where: { oltId, isDeleted: false, serialNumber: { in: serialCandidates } },
              include: { ontDetails: true }
            });
          }
          if (!ontRecord && serialCandidates.length > 0) {
            ontRecord = await req.prisma.oNT.findFirst({
              where: { isDeleted: false, serialNumber: { in: serialCandidates } },
              include: { ontDetails: true }
            });
          }

          if (ontRecord) {
            const targetOltId = ontRecord.oltId || oltId;
            const oltDevice = await req.prisma.oLT.findFirst({
              where: { id: targetOltId, ispId: req.ispId, isDeleted: false }
            });

            if (oltDevice) {
              const [frame, slot, port] = String(ontRecord.servicePort || '').split('/').map(Number);
              const ontIdNum = Number(ontRecord.ontId);
              if (![frame, slot, port, ontIdNum].some(val => !Number.isInteger(val) || val < 0)) {
                const rawServicePorts = ontRecord.ontDetails?.servicePorts;
                const servicePortRows = Array.isArray(rawServicePorts) ? rawServicePorts : [];
                const servicePortIndices = servicePortRows
                  .map(row => Number(row?.index ?? row?.servicePortIndex ?? row?.service_port))
                  .filter(value => Number.isInteger(value) && value >= 0);

                const driver = getDriver(oltDevice);
                try {
                  await driver.connect();
                  await driver.deleteOnt({
                    frame,
                    slot,
                    port,
                    ont_id: ontIdNum,
                    serial: printedSerial,
                    service_port_indices: servicePortIndices
                  });
                } catch (driverErr) {
                  console.warn(`[deleteCustomer] Warning: Could not delete ONT from physical OLT: ${driverErr.message}`);
                } finally {
                  if (driver.ssh) {
                    try { driver.ssh.close(); } catch (closeErr) {}
                  }
                }
              }
            }
          }
        } catch (deviceOltErr) {
          console.warn(`[deleteCustomer] Warning during OLT device teardown: ${deviceOltErr.message}`);
        }
      }
    }

    await req.prisma.$transaction(async (tx) => {
      // 1. Automatically release assigned inventory items
      for (const item of assignedInventory) {
        const targetStatus = item.branchId ? 'ASSIGNED_TO_BRANCH' : 'IN_STOCK';
        await tx.InventoryItem.update({
          where: { id: item.id },
          data: {
            status: targetStatus,
            customerId: null,
            updatedAt: new Date()
          }
        });

        await tx.InventoryLog.create({
          data: {
            inventoryItemId: item.id,
            fromStatus: item.status,
            toStatus: targetStatus,
            toEntityId: item.branchId,
            entityType: item.branchId ? 'BRANCH' : 'HEAD_OFFICE',
            actionByUserId: req.user.id,
            note: `Unassigned: customer deleted`
          }
        });
      }

      // 2. Automatically delete customer device links and clean up ONT records
      for (const device of customerDevices) {
        await tx.customerDevice.delete({
          where: { id: device.id }
        });

        const printedSerial = String(device.ponSerial || device.serialNumber || '').trim().toUpperCase();
        const encodedSerial = /^[0-9A-F]{16}$/.test(printedSerial)
          ? printedSerial
          : printedSerial.length >= 8
            ? [...printedSerial.slice(0, 4)].map(char => char.charCodeAt(0).toString(16).padStart(2, '0')).join('').toUpperCase() + printedSerial.slice(4)
            : printedSerial;
        const serialCandidates = [...new Set([printedSerial, encodedSerial, device.serialNumber, device.ponSerial].filter(Boolean))];

        if (serialCandidates.length > 0) {
          await tx.oNT.updateMany({
            where: { serialNumber: { in: serialCandidates } },
            data: { isDeleted: true, status: 'unassigned', updatedAt: new Date() }
          });
        }

        const tr069Serials = [...new Set([device.serialNumber, device.ponSerial || device.serialNumber].filter(Boolean))];
        if (tr069Serials.length > 0) {
          await tx.tr069Device.updateMany({
            where: { ispId: req.ispId, serialNumber: { in: tr069Serials } },
            data: { leadId: null, updatedAt: new Date() }
          });
        }
      }

      // 3. Mark customer as deleted
      await tx.customer.update({
        where: { id },
        data: { isDeleted: true, status: 'deleted', onboardStatus: 'reverted_to_lead' }
      });

      // Suspend and soft-delete customer portal login
      await tx.user.updateMany({
        where: { customerId: id },
        data: { status: 'suspended', isDeleted: true, updatedAt: new Date() }
      });

      await tx.customerSubscription.updateMany({
        where: { customerId: id },
        data: { isActive: false, isInvoicing: false }
      });

      await tx.customerServiceConnection.updateMany({
        where: { customerId: id },
        data: { status: 'deleted' }
      });

      await tx.connectionUser.updateMany({
        where: { customerId: id },
        data: { isDeleted: true }
      });

      if (existing.leadId) {
        await tx.lead.update({
          where: { id: existing.leadId },
          data: {
            isDeleted: false,
            isActive: true,
            convertedToCustomer: false,
            convertedAt: null,
            convertedById: null,
            status: 'qualified'
          }
        });

        await tx.tr069Device.updateMany({
          where: { ispId: req.ispId, leadId: existing.leadId },
          data: { leadId: null, updatedAt: new Date() }
        });
      }

      // 4. Log audit event with full details of released inventory and devices
      await logAudit(tx, req.user.id, 'CUSTOMER_DELETE_REVERT_LEAD', {
        id,
        leadId: existing.leadId,
        releasedInventory: assignedInventory.map(item => ({
          id: item.id,
          name: item.name,
          type: item.type,
          serialNumber: item.serialNumber,
          macAddress: item.macAddress,
          releasedStatus: item.branchId ? 'ASSIGNED_TO_BRANCH' : 'IN_STOCK'
        })),
        customerDevices: customerDevices.map(d => ({
          id: d.id,
          type: d.deviceType,
          brand: d.brand,
          model: d.model,
          serialNumber: d.serialNumber,
          macAddress: d.macAddress
        }))
      }, req);
    });

    return res.json({
      success: true,
      message: "Customer removed, lead reverted, and assigned inventory released",
      id
    });
  } catch (err) {
    console.error("deleteCustomer error:", err);
    return next(err);
  }
}

/**
 * Subscribe package for customer (create order and extend subscription)
 */
const subscribePackage = async (req, res, next) => {
  try {
    const { customerId, createOrder } = req.body;
    if (!customerId) return res.status(400).json({ error: "customerId required" });

    const customer = await req.prisma.customer.findUnique({
      where: { id: Number(customerId), ispId: req.ispId, isDeleted: false },
      include: {
        lead: true,
        subscribedPkg: {
          select: {
            id: true,
            packageName: true,
            price: true,
            initialTotalWithTax: true,
            renewAmountWithTax: true,
            packageDuration: true,
            referenceId: true,
            oneTimeCharges: {
              where: { isDeleted: false },
              select: { id: true, name: true, amount: true, referenceId: true, isRenewal: true }
            }
          }
        }
      }
    });

    if (!customer) return res.status(404).json({ error: "Customer not found" });

    const pkg = customer.subscribedPkg;
    if (!pkg) return res.status(404).json({ error: "Customer has no subscribed package" });

    // FIX: use the correct database field 'isRechargeable'
    const isRechargeable = Boolean(customer.isRechargeable);
    const newPackageAmount = pkg.initialTotalWithTax !== null && pkg.initialTotalWithTax !== undefined
      ? Number(pkg.initialTotalWithTax)
      : Number(pkg.price || 0);
    const renewalAmount = pkg.renewAmountWithTax !== null && pkg.renewAmountWithTax !== undefined
      ? Number(pkg.renewAmountWithTax)
      : Number(pkg.price || 0);
    let packagePrice = isRechargeable ? renewalAmount : newPackageAmount;
    if (customer.isFree) {
      packagePrice = 0;
    }

    let otcItems = (pkg.oneTimeCharges || [])
      .filter(o => !isRechargeable || o.isRenewal)
      .map(o => ({
        id: o.id,
        name: o.name || "addon",
        referenceId: o.referenceId || null,
        amount: Number(o.amount || 0)
      }));
    if (customer.isFree) {
      otcItems = otcItems.map(it => ({ ...it, amount: 0 }));
    }

    const otcTotal = otcItems.reduce((s, it) => s + it.amount, 0);
    const totalAmount = customer.isFree ? 0 : packagePrice;

    if (!createOrder) {
      return res.json({
        customerId: customer.id,
        rechargeable: isRechargeable,
        subscribedPkg: {
          id: pkg.id,
          packageName: pkg.packageName,
          referenceId: pkg.referenceId,
          price: packagePrice,
          packageDuration: pkg.packageDuration
        },
        oneTimeCharges: otcItems,
        totals: { basePrice: packagePrice, oneTimeTotal: otcTotal, totalAmount }
      });
    }

    // Find active subscription
    const subscription = await req.prisma.customerSubscription.findFirst({
      where: { customerId: Number(customerId), isActive: true },
      orderBy: { createdAt: "desc" }
    });
    if (!subscription) {
      return res.status(404).json({
        error: "No active subscription found. Create subscription first."
      });
    }

    const renewalWindow = await getSubscriptionRenewalWindow(req.prisma, req.ispId, subscription);
    const previousPlanEnd = renewalWindow.planStart;
    const durationStr = String(pkg.packageDuration || "1 month");
    const expiryDateObj = computeExpiryFromBase(previousPlanEnd, durationStr);
    if (renewalWindow.trialDeductionDays > 0) expiryDateObj.setDate(expiryDateObj.getDate() - renewalWindow.trialDeductionDays);
    expiryDateObj.setHours(0, 0, 0, 0);

    const basePrice = customer.isFree ? 0 : (pkg.price || 0);
    const otcItemsTotal = otcItems.reduce((sum, item) => sum + item.amount, 0);
    const remainder = Math.max(0, basePrice - otcItemsTotal);
    
    const orderItemsData = [];
    if (remainder > 0 || otcItems.length === 0) {
      orderItemsData.push({
        itemName: pkg.packageName || "Base Package",
        referenceId: pkg.referenceId || null,
        itemPrice: remainder
      });
    }
    orderItemsData.push(...otcItems.map(it => ({
      itemName: it.name,
      referenceId: it.referenceId,
      itemPrice: it.amount
    })));

    const createdOrder = await req.prisma.$transaction(async tx => {
      const updatedSubData = {
        planEnd: expiryDateObj,
        isTrial: false,
        isInvoicing: true,
        extensionCount: 0,
        graceDaysBalance: 0,
        compensationDays: 0,
        adminExtensionDays: 0
      };
      if (subscription.isTrial) {
        updatedSubData.planStart = previousPlanEnd;
      }

      const updatedSubscription = await tx.customerSubscription.update({
        where: { id: subscription.id },
        data: updatedSubData
      });

      await tx.customer.update({
        where: { id: customer.id },
        data: {
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

      const order = await tx.customerOrderManagement.create({
        data: {
          customer: { connect: { id: customer.id } },
          subscription: { connect: { id: updatedSubscription.id } },
          packagePrice: { connect: { id: pkg.id } },
          packageStart: previousPlanEnd,
          packageEnd: updatedSubscription.planEnd,
          totalAmount,
          orderDate: new Date(),
          isActive: true,
          isDeleted: false,
          isPaid: true,
          items: {
            create: orderItemsData.map(it => ({
              itemName: it.itemName,
              referenceId: it.referenceId,
              itemPrice: it.itemPrice
            }))
          }
        },
        include: { items: true }
      });

      return order;
    });

    try {
      await syncOrderToAccounting(req.prisma, req.ispId, createdOrder.id);
    } catch (accountingError) {
      console.error('[CUSTOMER RECHARGE ACCOUNTING] Sales invoice sync failed:', accountingError.message);
    }

    await logAudit(req.prisma, req.user?.id, 'CUSTOMER_PACKAGE_RENEW', { id: customer.id, packageId: pkg.id, packageName: pkg.packageName, totalAmount }, req);

    try {
      const radius = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, req.ispId);
      const users = await req.prisma.connectionUser.findMany({
        where: { customerId: customer.id, isDeleted: false, isActive: true },
        select: { username: true }
      });
      for (const user of users) {
        if (!user.username) continue;
        await radius.updateExpiration(user.username, expiryDateObj);
        if (typeof radius.disconnectUserSession === 'function') {
          await radius.disconnectUserSession(user.username);
        } else {
          await radius.disconnectAllSessions(user.username).catch(error => {
            console.warn(`[CUSTOMER RECHARGE] RADIUS disconnect failed for ${user.username}:`, error.message);
          });
        }
      }
    } catch (radiusError) {
      console.error('[CUSTOMER RECHARGE] RADIUS synchronization failed:', radiusError.message);
    }

    return res.status(201).json({
      success: true,
      customerId: customer.id,
      subscriptionId: subscription.id,
      order: {
        id: createdOrder.id,
        packageStart: createdOrder.packageStart,
        packageEnd: createdOrder.packageEnd,
        totalAmount: createdOrder.totalAmount,
        items: createdOrder.items
      }
    });
  } catch (err) {
    console.error("subscribePackage error:", err);
    return next(err.message || err);
  }
};

/**
 * Change username – only database update
 */
async function changeUsername(req, res, next) {
  try {
    const customerId = Number(req.params.id);
    if (isNaN(customerId)) return res.status(400).json({ error: "Invalid customer ID" });

    const connectionUserId = Number(req.body.connectionUserId);
    const newUsername = String(req.body.newUsername || '').trim();
    if (!connectionUserId || !newUsername) {
      return res.status(400).json({ error: "connectionUserId and newUsername are required" });
    }

    const customer = await req.prisma.customer.findFirst({
      where: { id: customerId, isDeleted: false, ispId: req.ispId },
      include: { connectionUsers: { where: { isDeleted: false, isActive: true } } }
    });
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    const connectionUser = await req.prisma.connectionUser.findFirst({
      where: { id: connectionUserId, customerId, isDeleted: false, ispId: req.ispId }
    });
    if (!connectionUser) return res.status(404).json({ error: "Connection user not found" });

    const existing = await req.prisma.connectionUser.findFirst({
      where: { username: newUsername, isDeleted: false, ispId: req.ispId, id: { not: connectionUserId } }
    });
    if (existing) return res.status(409).json({ error: "Username already exists" });

    if (connectionUser.username === newUsername) {
      return res.json({ success: true, message: "Radius username is already up to date" });
    }

    let radiusResult;
    try {
      radiusResult = await renameRadiusUsername(req.ispId, connectionUser.username, newUsername);
    } catch (radiusError) {
      await logSystem(req.prisma, {
        ispId: req.ispId,
        userId: req.user?.id,
        level: 'ERROR',
        operation: 'RADIUS_CREDENTIAL_USERNAME_CHANGE',
        message: 'Radius username update failed',
        details: { customerId, connectionUserId, oldUsername: connectionUser.username, newUsername, error: radiusError.message },
      });
      return res.status(502).json({ error: "Unable to update Radius username" });
    }

    let updated;
    try {
      updated = await req.prisma.connectionUser.update({
        where: { id: connectionUserId },
        data: { username: newUsername }
      });
    } catch (databaseError) {
      await renameRadiusUsername(req.ispId, newUsername, connectionUser.username).catch(() => null);
      throw databaseError;
    }

    await logSystem(req.prisma, {
      ispId: req.ispId,
      userId: req.user?.id,
      level: 'INFO',
      operation: 'RADIUS_CREDENTIAL_USERNAME_CHANGE',
      message: 'Connection and Radius username updated successfully',
      details: { customerId, connectionUserId, oldUsername: connectionUser.username, newUsername, radiusResult },
    });

    return res.json({
      success: true,
      message: "Connection and Radius username updated successfully",
      data: { oldUsername: connectionUser.username, newUsername: updated.username, radiusUpdated: true }
    });
  } catch (err) {
    console.error("changeUsername error:", err);
    return next(err);
  }
}

async function changePortalPassword(req, res, next) {
  try {
    const customerId = Number(req.params.id);
    if (isNaN(customerId)) return res.status(400).json({ error: "Invalid customer ID" });

    const { email: requestedEmail, newPassword } = req.body;

    if (requestedEmail && !isValidPortalLoginIdentifier(requestedEmail)) {
      return res.status(400).json({ error: "Enter a valid portal username or email address" });
    }

    if (newPassword && newPassword.trim().length < 4) {
      return res.status(400).json({ error: "Password must be at least 4 characters long" });
    }

    const customer = await req.prisma.customer.findFirst({
      where: { id: customerId, isDeleted: false, ispId: req.ispId },
      include: { lead: true }
    });
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    const portalUser = await findPortalUserForCustomer(req.prisma, customer);
    const customerRole = await getCustomerRole(req.prisma);
    const name = `${customer.lead?.firstName || ''} ${customer.lead?.lastName || ''}`.trim() || customer.customerUniqueId || `Customer ${customer.id}`;

    let updatedUser;
    let portalAccountCreated = false;
    if (portalUser) {
      const updateData = { status: 'active', roleId: customerRole.id };
      if (newPassword) {
        updateData.passwordHash = await bcrypt.hash(newPassword, 10);
      }
      if (requestedEmail) {
        const normalizedEmail = toCustomerLoginEmail(requestedEmail);
        if (!normalizedEmail) return res.status(400).json({ error: "Portal email/username is required" });
        const existing = await req.prisma.user.findFirst({
          where: {
            email: normalizedEmail,
            isDeleted: false,
            id: { not: portalUser.id }
          }
        });
        if (existing) {
          return res.status(409).json({ error: "Email/username is already used by another user" });
        }
        updateData.email = normalizedEmail;
      }

      updatedUser = await req.prisma.user.update({
        where: { id: portalUser.id },
        data: {
          ...updateData,
          customerId: customer.id
        }
      });
    } else {
      if (!newPassword) {
        return res.status(400).json({ error: "Password is required to create a new portal account" });
      }
      let email = requestedEmail ? toCustomerLoginEmail(requestedEmail) : getCustomerPortalLoginEmail(customer);
      if (!email) return res.status(400).json({ error: "Unable to build portal login email/username" });
      const existing = await req.prisma.user.findUnique({ where: { email } });
      if (existing && existing.isDeleted === false) {
        return res.status(409).json({ error: "Portal login email is already used by another user" });
      }
      const passwordHash = await bcrypt.hash(newPassword, 10);
      updatedUser = await req.prisma.user.create({
        data: {
          email,
          passwordHash,
          name,
          roleId: customerRole.id,
          status: 'active',
          ispId: req.ispId ? Number(req.ispId) : null,
          branchId: customer.branchId || null,
          customerId: customer.id
        }
      });
      portalAccountCreated = true;
    }

    if (portalAccountCreated && customer.lead?.email) {
      const { enqueueJob } = require('../utils/backgroundQueue');
      enqueueJob(`portal welcome email for customer ${customer.id}`, async () => {
        const { getRequestBaseUrl } = require('../utils/requestBaseUrl');
        const mailHelper = require('../utils/mailHelper');
        const { renderTemplate, textToHtml } = require('../utils/templateHelper');
        const loginUrl = getRequestBaseUrl(req);
        const rendered = await renderTemplate(req.ispId, 'EMAIL', 'user_welcome', {
          userName: name,
          username: updatedUser.email,
          password: newPassword,
          loginUrl
        }, {
          subject: `Welcome, ${name}`,
          body: `Your account has been created.\n\nUsername: ${updatedUser.email}\nPassword: ${newPassword}\nLogin URL: ${loginUrl}`
        }, req.prisma);
        await mailHelper.sendMail(req.ispId, {
          to: customer.lead.email,
          subject: rendered.subject,
          html: textToHtml(rendered.body)
        }, { ignoreNotificationSetting: true });
      });
    }

    return res.json({
      success: true,
      message: portalUser ? "Portal credentials updated successfully" : "Portal account created successfully",
      data: {
        id: updatedUser.id,
        email: updatedUser.email,
        loginIdentifier: updatedUser.email.endsWith('@customer.local')
          ? updatedUser.email.slice(0, -'@customer.local'.length)
          : updatedUser.email,
        name: updatedUser.name,
        status: updatedUser.status,
        createdAt: updatedUser.createdAt,
        updatedAt: updatedUser.updatedAt
      }
    });
  } catch (err) {
    console.error("changePortalPassword error:", err);
    return next(err);
  }
}

async function changeConnectionUserPassword(req, res, next) {
  try {
    const customerId = Number(req.params.id);
    const connectionUserId = Number(req.params.connectionUserId);
    if (isNaN(customerId) || isNaN(connectionUserId)) {
      return res.status(400).json({ error: "Invalid customer or connection user ID" });
    }

    const { newPassword } = req.body;
    if (!newPassword || String(newPassword).trim().length < 4) {
      return res.status(400).json({ error: "Password must be at least 4 characters long" });
    }

    const customer = await req.prisma.customer.findFirst({
      where: { id: customerId, isDeleted: false, ispId: req.ispId }
    });
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    const connectionUser = await req.prisma.connectionUser.findFirst({
      where: { id: connectionUserId, customerId, isDeleted: false, ispId: req.ispId }
    });
    if (!connectionUser) return res.status(404).json({ error: "Connection user not found" });

    const password = String(newPassword).trim();
    try {
      await upsertRadiusPassword(req.ispId, connectionUser.username, password);
    } catch (radiusErr) {
      await logSystem(req.prisma, {
        ispId: req.ispId,
        userId: req.user?.id,
        level: 'ERROR',
        operation: 'RADIUS_CREDENTIAL_PASSWORD_CHANGE',
        message: 'Radius password update failed',
        details: { customerId, connectionUserId, username: connectionUser.username, error: radiusErr.message },
      });
      return res.status(502).json({ error: "Unable to update Radius password" });
    }

    let updated;
    try {
      updated = await req.prisma.connectionUser.update({
        where: { id: connectionUser.id },
        data: { password }
      });
    } catch (databaseError) {
      await upsertRadiusPassword(req.ispId, connectionUser.username, connectionUser.password).catch(() => null);
      throw databaseError;
    }

    await logSystem(req.prisma, {
      ispId: req.ispId,
      userId: req.user?.id,
      level: 'INFO',
      operation: 'RADIUS_CREDENTIAL_PASSWORD_CHANGE',
      message: 'Connection and Radius password updated successfully',
      details: { customerId, connectionUserId, username: connectionUser.username },
    });

    return res.json({
      success: true,
      message: "Connection and Radius password updated successfully",
      data: {
        id: updated.id,
        username: updated.username,
        radiusUpdated: true
      }
    });
  } catch (err) {
    console.error("changeConnectionUserPassword error:", err);
    return next(err);
  }
}

/**
 * Change package – updates customer's subscribed package and creates subscription/order
 */
async function changePackage(req, res, next) {
  try {
    const customerId = Number(req.params.id);
    if (isNaN(customerId)) return res.status(400).json({ error: "Invalid customer ID" });

    const { newPackageId } = req.body;
    if (!newPackageId) return res.status(400).json({ error: "newPackageId is required" });

    const customer = await req.prisma.customer.findFirst({
      where: { id: customerId, isDeleted: false, ispId: req.ispId },
      include: {
        subscribedPkg: { include: { packagePlanDetails: true } },
        customerSubscriptions: { where: { isActive: true }, take: 1, orderBy: { createdAt: 'desc' } }
      }
    });
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    if (req.body.requestApproval) {
      const requestedPackage = await req.prisma.packagePrice.findFirst({
        where: { id: Number(newPackageId), ispId: req.ispId, isDeleted: false, isActive: true },
        select: { planId: true }
      });
      if (!requestedPackage) return res.status(404).json({ error: "Package not found" });
      const branchId = customer.subBranchId || customer.branchId;
      if (branchId && !await req.prisma.packagePlanBranch.findUnique({
        where: { packagePlanId_branchId: { packagePlanId: requestedPackage.planId, branchId: Number(branchId) } }
      })) return res.status(400).json({ error: "Package is not assigned to this customer branch" });
      const targetBranch = await req.prisma.branch.findFirst({
        where: { id: req.branchId || customer.branchId || undefined, ispId: req.ispId }
      }) || await req.prisma.branch.findFirst({ where: { ispId: req.ispId } });

      if (targetBranch) {
        await req.prisma.branchRequest.create({
          data: {
            ispId: req.ispId,
            branchId: targetBranch.id,
            customerId: customerId,
            type: 'PACKAGE_CHANGE',
            status: 'PENDING',
            details: JSON.stringify({ newPackageId: Number(newPackageId) }),
            reason: req.body.reason || 'Package change requested by branch user',
            requestedBy: req.user.id
          }
        });
        return res.json({ success: true, message: "Package change request submitted to admin for approval." });
      }
    }

    const newPackage = await req.prisma.packagePrice.findFirst({
      where: { id: Number(newPackageId), isDeleted: false, ispId: req.ispId },
      include: { packagePlanDetails: true }
    });
    if (!newPackage) return res.status(404).json({ error: "Package not found" });
    const branchId = customer.subBranchId || customer.branchId;
    if (branchId && !await req.prisma.packagePlanBranch.findUnique({
      where: { packagePlanId_branchId: { packagePlanId: newPackage.planId, branchId: Number(branchId) } }
    })) return res.status(400).json({ error: "Package is not assigned to this customer branch" });

    let updatedSubscription;
    await req.prisma.$transaction(async (tx) => {
      // Update customer's subscribed package
      await tx.customer.update({
        where: { id: customerId },
        data: { subscribedPkgId: Number(newPackageId), assignedPkg: Number(newPackageId) }
      });

      const now = new Date();

      if (customer.customerSubscriptions.length > 0) {
        const sub = customer.customerSubscriptions[0];
        updatedSubscription = await tx.customerSubscription.update({
          where: { id: sub.id },
          data: {
            packagePrice: { connect: { id: Number(newPackageId) } },
            updatedAt: now
          }
        });
      } else {
        const expiryDate = computeExpiryFromBase(String(newPackage.packageDuration || '1 Month'));
        updatedSubscription = await tx.customerSubscription.create({
          data: {
            customer: { connect: { id: customerId } },
            packagePrice: { connect: { id: Number(newPackageId) } },
            planStart: now,
            planEnd: expiryDate,
            isTrial: newPackage.isTrial || false,
            isInvoicing: true,
            isActive: true
          }
        });
      }
    });

    // Sync package change to RADIUS (update radusergroup and send CoA disconnect)
    try {
      const connectionUser = await req.prisma.connectionUser.findFirst({
        where: { customerId, isDeleted: false }
      });
      if (connectionUser) {
        const { RadiusClient } = require('../services/radiusClient');
        const radiusClient = await RadiusClient.create(req.ispId);
        const planCode = newPackage.packagePlanDetails?.planCode ||
                         newPackage.packagePlanDetails?.planName ||
                         newPackage.packageName;
        if (planCode) {
          await radiusClient.updateUserGroup(connectionUser.username, planCode);
        }
        await radiusClient.sendCoA(connectionUser.username, { action: 'disconnect' }).catch(() => {});
      }
    } catch (radErr) {
      console.warn('[CHANGE PACKAGE] RADIUS update error:', radErr.message);
    }

    await logAudit(req.prisma, req.user?.id, 'CUSTOMER_PACKAGE_CHANGE', { id: customerId, newPackageId: Number(newPackageId), packageName: newPackage.packageName }, req);

    return res.json({
      success: true,
      message: "Package updated successfully",
      data: { oldPackage: customer.subscribedPkg, newPackage, subscription: updatedSubscription }
    });
  } catch (err) {
    console.error("changePackage error:", err);
    return next(err);
  }
}

/**
 * Reset MAC address – updates or creates device record
 */
async function resetMac(req, res, next) {
  try {
    const customerId = Number(req.params.id);
    if (isNaN(customerId)) return res.status(400).json({ error: "Invalid customer ID" });

    const { newMacAddress } = req.body;
    if (!newMacAddress) return res.status(400).json({ error: "newMacAddress is required" });

    const compactMac = String(newMacAddress).trim().replace(/[^0-9A-Fa-f]/g, '');
    if (!/^[0-9A-Fa-f]{12}$/.test(compactMac)) {
      return res.status(400).json({ error: "Invalid MAC address format" });
    }
    const normalizedMacAddress = compactMac.match(/.{2}/g).join(':').toUpperCase();

    const customer = await req.prisma.customer.findFirst({
      where: { id: customerId, isDeleted: false, ispId: req.ispId }
    });
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    // Find ONT device
    const device = await req.prisma.customerDevice.findFirst({
      where: { customerId, deviceType: 'ONT' }
    });

    let updatedDevice;
    if (device) {
      updatedDevice = await req.prisma.customerDevice.update({
        where: { id: device.id },
        data: { macAddress: normalizedMacAddress }
      });
    } else {
      updatedDevice = await req.prisma.customerDevice.create({
        data: {
          customerId,
          deviceType: 'ONT',
          macAddress: normalizedMacAddress,
          provisioningStatus: 'pending'
        }
      });
    }

    let radiusSynced = false;
    let radiusMessage = null;
    try {
      const radius = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, req.ispId);
      const replies = await radius.getRadreply();
      const allReplies = Array.isArray(replies) ? replies : [];

      for (const connectionUser of customer.connectionUsers) {
        const checks = await radius.getRadcheckByUsername(connectionUser.username).catch(() => []);
        const bindings = (Array.isArray(checks) ? checks : []).filter(entry =>
          String(entry.attribute || '').trim().toLowerCase() === 'calling-station-id'
        );
        const staleReplyBindings = allReplies.filter(entry =>
          entry.username === connectionUser.username &&
          String(entry.attribute || '').trim().toLowerCase() === 'calling-station-id'
        );
        await Promise.all(staleReplyBindings.map(entry => radius.deleteRadreply(entry.id)));
        if (bindings.length) {
          await Promise.all(bindings.map(entry => radius.updateRadcheck(entry.id, {
            op: '==',
            value: normalizedMacAddress
          })));
        } else {
          await radius.createRadcheck({
            username: connectionUser.username,
            attribute: 'Calling-Station-Id',
            op: '==',
            value: normalizedMacAddress
          });
        }
        await radius.disconnectAllSessions(connectionUser.username).catch((disconnectError) => {
          console.warn(`[RADIUS MAC] MAC updated but disconnect failed for ${connectionUser.username}: ${disconnectError.message}`);
        });
      }
      radiusSynced = true;
    } catch (radiusError) {
      radiusMessage = radiusError.message || 'RADIUS MAC update failed';
      console.error('Radius MAC sync failed during customer MAC update:', radiusMessage);
    }

    return res.json({
      success: true,
      message: radiusSynced
        ? "MAC address updated successfully in customer and RADIUS"
        : "MAC address updated in customer, but RADIUS sync failed",
      data: {
        oldMacAddress: device?.macAddress || null,
        newMacAddress: updatedDevice.macAddress,
        radiusSynced,
        radiusMessage
      }
    });
  } catch (err) {
    console.error("resetMac error:", err);
    return next(err);
  }
}

/**
 * Get customer documents
 */
async function getCustomerDocuments(req, res, next) {
  try {
    const customerId = Number(req.params.id);
    if (isNaN(customerId)) return res.status(400).json({ error: "Invalid customer ID" });

    const documents = await req.prisma.customerDocument.findMany({
      where: { customerId, isDeleted: false, ispId: req.ispId },
      orderBy: { uploadedAt: 'desc' }
    });
    return res.json(enrichCustomerDocuments(documents));
  } catch (err) {
    console.error("getCustomerDocuments error:", err);
    return next(err);
  }
}

/**
 * Download document
 */
async function downloadDocument(req, res, next) {
  try {
    const documentId = Number(req.params.documentId);
    if (isNaN(documentId)) return res.status(400).json({ error: "Invalid document ID" });

    const document = await req.prisma.customerDocument.findFirst({
      where: { id: documentId, isDeleted: false, ispId: req.ispId }
    });
    if (!document) return res.status(404).json({ error: "Document not found" });

    const filePath = document.filePath;
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found on server" });
    }
    if (req.query.inline === '1' || req.query.disposition === 'inline') {
      res.setHeader('Content-Type', document.mimeType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(document.fileName)}"`);
      return res.sendFile(path.resolve(filePath));
    }

    res.download(filePath, document.fileName);
  } catch (err) {
    console.error("downloadDocument error:", err);
    return next(err);
  }
}

/**
 * Delete document
 */
async function deleteDocument(req, res, next) {
  try {
    const documentId = Number(req.params.documentId);
    if (isNaN(documentId)) return res.status(400).json({ error: "Invalid document ID" });

    const document = await req.prisma.customerDocument.findFirst({
      where: { id: documentId, ispId: req.ispId }
    });
    if (!document) return res.status(404).json({ error: "Document not found" });

    await req.prisma.customerDocument.update({
      where: { id: documentId },
      data: { isDeleted: true }
    });

    if (fs.existsSync(document.filePath)) {
      fs.unlinkSync(document.filePath);
    }

    return res.json({ success: true, message: "Document deleted successfully" });
  } catch (err) {
    console.error("deleteDocument error:", err);
    return next(err);
  }
}

/**
 * Upload customer documents
 */
async function uploadCustomerDocuments(req, res, next) {
  try {
    const customerId = Number(req.params.id);
    if (isNaN(customerId)) return res.status(400).json({ error: "Invalid customer ID" });

    const customer = await req.prisma.customer.findFirst({
      where: { id: customerId, isDeleted: false, ispId: req.ispId }
    });
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    const documents = await saveCustomerDocuments(req.prisma, customerId, req.files, req.ispId);
    return res.json({ success: true, message: "Documents uploaded successfully", documents });
  } catch (err) {
    console.error("uploadCustomerDocuments error:", err);
    return next(err);
  }
}

async function uploadCustomerProfilePhoto(req, res, next) {
  try {
    const customer = await findCustomerForAuthenticatedUser(req.prisma, req);
    if (!customer) {
      return res.status(404).json({ success: false, error: "Customer profile not found" });
    }

    const photo = req.files?.photo?.[0];
    if (!photo) {
      return res.status(400).json({ success: false, error: "Photo file is required" });
    }

    const profilePicture = `/uploads/customers/documents/${path.basename(photo.path)}`;
    const portalUserId = req.user?.id || customer.portalUser?.id;
    if (portalUserId) {
      await req.prisma.user.update({
        where: { id: portalUserId },
        data: { profilePicture }
      });
    }

    await req.prisma.customerDocument.upsert({
      where: {
        customerId_documentType: {
          customerId: customer.id,
          documentType: 'profilePhoto'
        }
      },
      update: {
        fileName: photo.originalname,
        filePath: photo.path,
        mimeType: photo.mimetype,
        size: photo.size,
        uploadedAt: new Date(),
        isDeleted: false,
        ispId: customer.ispId,
        branchId: customer.branchId
      },
      create: {
        customerId: customer.id,
        documentType: 'profilePhoto',
        fileName: photo.originalname,
        filePath: photo.path,
        mimeType: photo.mimetype,
        size: photo.size,
        ispId: customer.ispId,
        branchId: customer.branchId
      }
    });

    return res.json({
      success: true,
      message: "Profile image uploaded successfully",
      data: { profilePicture }
    });
  } catch (err) {
    console.error("uploadCustomerProfilePhoto error:", err);
    return next(err);
  }
}

async function changeOwnPortalPassword(req, res, next) {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ success: false, error: "Current password, new password and confirm password are required." });
    }
    if (String(newPassword).length < 8) {
      return res.status(400).json({ success: false, error: "New password must be at least 8 characters." });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ success: false, error: "New password and confirm password do not match." });
    }

    const customer = await findCustomerForAuthenticatedUser(req.prisma, req);
    if (!customer) {
      return res.status(404).json({ success: false, error: "Customer profile not found" });
    }

    const user = await req.prisma.user.findFirst({
      where: {
        id: req.user?.id,
        customerId: customer.id,
        ispId: req.ispId,
        isDeleted: false
      }
    });
    if (!user) {
      return res.status(404).json({ success: false, error: "Portal user not found." });
    }

    const isCurrentValid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!isCurrentValid) {
      return res.status(400).json({ success: false, error: "Current password is incorrect." });
    }

    await req.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(newPassword, 10) }
    });

    return res.json({ success: true, message: "Login password changed successfully." });
  } catch (err) {
    console.error("changeOwnPortalPassword error:", err);
    return next(err);
  }
}

async function listOwnReferrals(req, res, next) {
  try {
    const customer = await findCustomerForAuthenticatedUser(req.prisma, req);
    if (!customer) {
      return res.status(404).json({ success: false, error: "Customer profile not found" });
    }
    const referrals = await req.prisma.customerReferral.findMany({
      where: { customerId: customer.id, ispId: req.ispId },
      orderBy: { createdAt: 'desc' }
    });
    return res.json({ success: true, data: referrals });
  } catch (err) {
    console.error("listOwnReferrals error:", err);
    return next(err);
  }
}

async function createOwnReferral(req, res, next) {
  try {
    const customer = await findCustomerForAuthenticatedUser(req.prisma, req);
    if (!customer) {
      return res.status(404).json({ success: false, error: "Customer profile not found" });
    }

    const friendName = String(req.body.friendName || req.body.name || '').trim();
    const friendPhone = String(req.body.friendPhone || req.body.phone || '').trim();
    const friendEmail = String(req.body.friendEmail || req.body.email || '').trim();
    const friendAddress = String(req.body.friendAddress || req.body.address || '').trim();

    if (!friendName || !friendPhone) {
      return res.status(400).json({ success: false, error: "Friend name and phone are required." });
    }

    const referral = await req.prisma.customerReferral.create({
      data: {
        customerId: customer.id,
        ispId: req.ispId,
        friendName,
        friendPhone,
        friendEmail: friendEmail || null,
        friendAddress: friendAddress || null,
        status: 'pending',
        offerNote: 'Once approved, both the referrer and friend receive the active referral offer.'
      }
    });

    return res.status(201).json({ success: true, message: "Referral submitted for approval.", data: referral });
  } catch (err) {
    console.error("createOwnReferral error:", err);
    return next(err);
  }
}

/**
 * Get customer status summary
 */
async function getCustomerStatusSummary(req, res, next) {
  try {
    const ispId = req.ispId;
    const [total, draft, active, inactive] = await Promise.all([
      req.prisma.customer.count({ where: { ispId, isDeleted: false } }),
      req.prisma.customer.count({ where: { ispId, status: 'draft', isDeleted: false } }),
      req.prisma.customer.count({ where: { ispId, status: 'active', isDeleted: false } }),
      req.prisma.customer.count({ where: { ispId, status: 'inactive', isDeleted: false } })
    ]);

    return res.json({
      total,
      byStatus: { draft, active, inactive },
      percentage: {
        draft: total > 0 ? Math.round((draft / total) * 100) : 0,
        active: total > 0 ? Math.round((active / total) * 100) : 0,
        inactive: total > 0 ? Math.round((inactive / total) * 100) : 0
      }
    });
  } catch (err) {
    console.error("getCustomerStatusSummary error:", err);
    return next(err);
  }
}

async function updateCustomerDevice(req, res, next) {
  const prisma = req.prisma;
  const customerId = Number(req.params.id);
  const deviceId = Number(req.params.deviceId);
  if (isNaN(customerId) || isNaN(deviceId)) {
    return res.status(400).json({ error: 'Invalid customer or device ID' });
  }

  const { brand, model, serialNumber, macAddress, ponSerial, ponVendorIdIncluded, provisioningStatus, notes } = req.body;

  try {
    const device = await prisma.customerDevice.findFirst({
      where: { id: deviceId, customerId, customer: { ispId: req.ispId } }
    });

    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const updated = await prisma.customerDevice.update({
      where: { id: deviceId },
      data: {
        brand: brand !== undefined ? brand : device.brand,
        model: model !== undefined ? model : device.model,
        serialNumber: serialNumber !== undefined ? serialNumber : device.serialNumber,
        macAddress: macAddress !== undefined ? macAddress : device.macAddress,
        ponSerial: ponSerial !== undefined ? ponSerial : device.ponSerial,
        ponVendorIdIncluded: ponVendorIdIncluded !== undefined ? Boolean(ponVendorIdIncluded) : device.ponVendorIdIncluded,
        provisioningStatus: provisioningStatus !== undefined ? provisioningStatus : device.provisioningStatus,
        notes: notes !== undefined ? notes : device.notes,
        updatedAt: new Date()
      }
    });

    await logAudit(prisma, req.user.id, 'CUSTOMER_DEVICE_UPDATE', { customerId, deviceId, provisioningStatus }, req);

    return res.json({ success: true, data: updated });
  } catch (err) {
    console.error("updateCustomerDevice error:", err);
    return next(err);
  }
}

async function updateCustomerProvisioningStatus(req, res, next) {
  const customerId = Number(req.params.id);
  const requestedStatus = String(req.body?.status || '').trim().toLowerCase();
  if (!Number.isInteger(customerId)) return res.status(400).json({ error: 'Invalid customer ID' });

  const statusMap = { active: 'active', complete: 'active', completed: 'active', provisioned: 'active', pending: 'pending' };
  const status = statusMap[requestedStatus];
  if (!status) return res.status(400).json({ error: 'Status must be active or pending' });

  try {
    const customer = await req.prisma.customer.findFirst({ where: { id: customerId, ispId: req.ispId } });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const now = new Date();
    const results = await req.prisma.$transaction([
      req.prisma.customer.update({
        where: { id: customerId },
        data: status === 'active' ? { status: 'active', onboardStatus: 'fully_onboarded', updatedAt: now } : { updatedAt: now }
      }),
      req.prisma.customerDevice.updateMany({
        where: { customerId, deviceType: 'ONT' },
        data: { provisioningStatus: status, updatedAt: now }
      }),
      req.prisma.customerServiceConnection.updateMany({
        where: { customerId },
        data: {
          status,
          provisioningNotes: `${status === 'active' ? 'Completed' : 'Reset to pending'} manually by ${req.user?.email || req.user?.id || 'operator'} on ${now.toISOString()}`,
          updatedAt: now
        }
      })
    ]);

    await logAudit(req.prisma, req.user.id, 'CUSTOMER_PROVISIONING_STATUS_UPDATE', { customerId, status }, req);
    return res.json({
      success: true,
      message: status === 'active' ? 'Customer provisioning and assigned ONT marked active' : 'Customer provisioning and assigned ONT marked pending',
      data: { status, devicesUpdated: results[1].count, connectionsUpdated: results[2].count }
    });
  } catch (error) {
    console.error('updateCustomerProvisioningStatus error:', error);
    return next(error);
  }
}

async function deleteCustomerDevice(req, res, next) {
  const prisma = req.prisma;
  const customerId = Number(req.params.id);
  const deviceId = Number(req.params.deviceId);
  if (isNaN(customerId) || isNaN(deviceId)) {
    return res.status(400).json({ error: 'Invalid customer or device ID' });
  }

  try {
    const device = await prisma.customerDevice.findFirst({
      where: { id: deviceId, customerId, customer: { ispId: req.ispId } },
      include: {
        customer: {
          select: {
            oltId: true,
            serviceDetails: { where: { oltId: { not: null } }, orderBy: { updatedAt: 'desc' }, take: 1 }
          }
        }
      }
    });

    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    let oltDeletion = null;
    let ont = null;
    if (String(device.deviceType || '').toUpperCase() === 'ONT') {
      const oltId = Number(device.customer?.serviceDetails?.[0]?.oltId || device.customer?.oltId);
      const printedSerial = String(device.ponSerial || device.serialNumber || '').trim().toUpperCase();
      const encodedSerial = /^[0-9A-F]{16}$/.test(printedSerial)
        ? printedSerial
        : printedSerial.length >= 8
          ? [...printedSerial.slice(0, 4)].map(char => char.charCodeAt(0).toString(16).padStart(2, '0')).join('').toUpperCase() + printedSerial.slice(4)
          : printedSerial;
      const serialCandidates = [...new Set([printedSerial, encodedSerial].filter(Boolean))];

      if (oltId) {
        ont = await prisma.oNT.findFirst({
          where: { oltId, isDeleted: false, serialNumber: { in: serialCandidates } },
          include: { ontDetails: true }
        });

        if (ont) {
          const [frame, slot, port] = String(ont.servicePort || '').split('/').map(Number);
          const ontId = Number(ont.ontId);
          const rawServicePorts = ont.ontDetails?.servicePorts;
          const servicePortRows = Array.isArray(rawServicePorts) ? rawServicePorts : [];
          const servicePortIndices = servicePortRows
            .map(row => Number(row?.index ?? row?.servicePortIndex ?? row?.service_port))
            .filter(value => Number.isInteger(value) && value >= 0);

          if ([frame, slot, port, ontId].every(value => Number.isInteger(value) && value >= 0)) {
            const oltDevice = await prisma.oLT.findFirst({ where: { id: oltId, ispId: req.ispId, isDeleted: false } });
            if (oltDevice) {
              const driver = getDriver(oltDevice);
              try {
                await driver.connect();
                oltDeletion = await driver.deleteOnt({
                  frame,
                  slot,
                  port,
                  ont_id: ontId,
                  serial: printedSerial,
                  service_port_indices: servicePortIndices
                });
              } catch (driverErr) {
                console.warn(`[deleteCustomerDevice] OLT deletion failed or device already removed (${driverErr.message}). Continuing with local database and inventory cleanup.`);
                oltDeletion = {
                  skipped: true,
                  warning: `OLT deletion skipped or device not on OLT: ${driverErr.message}`
                };
              } finally {
                if (driver && driver.ssh) {
                  try { driver.ssh.close(); } catch (e) {}
                }
              }
            } else {
              console.warn(`[deleteCustomerDevice] Associated OLT ${oltId} not found. Continuing with local cleanup.`);
            }
          } else {
            console.warn(`[deleteCustomerDevice] Invalid frame/slot/port/ontId for ONT ${ont.id}. Continuing with local cleanup.`);
          }
        } else {
          console.warn(`[deleteCustomerDevice] ONT serial ${printedSerial} not found in synchronized OLT inventory. Continuing with local cleanup.`);
        }
      } else {
        console.warn(`[deleteCustomerDevice] Customer has no associated OLT. Continuing with local cleanup.`);
      }
    }

    // Perform database operations in transaction to guarantee consistency
    await prisma.$transaction(async (tx) => {
      // 1. Delete CustomerDevice
      await tx.customerDevice.delete({
        where: { id: deviceId }
      });

      // Mark corresponding ONT as deleted in synchronized OLT inventory
      if (ont) {
        await tx.oNT.update({
          where: { id: ont.id },
          data: {
            isDeleted: true,
            updatedAt: new Date()
          }
        });
      }

      // Unlink and remove from TR069 device
      const tr069Serials = [...new Set([device.serialNumber, device.ponSerial].filter(Boolean).map(s => String(s).trim()))];
      if (tr069Serials.length > 0) {
        await tx.tr069Device.updateMany({
          where: {
            ispId: req.ispId,
            OR: [
              { serialNumber: { in: tr069Serials } },
              device.macAddress ? { macAddress: String(device.macAddress).trim() } : undefined
            ].filter(Boolean)
          },
          data: {
            isDeleted: true,
            isActive: false,
            leadId: null,
            customerId: null,
            updatedAt: new Date()
          }
        });

        // Also delete from GenieACS if present
        try {
          const genieClient = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, req.ispId).catch(() => null);
          if (genieClient) {
            for (const s of tr069Serials) {
              await genieClient.deleteDevice(s).catch(err => {
                console.warn(`[deleteCustomerDevice] Could not delete ${s} from GenieACS:`, err.message);
              });
            }
          }
        } catch (gErr) {
          console.warn(`[deleteCustomerDevice] GenieACS deletion warning:`, gErr.message);
        }
      }

      // 2. Unassign corresponding InventoryItem if it exists and is assigned to this customer
      const invSerials = [...new Set([device.serialNumber, device.ponSerial].filter(Boolean).map(s => String(s).trim()))];
      for (const s of invSerials) {
        const invItem = await tx.InventoryItem.findFirst({
          where: {
            ispId: req.ispId,
            OR: [
              { serialNumber: s },
              { ponSerialNumber: s }
            ],
            customerId
          }
        });
        if (invItem) {
          const targetStatus = invItem.branchId ? 'ASSIGNED_TO_BRANCH' : 'IN_STOCK';
          await tx.InventoryItem.update({
            where: { id: invItem.id },
            data: {
              status: targetStatus,
              customerId: null,
              updatedAt: new Date()
            }
          });
          
          await tx.InventoryLog.create({
            data: {
              inventoryItemId: invItem.id,
              fromStatus: invItem.status,
              toStatus: targetStatus,
              toEntityId: invItem.branchId,
              entityType: invItem.branchId ? 'BRANCH' : 'HEAD_OFFICE',
              actionByUserId: req.user?.id || null,
              note: `Unassigned via customer device deletion of serial: ${s}`
            }
          });
        }
      }

      if (req.user?.id) {
        await logAudit(tx, req.user.id, 'CUSTOMER_DEVICE_DELETE', { customerId, deviceId, serialNumber: device.serialNumber }, req);
      }
    });

    return res.json({ success: true, message: 'Device deleted successfully', oltDeletion });
  } catch (err) {
    console.error("deleteCustomerDevice error:", err);
    return next(err);
  }
}

function eui64ToMac(eui) {
  if (!eui || typeof eui !== 'string') return null;
  const hex = eui.replace(/[:-]/g, '').toLowerCase();
  if (hex.length !== 16) return null;
  
  const b0 = parseInt(hex.substring(0, 2), 16);
  const b1 = hex.substring(2, 4);
  const b2 = hex.substring(4, 6);
  const b3 = hex.substring(6, 8);
  const b4 = hex.substring(8, 10);
  const b5 = hex.substring(10, 12);
  const b6 = hex.substring(12, 14);
  const b7 = hex.substring(14, 16);
  
  if (b3 === 'ff' && b4 === 'fe') {
    const newB0 = (b0 ^ 2).toString(16).padStart(2, '0');
    return `${newB0}:${b1}:${b2}:${b5}:${b6}:${b7}`;
  }
  return null;
}

function findMacAddress(...values) {
  const macRegex = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/;
  for (const val of values) {
    if (val && typeof val === 'string' && macRegex.test(val)) {
      return val.toUpperCase();
    }
  }
  // Try to find any value that contains a mac-like substring
  for (const val of values) {
    if (val && typeof val === 'string') {
      const cleaned = val.replace(/[:-]/g, '');
      if (cleaned.length === 12 && /^[0-9A-Fa-f]{12}$/.test(cleaned)) {
        return cleaned.match(/.{1,2}/g).join(':').toUpperCase();
      }
    }
  }
  return 'N/A';
}

async function getCustomerRadiusAuthLogs(req, res, next) {
  const prisma = req.prisma;
  const customerId = Number(req.params.id);
  if (isNaN(customerId)) return res.status(400).json({ error: 'Invalid customer ID' });

  try {
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      include: {
        connectionUsers: {
          where: { isDeleted: false }
        },
        devices: true
      }
    });

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    let client;
    try {
      client = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, req.ispId);
    } catch (err) {
      return res.json({
        success: true,
        data: customer.connectionUsers.length > 0
          ? customer.connectionUsers.map((user) => ({
              id: `missing-${user.id}`,
              date: null,
              username: user.username,
              password: 'N/A',
              mac: 'N/A',
              calledId: 'N/A',
              framedIp: 'N/A',
              nasIp: 'N/A',
              nasPort: 'N/A',
              reply: 'N/A',
              reason: 'Radius service is not configured or enabled'
            }))
          : [],
        message: 'Radius service is not configured or enabled.'
      });
    }

    const ontDevice = customer.devices?.find(d => d.deviceType === 'ONT') || customer.devices?.[0] || null;
    const deviceMac = ontDevice?.macAddress || ontDevice?.mac || null;
    const allLogs = [];
    for (const user of customer.connectionUsers) {
      const username = user.username;
      
      const [postAuth, radAcct, radChecks] = await Promise.all([
        client.getRadpostauthByUsername(username).catch(() => []),
        client.getRadacctByUsername(username).catch(() => []),
        client.getRadcheckByUsername(username).catch(() => [])
      ]);
      const macBinding = (Array.isArray(radChecks) ? radChecks : []).find(
        (entry) => String(entry.attribute || '').trim().toLowerCase() === 'calling-station-id'
      );
      const normalizedBoundMac = macBinding?.value ? findMacAddress(String(macBinding.value)) : null;
      const boundMac = normalizedBoundMac === 'N/A' ? null : normalizedBoundMac;

      // Sort and take only the latest Access-Accept and latest Access-Reject
      const sortedPostAuth = [...postAuth].sort((a, b) => new Date(b.authdate).getTime() - new Date(a.authdate).getTime());
      const filteredPostAuth = [];
      const latestAccept = sortedPostAuth.find(log => log.reply === 'Access-Accept');
      const latestReject = sortedPostAuth.find(log => log.reply === 'Access-Reject');
      if (latestAccept) filteredPostAuth.push(latestAccept);
      if (latestReject) filteredPostAuth.push(latestReject);

      const enriched = filteredPostAuth.map(log => {
        const logTime = new Date(log.authdate).getTime();
        
        let matchedSession = null;
        if (log.reply === 'Access-Accept' && Array.isArray(radAcct) && radAcct.length > 0) {
          // An Access-Accept can be written while a PPP session that started days
          // earlier is still active. Prefer that active session; otherwise use the
          // accounting record whose start/update time is closest to the auth event.
          const activeSessions = radAcct.filter(session => !session.acctstoptime && !session.acctStopTime);
          const candidates = activeSessions.length > 0 ? activeSessions : radAcct;
          matchedSession = [...candidates].sort((a, b) => {
            const aTime = new Date(a.acctupdatetime || a.acctUpdateTime || a.acctstarttime || a.acctStartTime || 0).getTime();
            const bTime = new Date(b.acctupdatetime || b.acctUpdateTime || b.acctstarttime || b.acctStartTime || 0).getTime();
            return Math.abs(aTime - logTime) - Math.abs(bTime - logTime);
          })[0] || null;
        }

        const mac = findMacAddress(
          eui64ToMac(matchedSession?.framedinterfaceid || matchedSession?.framedInterfaceId),
          matchedSession?.callingstationid || matchedSession?.callingStationId,
          log.callingstationid || log.callingStationId,
          log.mac,
          deviceMac
        );
        const calledId = log.calledstationid || log.calledStationId || matchedSession?.calledstationid || matchedSession?.calledStationId || 'N/A';
        const framedIp = log.framedipaddress || log.framedIpAddress || matchedSession?.framedipaddress || matchedSession?.framedIpAddress || 'N/A';
        const nasIp = log.nasipaddress || log.nasIpAddress || log.nas || matchedSession?.nasipaddress || matchedSession?.nasIpAddress || 'N/A';
        const nasPort = log.nasportid || log.nasPortId || matchedSession?.nasportid || matchedSession?.nasPortId || 'N/A';
        const reason = log.reply === 'Access-Accept' ? 'Login Success' : 'Incorrect credentials / access-reject';

        return {
          id: log.id,
          date: log.authdate,
          username: log.username,
          password: log.reply === 'Access-Reject' ? (log.pass || 'N/A') : '••••••••',
          mac,
          calledId,
          framedIp,
          nasIp,
          nasPort,
          reply: log.reply,
          reason: log.class || reason,
          boundMac
        };
      });

      allLogs.push(...enriched);

      if (enriched.length === 0 && Array.isArray(radAcct) && radAcct.length > 0) {
        allLogs.push(...radAcct.map((session) => ({
          id: session.radacctid || session.id || `acct-${username}-${session.acctsessionid || Math.random()}`,
          date: session.acctstarttime || session.acctupdatetime || session.acctstoptime || null,
          username,
          password: 'N/A',
          mac: findMacAddress(session.callingstationid),
          calledId: session.calledstationid || 'N/A',
          framedIp: session.framedipaddress || 'N/A',
          nasIp: session.nasipaddress || 'N/A',
          nasPort: session.nasportid || 'N/A',
          reply: 'Accounting',
          reason: session.acctterminatecause || (session.acctstoptime ? 'Session stopped' : 'Session active'),
          boundMac
        })));
      }

      if (enriched.length === 0 && (!Array.isArray(radAcct) || radAcct.length === 0)) {
        allLogs.push({
          id: `missing-${user.id}`,
          date: null,
          username,
          password: 'N/A',
          mac: 'N/A',
          calledId: 'N/A',
          framedIp: 'N/A',
          nasIp: 'N/A',
          nasPort: 'N/A',
          reply: 'N/A',
          reason: 'No Radius post-auth or accounting records found',
          boundMac
        });
      }
    }


    allLogs.sort((a, b) => {
      const aTime = a.date ? new Date(a.date).getTime() : 0;
      const bTime = b.date ? new Date(b.date).getTime() : 0;
      return bTime - aTime;
    });

    return res.json({
      success: true,
      data: allLogs
    });

  } catch (error) {
    console.error('Error fetching customer radius auth logs:', error);
    return next(error);
  }
}

async function bindCustomerRadiusMac(req, res, next) {
  const customerId = Number(req.params.id);
  const username = String(req.body?.username || '').trim();
  const macAddress = String(req.body?.macAddress || '').trim().toUpperCase().replace(/-/g, ':');
  const shouldBind = req.body?.bind !== false;

  if (!Number.isInteger(customerId) || customerId <= 0) {
    return res.status(400).json({ error: 'Invalid customer ID' });
  }
  if (!username) return res.status(400).json({ error: 'Username is required' });
  if (shouldBind && !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(macAddress)) {
    return res.status(400).json({ error: 'A valid MAC address is required' });
  }

  try {
    const connectionUser = await req.prisma.connectionUser.findFirst({
      where: {
        customerId,
        username,
        ispId: req.ispId,
        isDeleted: false,
        customer: { ispId: req.ispId, isDeleted: false }
      },
      select: { id: true, username: true }
    });
    if (!connectionUser) {
      return res.status(404).json({ error: 'Connection user not found for this customer' });
    }

    const radius = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, req.ispId);
    const [replies, legacyChecks] = await Promise.all([
      radius.getRadreply(),
      radius.getRadcheckByUsername(username).catch(() => [])
    ]);
    const staleReplyBindings = (Array.isArray(replies) ? replies : []).filter(
      (entry) => entry.username === username && String(entry.attribute || '').trim().toLowerCase() === 'calling-station-id'
    );
    const bindings = (Array.isArray(legacyChecks) ? legacyChecks : []).filter(
      (entry) => String(entry.attribute || '').trim().toLowerCase() === 'calling-station-id'
    );
    await Promise.all(staleReplyBindings.map((entry) => radius.deleteRadreply(entry.id)));

    if (!shouldBind) {
      await Promise.all(bindings.map((entry) => radius.deleteRadcheck(entry.id)));
    } else if (bindings.length > 0) {
      await Promise.all(bindings.map((entry) => radius.updateRadcheck(entry.id, {
        value: macAddress,
        op: '=='
      })));
    } else {
      await radius.createRadcheck({
        username,
        attribute: 'Calling-Station-Id',
        op: '==',
        value: macAddress
      });
    }
    await radius.disconnectAllSessions(username).catch((disconnectError) => {
      console.warn(`[RADIUS MAC] Binding updated but disconnect failed for ${username}: ${disconnectError.message}`);
    });

    return res.json({
      success: true,
      message: shouldBind ? `MAC ${macAddress} bound to ${username}` : `MAC binding removed from ${username}`,
      data: {
        username,
        macAddress: shouldBind ? macAddress : null,
        action: shouldBind ? (bindings.length > 0 ? 'updated' : 'created') : 'removed'
      }
    });
  } catch (error) {
    console.error('bindCustomerRadiusMac error:', error);
    return next(error);
  }
}

async function reprovisionRadius(req, res, next) {
  const prisma = req.prisma;
  const customerId = Number(req.params.id);
  if (isNaN(customerId)) return res.status(400).json({ error: 'Invalid customer ID' });

  const { subscribedPkgId, username, password } = req.body;

  try {
    const customer = await prisma.customer.findFirst({
      where: { id: customerId, isDeleted: false, ispId: req.ispId },
      include: {
        connectionUsers: { where: { isDeleted: false } },
        lead: true
      }
    });

    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    let finalUsername = username;
    let finalPassword = password;
    let finalSubscribedPkgId = subscribedPkgId ? Number(subscribedPkgId) : customer.subscribedPkgId;

    // If username and password are provided, validate and update/insert ConnectionUser
    if (username && password) {
      // Check duplicate username
      const duplicateUser = await prisma.connectionUser.findFirst({
        where: {
          username: username,
          customerId: { not: customerId },
          isDeleted: false
        }
      });
      if (duplicateUser) {
        return res.status(400).json({ error: `Username '${username}' is already in use by another customer.` });
      }

      // Update or create connection user
      const existingConnectionUser = customer.connectionUsers[0];
      if (existingConnectionUser) {
        await prisma.connectionUser.update({
          where: { id: existingConnectionUser.id },
          data: { username, password }
        });
      } else {
        await prisma.connectionUser.upsert({
          where: { username },
          update: {
            password,
            customerId,
            branchId: customer.branchId,
            ispId: req.ispId,
            isDeleted: false
          },
          create: {
            customerId,
            username,
            password,
            branchId: customer.branchId,
            ispId: req.ispId
          }
        });
      }
    } else {
      // Fallback to existing connection user
      const connectionUser = customer.connectionUsers[0];
      if (!connectionUser) {
        return res.status(400).json({ error: 'No active connection user found and no credentials provided.' });
      }
      finalUsername = connectionUser.username;
      finalPassword = connectionUser.password;
    }

    // If package is updated, update customer package field
    if (subscribedPkgId && Number(subscribedPkgId) !== customer.subscribedPkgId) {
      await prisma.customer.update({
        where: { id: customerId },
        data: {
          subscribedPkgId: finalSubscribedPkgId,
          assignedPkg: finalSubscribedPkgId
        }
      });
    }

    // Get package plan details for radius group name
    let radiusGroupName = '';
    if (finalSubscribedPkgId) {
      const packagePrice = await prisma.packagePrice.findFirst({
        where: { id: finalSubscribedPkgId, ispId: req.ispId },
        include: { packagePlanDetails: true }
      });
      radiusGroupName = packagePrice?.packagePlanDetails?.planCode ||
                        packagePrice?.packagePlanDetails?.planName ||
                        packagePrice?.packageName ||
                        '';
    }

    // Get active subscription for expiry date
    const subscription = await prisma.customerSubscription.findFirst({
      where: { customerId, isActive: true },
      include: { packagePrice: { include: { packagePlanDetails: true } } }
    });

    const expiryDate = subscription?.planEnd ? formatRadiusExpiration(subscription.planEnd) : null;

    const client = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, req.ispId);

    // Delete in Radius first (could use customer's old username if it changed)
    const oldUsername = customer.connectionUsers[0]?.username;
    if (oldUsername) {
      try {
        await client.deleteUser(oldUsername);
      } catch (err) {
        console.warn(`[RADIUS REPROVISION] Delete old user failed: ${err.message}`);
      }
    }
    // Delete final username just in case
    if (finalUsername !== oldUsername) {
      try {
        await client.deleteUser(finalUsername);
      } catch (err) {
        console.warn(`[RADIUS REPROVISION] Delete final user failed: ${err.message}`);
      }
    }

    // Create user in Radius
    const attributes = {};
    if (expiryDate) attributes.Expiration = expiryDate;

    let selectedNasName = null;
    if (customer.nasId) {
      const nasRecord = await prisma.nas.findFirst({
        where: { id: Number(customer.nasId), ispId: req.ispId, isActive: true, isDeleted: false }
      });
      if (nasRecord) selectedNasName = nasRecord.nasname;
    }
    if (!selectedNasName) {
      const defaultNas = await prisma.nas.findFirst({
        where: { ispId: req.ispId, isActive: true, isDeleted: false },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }]
      });
      if (defaultNas) selectedNasName = defaultNas.nasname;
    }
    if (selectedNasName) {
      attributes['NAS-IP-Address'] = selectedNasName;
    }

    const groups = radiusGroupName ? [radiusGroupName] : [];

    const result = await client.createUser(
      finalUsername,
      finalPassword,
      attributes,
      groups
    );

    // Disconnect
    try {
      await client.sendCoA(finalUsername, { action: 'disconnect' });
    } catch (err) {
      console.warn(`[RADIUS REPROVISION] sendCoA disconnect failed: ${err.message}`);
    }

    // Upsert subscribed service status
    const getServiceIdByCode = async (code) => {
      const ispService = await prisma.iSPService.findFirst({
        where: {
          ispId: req.ispId,
          isActive: true,
          isDeleted: false,
          service: { code: code, isActive: true, isDeleted: false },
        },
        include: { service: true },
      });
      return ispService?.service?.id;
    };

    const serviceId = await getServiceIdByCode(SERVICE_CODES.RADIUS);
    if (serviceId) {
      await prisma.customerSubscribedService.upsert({
        where: { customerId_serviceId: { customerId, serviceId } },
        update: { status: 'active', serviceData: result },
        create: { customerId, serviceId, status: 'active', serviceData: result }
      });
    }

    // Radius recovery completes the customer's network service activation.
    // Keep the profile provisioning status in sync with the successful push.
    await prisma.customerServiceConnection.updateMany({
      where: { customerId },
      data: {
        status: 'active',
        provisioningNotes: `RADIUS provisioned successfully on ${new Date().toISOString()}`
      }
    });

    // A successful Radius reprovision is also the activation path for customers
    // that were originally saved as drafts from the customer creation flow.
    if (customer.status === 'draft') {
      await prisma.customer.update({
        where: { id: customerId },
        data: { status: 'active', onboardStatus: 'fully_onboarded' }
      });
    }

    return res.json({
      success: true,
      message: 'Radius reprovisioned successfully',
      data: result
    });
  } catch (error) {
    console.error('Error reprovisioning Radius:', error);
    return res.status(500).json({ error: 'Radius reprovisioning failed', details: error.message });
  }
}


async function syncNettv(req, res, next) {
  const prisma = req.prisma;
  const customerId = Number(req.params.id);
  if (isNaN(customerId)) return res.status(400).json({ error: 'Invalid customer ID' });

  try {
    const customer = await prisma.customer.findFirst({
      where: { id: customerId, isDeleted: false, ispId: req.ispId }
    });

    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const getServiceIdByCode = async (code) => {
      const ispService = await prisma.iSPService.findFirst({
        where: {
          ispId: req.ispId,
          isActive: true,
          isDeleted: false,
          service: {
            code: code,
            isActive: true,
            isDeleted: false,
          },
        },
        include: { service: true },
      });
      return ispService?.service?.id;
    };

    const serviceId = await getServiceIdByCode(SERVICE_CODES.NETTV);
    if (!serviceId) {
      return res.status(400).json({ error: 'NetTV service not available for this ISP' });
    }

    const subscribedService = await prisma.customerSubscribedService.findUnique({
      where: { customerId_serviceId: { customerId, serviceId } }
    });
    const storedData = subscribedService?.serviceData && typeof subscribedService.serviceData === 'object'
      ? subscribedService.serviceData
      : {};
    const username = String(
      subscribedService?.externalUsername || storedData.username || storedData.subscriber?.username || ''
    ).trim();
    if (!username) {
      return res.status(400).json({ error: 'This customer has no linked NetTV username. Provision NetTV and enter the subscriber username first.' });
    }

    const client = await ServiceFactory.getClient(SERVICE_CODES.NETTV, req.ispId);
    
    // Fetch overview from NetTV API
    const overviewData = await client.getSubscriberOverview(username);
    
    // Store in local DB
    const remoteStatus = overviewData?.subscriber?.status;
    const localStatus = remoteStatus === 0 || remoteStatus === '0' ? 'inactive' : 'active';
    
    const updatedSubscribedService = await prisma.customerSubscribedService.upsert({
      where: { customerId_serviceId: { customerId, serviceId } },
      update: { 
        status: localStatus, 
        externalUsername: username,
        serviceData: {
          username,
          ...overviewData,
          lastNetTVSync: new Date().toISOString()
        } 
      },
      create: { 
        customerId, 
        serviceId, 
        status: localStatus, 
        externalUsername: username,
        serviceData: {
          username,
          ...overviewData,
          lastNetTVSync: new Date().toISOString()
        } 
      }
    });

    return res.json({
      success: true,
      message: 'NetTV subscriber details synchronized successfully',
      data: updatedSubscribedService.serviceData
    });
  } catch (error) {
    console.error('Error syncing NetTV subscriber:', error);
    return res.status(500).json({ error: 'NetTV synchronization failed', details: error.message });
  }
}

async function reprovisionNettv(req, res, next) {
  const prisma = req.prisma;
  const customerId = Number(req.params.id);
  if (isNaN(customerId)) return res.status(400).json({ error: 'Invalid customer ID' });

  try {
    const customer = await prisma.customer.findFirst({
      where: { id: customerId, isDeleted: false, ispId: req.ispId },
      include: { lead: true }
    });

    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const getServiceIdByCode = async (code) => {
      const ispService = await prisma.iSPService.findFirst({
        where: {
          ispId: req.ispId,
          isActive: true,
          isDeleted: false,
          service: {
            code: code,
            isActive: true,
            isDeleted: false,
          },
        },
        include: { service: true },
      });
      return ispService?.service?.id;
    };

    const serviceId = await getServiceIdByCode(SERVICE_CODES.NETTV);
    if (!serviceId) {
      return res.status(400).json({ error: 'NetTV service not available for this ISP' });
    }

    const subscribedService = await prisma.customerSubscribedService.findUnique({
      where: { customerId_serviceId: { customerId, serviceId } }
    });

    const fallbackNettvData = {
      username: customer.customerUniqueId || `cust_${customer.id}`,
      firstName: customer.lead?.firstName || 'Unknown',
      lastName: customer.lead?.lastName || 'Unknown',
      email: customer.email || customer.lead?.email || `${customer.id}@unknown.com`,
      phoneNumber: customer.phoneNumber || customer.lead?.phoneNumber || '0000000000',
      address: customer.address || customer.lead?.address || 'Unknown'
    };
    const existingNettvData = subscribedService?.serviceData && typeof subscribedService.serviceData === 'object'
      ? subscribedService.serviceData
      : {};
    const requestNettvData = req.body?.nettvData || req.body?.data || {};
    const nettvData = { ...fallbackNettvData, ...existingNettvData, ...requestNettvData };
    const nettvUsername = String(nettvData.username || '').trim();
    if (!nettvUsername) return res.status(400).json({ error: 'NetTV username is required' });
    nettvData.username = nettvUsername;

    const existingLink = await prisma.customerSubscribedService.findFirst({
      where: {
        serviceId,
        externalUsername: nettvUsername,
        customerId: { not: customerId }
      },
      select: { customerId: true }
    });
    if (existingLink) {
      return res.status(409).json({ error: `NetTV username '${nettvUsername}' is already linked to another customer` });
    }

    const client = await ServiceFactory.getClient(SERVICE_CODES.NETTV, req.ispId);
    
    // Reprovision is equivalent to calling createSubscriber to upsert/update configuration on NetTV
    const { provisioning: nettvProvisioning, ...subscriberData } = nettvData;
    const normalizedSubscriberData = {
      ...subscriberData,
      has_ratv: subscriberData.has_ratv === 0 || subscriberData.has_ratv === '0' ? 0 : 1,
      status: subscriberData.status === 0 || subscriberData.status === '0' ? 0 : 1
    };
    const subscriberGroupId = Number(subscriberData.subscriber_group_id || nettvProvisioning?.subscriber_group_id || 6);
    delete normalizedSubscriberData.subscriber_group_id;
    const result = await client.createSubscriber(normalizedSubscriberData);
    const subscriberId = result?.subscriber?.id || result?.data?.id || result?.id;
    if (subscriberId && subscriberGroupId) await client.assignSubscriberGroup(subscriberId, subscriberGroupId);
    if (nettvProvisioning?.stb?.serial) {
      await client.addSTBToSubscriber(nettvUsername, nettvProvisioning.stb);
      if (nettvProvisioning.package?.packages?.length) {
        await client.subscribePackages(nettvProvisioning.stb.serial, nettvProvisioning.package);
      }
    }

    // Fetch full overview details right after provision to keep local DB fully in sync
    const overviewData = await client.getSubscriberOverview(nettvData.username).catch(error => {
      console.warn('Failed to fetch full overview on NetTV reprovision:', error.message);
      return null;
    });

    const finalNettvData = {
      ...nettvData,
      ...(overviewData || {}),
      lastNetTVSync: new Date().toISOString()
    };

    await prisma.customerSubscribedService.upsert({
      where: { customerId_serviceId: { customerId, serviceId } },
      update: { status: 'active', externalUsername: nettvUsername, serviceData: finalNettvData },
      create: { customerId, serviceId, status: 'active', externalUsername: nettvUsername, serviceData: finalNettvData }
    });

    // A successful manual retry completes the same local lifecycle work as the
    // add-customer provisioning flow, so profiles do not remain PENDING after
    // NetTV has actually been provisioned.
    await prisma.$transaction([
      prisma.customer.update({ where: { id: customerId }, data: { status: 'active', onboardStatus: 'fully_onboarded' } }),
      prisma.customerDevice.updateMany({ where: { customerId, deviceType: 'ONT' }, data: { provisioningStatus: 'active' } }),
      prisma.customerServiceConnection.updateMany({ where: { customerId }, data: { status: 'active', provisioningNotes: `Completed after manual NetTV provisioning on ${new Date().toISOString()}` } })
    ]);

    return res.json({
      success: true,
      message: 'NetTV reprovisioned successfully',
      data: finalNettvData
    });
  } catch (error) {
    console.error('Error reprovisioning NetTV:', error);
    return res.status(500).json({ error: error.message || 'NetTV reprovisioning failed', message: error.message, details: error.message });
  }
}

async function reprovisionAccount(req, res, next) {
  const prisma = req.prisma;
  const customerId = Number(req.params.id);
  if (isNaN(customerId)) return res.status(400).json({ error: 'Invalid customer ID' });

  try {
    const customer = await prisma.customer.findFirst({
      where: { id: customerId, isDeleted: false, ispId: req.ispId },
      include: { lead: true }
    });

    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const name = `${customer.lead?.firstName || customer.firstName || ''} ${customer.lead?.lastName || customer.lastName || ''}`.trim() || `Customer ${customer.id}`;
    const addressParts = [
      customer.lead?.street || customer.street || customer.address,
      customer.lead?.city || customer.city,
      customer.lead?.province || customer.state,
      customer.lead?.zipCode || customer.zipCode,
    ].filter(Boolean);

    // Base customer data (provider-neutral)
    const baseData = {
      name: name,
      referenceId: customer.customerUniqueId || `cust_${customer.id}`,
      panNo: customer.panNumber || customer.lead?.panNumber || '',
      address: addressParts.join(', ') || customer.lead?.address || customer.address || '',
      city: customer.lead?.city || customer.city || '',
      province: customer.lead?.province || customer.state || '',
      postalCode: customer.lead?.zipCode || customer.zipCode || '',
      country: 'Nepal',
      phone: customer.phoneNumber || customer.lead?.phoneNumber || '',
      email: customer.email || customer.lead?.email || '',
      website: '',
      contactPerson: name,
      contactPersonPhone: customer.phoneNumber || customer.lead?.phoneNumber || '',
      bank: '',
      acNo: '',
      acName: '',
      customerId: customer.idNumber || customer.customerUniqueId || String(customer.id),
      notes: `Reprovisioned from customer profile. Customer ID: ${customer.id}`,
    };

    // TSHUL uses PascalCase keys, NEPURIX uses camelCase keys
    const buildProviderPayload = (code, data) => {
      if (code === 'TSHUL') {
        return {
          Name: data.name,
          ReferenceId: data.referenceId,
          PanNo: data.panNo,
          Address: data.address,
          City: data.city,
          Province: data.province,
          PostalCode: data.postalCode,
          Country: data.country,
          Phone: data.phone,
          Email: data.email,
          Website: data.website,
          ContactPerson: data.contactPerson,
          ContactPersonPhone: data.contactPersonPhone,
          Bank: data.bank,
          AcNo: data.acNo,
          AcName: data.acName,
          CustomerId: data.customerId,
          Notes: data.notes,
        };
      }
      // NEPURIX uses camelCase
      return {
        name: data.name,
        panNo: data.panNo,
        address: data.address,
        city: data.city,
        province: data.province,
        postalCode: data.postalCode,
        country: data.country,
        phone: data.phone,
        email: data.email,
        contactPerson: data.contactPerson,
        contactPersonPhone: data.contactPersonPhone,
      };
    };

    const requestPayload = req.body?.data && typeof req.body.data === 'object' ? req.body.data : {};
    const activeBillingClients = await ServiceFactory.getActiveBillingClients(req.ispId, prisma);

    if (!activeBillingClients.length) {
      return res.status(400).json({ success: false, error: 'No account service is configured or enabled for this ISP' });
    }

    const getServiceIdByCode = async (code) => {
      const ispService = await prisma.iSPService.findFirst({
        where: {
          ispId: req.ispId,
          isDeleted: false,
          service: {
            code,
            isActive: true,
            isDeleted: false,
          },
        },
        include: { service: true },
      });
      return ispService?.service?.id;
    };

    const results = [];
    for (const billingClient of activeBillingClients) {
      try {
        const providerPayload = buildProviderPayload(billingClient.code, baseData);
        const payload = { ...providerPayload, ...requestPayload };
        const result = await billingClient.client.customer.create(payload);
        const apiError = result?.Error || result?.Errors || result?.error;
        if (apiError) {
          throw new Error(Array.isArray(apiError) ? apiError.join(', ') : String(apiError));
        }

        const serviceId = await getServiceIdByCode(billingClient.code);
        if (serviceId) {
          await prisma.customerSubscribedService.upsert({
            where: { customerId_serviceId: { customerId, serviceId } },
            update: { status: 'active', serviceData: result },
            create: { customerId, serviceId, status: 'active', serviceData: result },
          });
        }

        results.push({ service: billingClient.code, success: true, data: result });
      } catch (err) {
        console.error(`${billingClient.code} account reprovision error:`, err);
        results.push({ service: billingClient.code, success: false, message: err.message });
      }
    }

    const failed = results.filter((result) => !result.success);
    return res.status(failed.length === results.length ? 502 : 200).json({
      success: failed.length === 0,
      partialSuccess: failed.length > 0 && failed.length < results.length,
      message: failed.length === 0 ? 'Account reprovisioned successfully' : 'Account reprovision completed with errors',
      services: results,
    });
  } catch (error) {
    console.error('Error reprovisioning Account:', error);
    return res.status(500).json({ error: 'Account reprovisioning failed', details: error.message });
  }
}


async function disconnectRadiusSession(req, res, next) {
  const prisma = req.prisma;
  const customerId = Number(req.params.id);
  if (isNaN(customerId)) return res.status(400).json({ error: 'Invalid customer ID' });

  try {
    const customer = await prisma.customer.findFirst({
      where: { id: customerId, isDeleted: false, ispId: req.ispId },
      include: {
        connectionUsers: { where: { isDeleted: false } }
      }
    });

    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const connectionUser = customer.connectionUsers[0];
    if (!connectionUser) {
      return res.status(400).json({ error: 'No active connection user found for this customer' });
    }

    const client = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, req.ispId);
    const result = await client.sendCoA(connectionUser.username, { action: 'disconnect' });

    return res.json({
      success: true,
      message: `Radius session for ${connectionUser.username} disconnected successfully`,
      data: result
    });
  } catch (error) {
    console.error('Error disconnecting Radius session:', error);
    return res.status(500).json({ error: 'Failed to disconnect user session', message: error.message });
  }
}

async function listNasDevices(req, res, next) {
  try {
    const client = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, req.ispId);
    const result = await client.listNasDevices();
    return res.json(result);
  } catch (error) {
    console.error('Error listing NAS devices:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

async function listActiveSessions(req, res, next) {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    const client = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, req.ispId);
    const result = await client.listActiveSessions(limit, offset);
    return res.json(result);
  } catch (error) {
    console.error('Error listing active sessions:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

async function getSessionInfoForUser(req, res, next) {
  const username = req.params.username;
  try {
    const client = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, req.ispId);
    const result = await client.getSessionInfo(username);
    return res.json(result);
  } catch (error) {
    console.error(`Error getting session info for user ${username}:`, error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

async function disconnectLatestSession(req, res, next) {
  const username = req.params.username;
  try {
    const client = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, req.ispId);
    const result = await client.disconnectUser(username);
    return res.json({ success: true, ...result });
  } catch (error) {
    console.error(`Error disconnecting latest session for user ${username}:`, error);
    const message = error.message || 'Disconnect failed';
    const radiusData = error.responseData || null;
    const isUpstreamError = message.includes('Disconnect failed') || message.includes('ERROR');
    return res.status(isUpstreamError ? 502 : 500).json({ 
      success: false, 
      error: message,
      detail: isUpstreamError ? 'The NAS/BRAS did not respond to the disconnect request. The session may have already ended or the NAS is unreachable.' : undefined,
      nas: radiusData?.nas || undefined,
      nasIp: radiusData?.nas_ip || undefined,
      username: radiusData?.username || username
    });
  }
}

async function disconnectAllSessions(req, res, next) {
  const username = req.params.username;
  try {
    const client = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, req.ispId);
    const result = await client.disconnectAllSessions(username);
    return res.json({ success: true, ...result });
  } catch (error) {
    console.error(`Error disconnecting all sessions for user ${username}:`, error);
    const message = error.message || 'Disconnect failed';
    const radiusData = error.responseData || null;
    const isUpstreamError = message.includes('Disconnect failed') || message.includes('ERROR');
    return res.status(isUpstreamError ? 502 : 500).json({ 
      success: false, 
      error: message,
      detail: isUpstreamError ? 'The NAS/BRAS did not respond to the disconnect request.' : undefined,
      nas: radiusData?.nas || undefined,
      nasIp: radiusData?.nas_ip || undefined,
      username: radiusData?.username || username
    });
  }
}

async function disconnectBranchSessions(req, res, next) {
  const branchId = Number(req.params.branchId);
  if (isNaN(branchId)) return res.status(400).json({ success: false, error: 'Invalid branch ID' });

  try {
    const branch = await req.prisma.branch.findFirst({
      where: { id: branchId, ispId: req.ispId, isDeleted: false },
      select: { id: true, name: true }
    });
    if (!branch) return res.status(404).json({ success: false, error: 'Branch not found' });

    if (req.branchId) {
      const allowedBranchIds = await getAllSubBranchIds(req.prisma, Number(req.branchId));
      if (!allowedBranchIds.includes(branchId)) {
        return res.status(403).json({
          success: false,
          error: 'Access denied: You do not have permission for this branch'
        });
      }
    }

    const includeSubBranches = req.body?.includeSubBranches !== false && req.query.includeSubBranches !== 'false';
    const branchIds = includeSubBranches ? await getAllSubBranchIds(req.prisma, branchId) : [branchId];

    const connectionUsers = await req.prisma.connectionUser.findMany({
      where: {
        isDeleted: false,
        username: { not: '' },
        OR: [
          { branchId: { in: branchIds } },
          {
            customer: {
              ispId: req.ispId,
              isDeleted: false,
              OR: [
                { branchId: { in: branchIds } },
                { subBranchId: { in: branchIds } }
              ]
            }
          }
        ]
      },
      select: {
        username: true,
        customerId: true,
        customer: {
          select: {
            id: true,
            customerUniqueId: true,
            lead: { select: { firstName: true, lastName: true } }
          }
        }
      }
    });

    const usersByUsername = new Map();
    connectionUsers.forEach((user) => {
      const username = String(user.username || '').trim();
      if (username) usersByUsername.set(username, user);
    });

    const usernames = Array.from(usersByUsername.keys());
    if (usernames.length === 0) {
      return res.json({
        success: true,
        message: `No RADIUS users found for ${branch.name}.`,
        branch: { id: branch.id, name: branch.name },
        includeSubBranches,
        branchIds,
        totalUsers: 0,
        disconnected: [],
        failed: []
      });
    }

    const client = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, req.ispId);
    const disconnected = [];
    const failed = [];

    for (const username of usernames) {
      try {
        const result = await client.disconnectAllSessions(username);
        disconnected.push({
          username,
          customerId: usersByUsername.get(username)?.customerId || null,
          result
        });
      } catch (error) {
        failed.push({
          username,
          customerId: usersByUsername.get(username)?.customerId || null,
          error: error.message || 'Disconnect failed'
        });
      }
    }

    const successCount = disconnected.length;
    const failedCount = failed.length;
    return res.status(failedCount > 0 && successCount === 0 ? 502 : 200).json({
      success: failedCount === 0,
      partialSuccess: failedCount > 0 && successCount > 0,
      message: `Disconnected sessions for ${successCount} of ${usernames.length} RADIUS users in ${branch.name}.`,
      branch: { id: branch.id, name: branch.name },
      includeSubBranches,
      branchIds,
      totalUsers: usernames.length,
      disconnected,
      failed
    });
  } catch (error) {
    console.error(`Error disconnecting branch sessions for branch ${branchId}:`, error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to disconnect branch sessions'
    });
  }
}

async function getPackagePriceIdsForFramedPool(req, poolValue) {
  const localPackagePrices = await req.prisma.packagePrice.findMany({
    where: {
      isDeleted: false,
      ispId: req.ispId,
      packagePlanDetails: {
        framedPoolValue: poolValue,
        isDeleted: false,
        ispId: req.ispId
      }
    },
    select: { id: true, planId: true }
  });

  const ids = new Set(localPackagePrices.map(item => item.id));

  try {
    const client = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, req.ispId);
    const repliesResponse = await client.getRadgroupreply();
    const replies = Array.isArray(repliesResponse)
      ? repliesResponse
      : Array.isArray(repliesResponse?.data)
        ? repliesResponse.data
        : [];
    const groupNames = [...new Set(replies
      .filter(reply =>
        String(reply.attribute || '').toLowerCase() === 'framed-pool' &&
        String(reply.value || '').trim() === poolValue
      )
      .map(reply => String(reply.groupname || '').trim())
      .filter(Boolean))];

    if (groupNames.length > 0) {
      const plans = await req.prisma.PackagePlan.findMany({
        where: {
          ispId: req.ispId,
          isDeleted: false,
          planCode: { in: groupNames }
        },
        select: { id: true }
      });
      const planIds = plans.map(plan => plan.id);
      if (planIds.length > 0) {
        const radiusBackedPrices = await req.prisma.packagePrice.findMany({
          where: { isDeleted: false, ispId: req.ispId, planId: { in: planIds } },
          select: { id: true }
        });
        radiusBackedPrices.forEach(item => ids.add(item.id));
      }
    }
  } catch (error) {
    console.warn(`[POOL DISCONNECT] Unable to resolve pool ${poolValue} from Radius radgroupreply: ${error.message}`);
  }

  return Array.from(ids);
}

async function disconnectPoolSessions(req, res, next) {
  const poolValue = String(req.params.poolValue || req.body?.poolValue || '').trim();
  if (!poolValue) return res.status(400).json({ success: false, error: 'Pool value is required' });

  try {
    const branchIds = [];
    const requestedBranchIds = Array.isArray(req.body?.branchIds) ? req.body.branchIds.map(Number).filter(Boolean) : [];
    const requestedSubBranchIds = Array.isArray(req.body?.subBranchIds) ? req.body.subBranchIds.map(Number).filter(Boolean) : [];

    if (req.branchId) {
      branchIds.push(...await getAllSubBranchIds(req.prisma, Number(req.branchId)));
    }

    const scopedBranchFilter = req.branchId
      ? { in: branchIds }
      : requestedBranchIds.length > 0
        ? { in: requestedBranchIds }
        : undefined;

    const scopedSubBranchFilter = req.branchId
      ? { in: branchIds }
      : requestedSubBranchIds.length > 0
        ? { in: requestedSubBranchIds }
        : undefined;

    const packagePriceIds = await getPackagePriceIdsForFramedPool(req, poolValue);

    if (packagePriceIds.length === 0) {
      return res.json({
        success: true,
        message: `No package prices found for pool ${poolValue}.`,
        poolValue,
        totalUsers: 0,
        disconnected: [],
        failed: []
      });
    }

    const customerBranchWhere = [];
    if (scopedBranchFilter) customerBranchWhere.push({ branchId: scopedBranchFilter });
    if (scopedSubBranchFilter) customerBranchWhere.push({ subBranchId: scopedSubBranchFilter });

    const customerAnd = [
      {
        OR: [
          { subscribedPkgId: { in: packagePriceIds } },
          { customerSubscriptions: { some: { isActive: true, packagePriceId: { in: packagePriceIds } } } }
        ]
      }
    ];
    if (customerBranchWhere.length > 0) customerAnd.push({ OR: customerBranchWhere });

    const connectionUsers = await req.prisma.connectionUser.findMany({
      where: {
        isDeleted: false,
        username: { not: '' },
        customer: {
          ispId: req.ispId,
          isDeleted: false,
          AND: customerAnd
        }
      },
      select: { username: true, customerId: true }
    });

    const usersByUsername = new Map();
    connectionUsers.forEach((user) => {
      const username = String(user.username || '').trim();
      if (username) usersByUsername.set(username, user);
    });

    const usernames = Array.from(usersByUsername.keys());
    if (usernames.length === 0) {
      return res.json({
        success: true,
        message: `No RADIUS users found for pool ${poolValue}.`,
        poolValue,
        totalUsers: 0,
        disconnected: [],
        failed: []
      });
    }

    const client = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, req.ispId);
    const disconnected = [];
    const failed = [];

    for (const username of usernames) {
      try {
        const result = await client.disconnectAllSessions(username);
        disconnected.push({ username, customerId: usersByUsername.get(username)?.customerId || null, result });
      } catch (error) {
        failed.push({ username, customerId: usersByUsername.get(username)?.customerId || null, error: error.message || 'Disconnect failed' });
      }
    }

    const successCount = disconnected.length;
    const failedCount = failed.length;
    return res.status(failedCount > 0 && successCount === 0 ? 502 : 200).json({
      success: failedCount === 0,
      partialSuccess: failedCount > 0 && successCount > 0,
      message: `Disconnected sessions for ${successCount} of ${usernames.length} RADIUS users in pool ${poolValue}.`,
      poolValue,
      totalUsers: usernames.length,
      disconnected,
      failed
    });
  } catch (error) {
    console.error(`Error disconnecting pool sessions for pool ${poolValue}:`, error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to disconnect pool sessions'
    });
  }
}

async function disconnectFilteredCustomerSessions(req, res, next) {
  try {
    const {
      branchIds = [],
      subBranchIds = [],
      packageIds = [],
      status,
      poolValue,
      usernames: inputUsernames = []
    } = req.body || {};

    const requestedBranchIds = Array.isArray(branchIds) ? branchIds.map(Number).filter(Boolean) : [];
    const requestedSubBranchIds = Array.isArray(subBranchIds) ? subBranchIds.map(Number).filter(Boolean) : [];
    const requestedPackageIds = Array.isArray(packageIds) ? packageIds.map(Number).filter(Boolean) : [];
    const requestedUsernames = Array.isArray(inputUsernames) ? inputUsernames.map(String).map(s => s.trim()).filter(Boolean) : [];

    let allowedBranchIds = [];
    if (req.branchId) {
      allowedBranchIds = await getAllSubBranchIds(req.prisma, Number(req.branchId));
    }

    const packageIdSet = new Set();
    if (requestedPackageIds.length > 0) {
      // Find package price IDs corresponding to these plan IDs (just plan)
      const pricesByPlan = await req.prisma.packagePrice.findMany({
        where: {
          planId: { in: requestedPackageIds },
          isDeleted: false
        },
        select: { id: true }
      });
      pricesByPlan.forEach(p => packageIdSet.add(p.id));

      // Also fallback if they are actually package price IDs directly
      requestedPackageIds.forEach(id => packageIdSet.add(id));
    }

    const cleanPoolValue = String(poolValue || '').trim();
    if (cleanPoolValue) {
      const poolPackageIds = await getPackagePriceIdsForFramedPool(req, cleanPoolValue);
      poolPackageIds.forEach(id => packageIdSet.add(id));
      if (poolPackageIds.length === 0 && requestedPackageIds.length === 0) {
        return res.json({
          success: true,
          message: `No package prices found for pool ${cleanPoolValue}.`,
          totalUsers: 0,
          disconnected: [],
          failed: []
        });
      }
    }

    const branchOr = [];
    if (req.branchId) {
      branchOr.push({ branchId: { in: allowedBranchIds } }, { subBranchId: { in: allowedBranchIds } });
    } else {
      if (requestedBranchIds.length > 0) branchOr.push({ branchId: { in: requestedBranchIds } });
      if (requestedSubBranchIds.length > 0) branchOr.push({ subBranchId: { in: requestedSubBranchIds } });
    }

    const customerAnd = [];
    if (packageIdSet.size > 0) {
      const packagePriceIds = Array.from(packageIdSet);
      customerAnd.push({
        OR: [
          { subscribedPkgId: { in: packagePriceIds } },
          { customerSubscriptions: { some: { isActive: true, package: { in: packagePriceIds } } } }
        ]
      });
    }
    if (branchOr.length > 0) customerAnd.push({ OR: branchOr });

    const customerWhere = {
      ispId: req.ispId,
      isDeleted: false,
      ...(status && status !== 'all' ? { status: String(status) } : {}),
      ...(customerAnd.length > 0 ? { AND: customerAnd } : {})
    };

    const connectionUsers = await req.prisma.connectionUser.findMany({
      where: {
        isDeleted: false,
        username: { not: '' },
        ...(requestedUsernames.length > 0
          ? { username: { in: requestedUsernames } }
          : { customer: customerWhere }
        )
      },
      select: { username: true, customerId: true }
    });

    const usersByUsername = new Map();
    connectionUsers.forEach(user => {
      const username = String(user.username || '').trim();
      if (username) usersByUsername.set(username, user);
    });

    const usernames = Array.from(usersByUsername.keys());
    if (usernames.length === 0) {
      return res.json({
        success: true,
        message: 'No customer RADIUS users found for selected filters.',
        totalUsers: 0,
        disconnected: [],
        failed: []
      });
    }

    const client = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, req.ispId);
    const disconnected = [];
    const failed = [];

    for (const username of usernames) {
      try {
        const result = await client.disconnectAllSessions(username);
        disconnected.push({ username, customerId: usersByUsername.get(username)?.customerId || null, result });
      } catch (error) {
        failed.push({ username, customerId: usersByUsername.get(username)?.customerId || null, error: error.message || 'Disconnect failed' });
      }
    }

    return res.status(failed.length > 0 && disconnected.length === 0 ? 502 : 200).json({
      success: failed.length === 0,
      partialSuccess: failed.length > 0 && disconnected.length > 0,
      message: `Disconnected sessions for ${disconnected.length} of ${usernames.length} customer RADIUS users.`,
      totalUsers: usernames.length,
      disconnected,
      failed
    });
  } catch (error) {
    console.error('Error disconnecting filtered customer sessions:', error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to disconnect customer sessions' });
  }
}

async function disconnectBySessionId(req, res, next) {
  const sessionId = req.params.sessionId;
  try {
    const client = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, req.ispId);
    const result = await client.disconnectBySessionId(sessionId);
    return res.json({ success: true, ...result });
  } catch (error) {
    console.error(`Error disconnecting session ${sessionId}:`, error);
    const message = error.message || 'Disconnect failed';
    const radiusData = error.responseData || null;
    const isUpstreamError = message.includes('Disconnect failed') || message.includes('ERROR');
    return res.status(isUpstreamError ? 502 : 500).json({ 
      success: false, 
      error: message,
      detail: isUpstreamError ? 'The NAS/BRAS did not respond to the disconnect request. The session may have already ended or the NAS is unreachable.' : undefined,
      nas: radiusData?.nas || undefined,
      nasIp: radiusData?.nas_ip || undefined,
      username: radiusData?.username || undefined,
      sessionId: radiusData?.session_id || sessionId
    });
  }
}

// ----------------------------------------------------------------------
// Exports
// ----------------------------------------------------------------------
module.exports = {
  findCustomerForAuthenticatedUser,
  createCustomer,
  provisionCustomer,
  listCustomers,
  getCustomerProfile,
  assertCustomerOwnsSerial,
  getCustomerById,
  getCustomerByPhoneNumber,
  updateCustomer,
  deleteCustomer,
  subscribePackage,
  changeUsername,
  changePackage,
  resetMac,
  handleFileUpload: upload,
  getCustomerDocuments,
  downloadDocument,
  deleteDocument,
  uploadCustomerDocuments,
  uploadCustomerProfilePhoto,
  changeOwnPortalPassword,
  listOwnReferrals,
  createOwnReferral,
  getCustomerStatusSummary,
  updateCustomerDevice,
  updateCustomerProvisioningStatus,
  deleteCustomerDevice,
  getCustomerRadiusAuthLogs,
  bindCustomerRadiusMac,
  changePortalPassword,
  changeConnectionUserPassword,
  reprovisionRadius,
  reprovisionNettv,
  syncNettv,
  reprovisionAccount,
  disconnectRadiusSession,
  listNasDevices,
  listActiveSessions,
  getSessionInfoForUser,
  disconnectLatestSession,
  disconnectAllSessions,
  disconnectBranchSessions,
  disconnectPoolSessions,
  disconnectFilteredCustomerSessions,
  disconnectBySessionId
};
