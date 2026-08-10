const { ServiceFactory } = require('../lib/clients/ServiceFactory');
const { SERVICE_CODES } = require('../lib/serviceConstants');
const { convertToNepaliDate } = require('../utils/dateHelper');

const number = value => Number(value || 0);
const round = value => Math.round((number(value) + Number.EPSILON) * 100) / 100;
const dateOnly = value => new Date(value || Date.now()).toISOString().slice(0, 10);
const paymentMode = value => {
  const normalized = String(value || '').toUpperCase();
  if (normalized.includes('ESEWA')) return 'eSewa';
  if (normalized.includes('EPAY')) return 'ePay';
  if (normalized.includes('KHALTI')) return 'Khalti';
  return normalized === 'CREDIT' ? 'Credit' : 'Cash';
};

const safeUrl = url => {
  if (!url || typeof url !== 'string') return url;
  return url.replace(/\+/g, '%2B');
};

async function getEnabledAccountingClient(prisma, ispId) {
  const [service] = await ServiceFactory.getActiveBillingClients(Number(ispId), prisma);
  return service || null;
}

function taxName(isTaxable, isTscApplicable) {
  if (isTaxable && isTscApplicable) return 'TSC + VAT';
  if (isTaxable) return 'VAT';
  return null;
}

async function loadOrder(prisma, ispId, orderId) {
  const order = await prisma.customerOrderManagement.findFirst({
    where: { id: Number(orderId), isDeleted: false, customer: { ispId: Number(ispId) } },
    include: {
      items: true,
      customer: {
        include: {
          lead: true,
          connectionUsers: { where: { isDeleted: false } },
          branch: true,
          subBranch: true
        }
      },
      packagePrice: {
        include: {
          packagePlanDetails: true,
          oneTimeCharges: { where: { isDeleted: false } }
        }
      }
    }
  });
  if (!order?.package) return order;

  // Package item links are stored in the explicit legacy join table. Load
  // those definitions so each historical order line keeps its VAT/TSC rule.
  const links = await prisma.packageonetimecharges.findMany({ where: { A: order.package } });
  if (links.length) {
    const charges = await prisma.OneTimeCharge.findMany({
      where: { id: { in: links.map(link => link.B) }, isDeleted: false },
      orderBy: { id: 'asc' }
    });
    order.packagePrice = { ...order.packagePrice, oneTimeCharges: charges };
  }
  return order;
}

function isStandardItemName(name) {
  if (!name) return false;
  const n = name.toUpperCase();
  return n.includes('INTERNET') || n.includes('SUPPORT') || n.includes('NETTV') || n.includes('NET TV') || n.includes('CHARGE') || n.includes('INSTALLATION') || n.includes('DEPOSIT') || n.includes('WIRE');
}

async function buildAccountingItems(prisma, ispId, order, service = null) {
  const tscSetting = await prisma.iSPSettings.findFirst({ where: { ispId: Number(ispId), key: 'tscPercentage' } });
  const tscRate = number(tscSetting?.value || 10) / 100;

  const isTrial = Number(order.totalAmount || 0) === 0;

  let charges = [];
  if (order.packagePrice?.oneTimeCharges && order.packagePrice.oneTimeCharges.length > 0) {
    charges = order.packagePrice.oneTimeCharges;
  }

  // If no charges from packagePrice, check order.items for standard items
  if (charges.length === 0 && order.items && order.items.length > 0) {
    const standardItemsInOrder = order.items.filter(it => isStandardItemName(it.itemName));
    if (standardItemsInOrder.length > 0) {
      charges = standardItemsInOrder.map(it => ({
        id: it.id || 0,
        name: it.itemName,
        referenceId: it.referenceId,
        code: it.referenceId ? it.referenceId.replace(/^INT-/, '') : null,
        isTaxable: true,
        isTscApplicable: it.itemName.toUpperCase().includes('INTERNET'),
        amount: Number(it.itemPrice || 0)
      }));
    }
  }

  // If we still have no charges, create the standard ones based on plan/package name
  if (charges.length === 0) {
    const packName = order.packagePrice?.packageName || order.packagePrice?.packagePlanDetails?.planName || order.package || '';
    const isTvBundle = /tv|nettv/i.test(packName);

    const catalogCharges = await prisma.OneTimeCharge.findMany({
      where: { ispId: Number(ispId), forPackageCreation: true, isDeleted: false }
    });

    const internetCharge = catalogCharges.find(c => c.name.toUpperCase().includes('INTERNET')) || { id: 10001, name: 'INTERNET', referenceId: 'INT-INT', code: 'INT', isTaxable: true, isTscApplicable: true, amount: 0 };
    const supportCharge = catalogCharges.find(c => c.name.toUpperCase().includes('SUPPORT') || c.name.toUpperCase().includes('MAINTENANCE')) || { id: 10002, name: 'SUPPORT & MAINTENANCE', referenceId: 'INT-SM', code: 'SM', isTaxable: true, isTscApplicable: false, amount: 0 };
    
    charges.push(internetCharge);
    charges.push(supportCharge);

    if (isTvBundle) {
      const nettvCharge = catalogCharges.find(c => c.name.toUpperCase().includes('NETTV') || c.name.toUpperCase().includes('NET TV')) || { id: 10003, name: 'NETTV CHARGE', referenceId: 'INT-NETTVKSN75', code: 'NETTVKSN75', isTaxable: true, isTscApplicable: false, amount: 0 };
      charges.push(nettvCharge);
    }
  }

  // Map charges to itemsToUse using custom prices or charge amounts
  const customPrices = order.packagePrice?.addonPricesJson ? JSON.parse(order.packagePrice.addonPricesJson) : {};

  // Resolve original/custom charge IDs by name splits to handle "INTERNET (3000)" vs "INTERNET" mismatches!
  const customPriceKeys = Object.keys(customPrices);
  const resolvedCustomPrices = {};
  if (customPriceKeys.length > 0) {
    const originalCharges = await prisma.OneTimeCharge.findMany({
      where: { id: { in: customPriceKeys.map(Number) } }
    });
    for (const oc of originalCharges) {
      const cleanName = (oc.name || '').split(' (')[0].trim().toUpperCase();
      resolvedCustomPrices[cleanName] = Number(customPrices[String(oc.id)]);
    }
  }

  // Fetch Nepurix catalog items for exact code/reference ID matching
  let nepurixItems = [];
  if (service && service.code === SERVICE_CODES.NEPURIX && service.client?.item?.list) {
    try {
      nepurixItems = await service.client.item.list().catch(() => []);
    } catch (e) {
      console.warn('[NEPURIX] Failed to fetch items list for matching:', e.message);
    }
  }

  let itemsToUse = charges.map(charge => {
    const cleanChargeName = (charge.name || '').split(' (')[0].trim().toUpperCase();
    const customVal = resolvedCustomPrices[cleanChargeName] !== undefined
      ? resolvedCustomPrices[cleanChargeName]
      : customPrices[String(charge.id)];

    let finalName = charge.name || 'Package Item';
    
    // Tax rules from database OneTimeCharge record
    let finalIsTaxable = charge.isTaxable !== false;
    let finalIsTscApplicable = charge.isTscApplicable === true;

    console.log(`[ACCOUNTING ITEM] "${finalName}" DB: isTaxable=${charge.isTaxable}, isTscApplicable=${charge.isTscApplicable} => resolved: taxable=${finalIsTaxable}, tsc=${finalIsTscApplicable}`);

    // Override with Nepurix catalog item properties if matched
    if (Array.isArray(nepurixItems) && nepurixItems.length > 0) {
      const match = nepurixItems.find(ni => {
        const niCode = String(ni.Code || '').toUpperCase().trim();
        const niRef = String(ni.ReferenceId || '').toUpperCase().trim();
        const niName = String(ni.Name || '').toUpperCase().trim();

        const chargeCode = String(charge.code || '').toUpperCase().trim();
        const chargeRef = String(charge.referenceId || '').toUpperCase().trim();
        const chargeName = String(charge.name || '').toUpperCase().trim();

        return (chargeCode && niCode === chargeCode) ||
               (chargeRef && niRef === chargeRef) ||
               (chargeName && niName === chargeName);
      });

      if (match) {
        if (match.Name) finalName = match.Name;
        // Prioritize logical OR combining so demo sandbox mismatch flags do not disable taxes
        if (match.IsTaxable !== undefined) finalIsTaxable = match.IsTaxable === true || finalIsTaxable;
        if (match.IsExcisable !== undefined) finalIsTscApplicable = match.IsExcisable === true || finalIsTscApplicable;
        console.log(`[ACCOUNTING ITEM] "${finalName}" Nepurix match: IsTaxable=${match.IsTaxable}, IsExcisable=${match.IsExcisable} => final: taxable=${finalIsTaxable}, tsc=${finalIsTscApplicable}`);
      }
    }

    return {
      itemName: finalName,
      referenceId: charge.referenceId || null,
      itemPrice: customVal !== undefined ? Number(customVal) : Number(charge.amount || 0),
      isTaxable: finalIsTaxable,
      isTscApplicable: finalIsTscApplicable
    };
  });

  // Distribute total net amount if it's not a trial and sum of items is 0
  const sumOfPrices = itemsToUse.reduce((s, it) => s + it.itemPrice, 0);
  if (!isTrial && sumOfPrices === 0) {
    const netAmount = Number(order.totalAmount || 0);
    const tvItem = itemsToUse.find(it => /tv|nettv/i.test(it.itemName));

    let allocatedNets = itemsToUse.map(it => {
      if (tvItem) {
        if (/internet/i.test(it.itemName)) return round(netAmount * 0.375);
        if (/support/i.test(it.itemName)) return round(netAmount * 0.375);
        if (/tv|nettv/i.test(it.itemName)) return round(netAmount * 0.25);
      } else {
        if (/internet/i.test(it.itemName)) return round(netAmount * 0.50);
        if (/support/i.test(it.itemName)) return round(netAmount * 0.50);
      }
      return 0;
    });

    const totalAllocated = allocatedNets.reduce((s, v) => s + v, 0);
    if (totalAllocated === 0) {
      allocatedNets = itemsToUse.map(() => round(netAmount / itemsToUse.length));
    }

    const sumAllocated = allocatedNets.reduce((s, v) => s + v, 0);
    const diff = round(netAmount - sumAllocated);
    if (diff !== 0 && allocatedNets.length > 0) {
      const adjustIdx = allocatedNets.findIndex(v => v > 0) !== -1 ? allocatedNets.findIndex(v => v > 0) : allocatedNets.length - 1;
      allocatedNets[adjustIdx] = round(allocatedNets[adjustIdx] + diff);
    }

    itemsToUse = itemsToUse.map((it, idx) => {
      const allocatedNet = allocatedNets[idx];
      let basicPrice = 0;
      if (it.isTaxable && it.isTscApplicable) {
        basicPrice = allocatedNet / ((1 + tscRate) * 1.13);
      } else if (it.isTaxable) {
        basicPrice = allocatedNet / 1.13;
      } else {
        basicPrice = allocatedNet;
      }

      return {
        ...it,
        itemPrice: round(basicPrice)
      };
    });
  }

  return itemsToUse;
}

async function buildNepurixPayload(prisma, ispId, order, customItemsToUse = null, service = null) {
  const tscSetting = await prisma.iSPSettings.findFirst({ where: { ispId: Number(ispId), key: 'tscPercentage' } });
  const tscRate = number(tscSetting?.value || 10) / 100;

  const isTrial = Number(order.totalAmount || 0) === 0;
  const itemsToUse = customItemsToUse || await buildAccountingItems(prisma, ispId, order, service);

  let taxableAmount = 0;
  let calculatedNet = 0;
  let subTotal = 0;

  const detail = itemsToUse.map(item => {
    const isTaxable = item.isTaxable !== false;
    const isTscApplicable = item.isTscApplicable === true;
    const basicAmount = round(item.itemPrice);
    
    const tsc = isTscApplicable ? round(basicAmount * tscRate) : 0;
    const vatBase = isTaxable ? basicAmount + tsc : 0;
    const vat = isTaxable ? round(vatBase * 0.13) : 0;
    
    taxableAmount += vatBase;
    calculatedNet += basicAmount + tsc + vat;
    subTotal += basicAmount;

    return {
      item: item.itemName,
      quantity: 1,
      rate: basicAmount,
      basicAmount,
      discountAmount: null,
      amount: basicAmount,
      tax: taxName(isTaxable, isTscApplicable)
    };
  }).filter(d => d.rate > 0 || isTrial);

  const lead = order.customer?.lead || {};
  const customerName = `${lead.firstName || ''} ${lead.lastName || ''}`.trim() || order.customer?.customerUniqueId;
  const packageName = order.packagePrice?.packagePlanDetails?.planName || order.packagePrice?.packageName || null;
  const radiusUsername = order.customer?.connectionUsers?.[0]?.username || null;

  const finTagDetail = [];
  if (order.customer?.branch?.name) {
    finTagDetail.push({
      category: "Organization",
      finTag: order.customer.branch.name
    });
  }
  if (order.customer?.subBranch?.name) {
    finTagDetail.push({
      category: "Branch",
      finTag: order.customer.subBranch.name
    });
  }

  const payload = {
    invoiceType: 'Cash',
    paymentMode: paymentMode(order.paymentId),
    customer: customerName,
    UserName: order.customer?.customerUniqueId || radiusUsername,
    date: order.orderDate,
    remarks: `Invoice ${order.invoiceId || order.id} for customer ${customerName} (${order.customer?.customerUniqueId || radiusUsername})`,
    subTotal: round(subTotal),
    taxableAmount: round(taxableAmount),
    discount: null,
    netAmount: round(order.totalAmount || calculatedNet),
    package: packageName,
    packageAmount: round(order.totalAmount || calculatedNet),
    activationDate: convertToNepaliDate(order.packageStart),
    deActivationDate: convertToNepaliDate(order.packageEnd),
    detail,
    ...(finTagDetail.length > 0 ? { finTagDetail } : {})
  };

  console.log('[NEPURIX PAYLOAD DEBUG]:', JSON.stringify(payload, null, 2));

  return payload;
}

function buildTshulPayload(order, itemsToUse) {
  const lead = order.customer?.lead || {};
  const customerReferenceId = order.customer?.customerUniqueId || `CUST-${order.customerId}`;
  return {
    InvoiceType: 'Cash',
    PaymentMode: paymentMode(order.paymentId),
    Date: dateOnly(order.orderDate),
    SubTotal: round(itemsToUse.reduce((sum, item) => sum + number(item.itemPrice), 0)),
    TaxableAmount: round(order.totalAmount),
    NetAmount: round(order.totalAmount),
    CustomerReferenceId: customerReferenceId,
    OtherCustomerName: `${lead.firstName || ''} ${lead.lastName || ''}`.trim(),
    OtherCustomerMobile: lead.phoneNumber || '',
    Detail: itemsToUse.map(item => ({
      ItemReferenceId: item.referenceId,
      Quantity: 1,
      Rate: round(item.itemPrice),
      BasicAmount: round(item.itemPrice),
      Amount: round(item.itemPrice),
      DiscountAmount: 0
    }))
  };
}

async function syncOrderToAccounting(prisma, ispId, orderId) {
  const order = await loadOrder(prisma, ispId, orderId);
  if (!order || !order.isPaid || !order.items.length) return null;
  if (order.accountingInvoiceId) return { provider: order.accountingProvider, id: order.accountingInvoiceId, url: order.accountingInvoiceUrl };

  const service = await getEnabledAccountingClient(prisma, ispId);
  if (!service) {
    console.log(`[ACCOUNTING SYNC] No billing/accounting provider enabled for ispId: ${ispId}`);
    return null;
  }

  console.log(`[ACCOUNTING SYNC REQUEST] Syncing order ${orderId} to provider ${service.code}...`);

  if (service.code === SERVICE_CODES.NEPURIX) {
    try {
      console.log(`[ACCOUNTING SYNC] Listing existing Nepurix invoices...`);
      const invoices = await service.client.sales.list();
      const remarkToMatch = `ISP invoice ${order.invoiceId || order.id}`.toLowerCase().trim();
      const existing = Array.isArray(invoices)
        ? invoices.find(inv => (inv.Remarks || inv.remarks || '').toLowerCase().trim() === remarkToMatch)
        : null;
      if (existing) {
        const id = existing.Id ?? existing.id ?? existing.ReferenceId ?? existing.referenceId;
        const url = safeUrl(existing.InvoicePrintUrl ?? existing.invoicePrintUrl ?? existing.PrintUrl ?? null);
        if (id) {
          console.log('[NEPURIX] Found existing invoice for order, reusing:', id);
          await prisma.customerOrderManagement.update({
            where: { id: order.id },
            data: { accountingProvider: service.code, accountingInvoiceId: String(id), accountingInvoiceUrl: url, accountingSyncError: null }
          });
          return { provider: service.code, id: String(id), url };
        }
      }
    } catch (err) {
      console.error('[NEPURIX] Failed to check existing invoices list:', err.message);
    }
  }

  try {
    const itemsToUse = await buildAccountingItems(prisma, ispId, order, service);
    const payload = service.code === SERVICE_CODES.NEPURIX
      ? await buildNepurixPayload(prisma, ispId, order, itemsToUse, service)
      : buildTshulPayload(order, itemsToUse);
    
    console.log(`[ACCOUNTING SYNC] Creating invoice on ${service.code} with payload:`, JSON.stringify(payload));
    const result = await service.client.sales.create(payload);
    
    if (result && result.Error) {
      console.error(`[ACCOUNTING SYNC ERROR] ${service.code} API error:`, result.Error);
      throw new Error(`Nepurix API Error: ${result.Error}`);
    }
    
    const data = result?.Data || result?.data || result || {};
    const id = data.Id ?? data.id ?? data.ReferenceId ?? data.referenceId;
    const url = safeUrl(data.InvoicePrintUrl ?? data.invoicePrintUrl ?? data.PrintUrl ?? null);
    
    if (!id) {
      console.error(`[ACCOUNTING SYNC ERROR] No invoice ID returned from ${service.code}. Response:`, JSON.stringify(result));
      throw new Error(result?.Message || 'Accounting service did not return a sales invoice ID');
    }
    
    console.log(`[ACCOUNTING SYNC SUCCESS] Invoice successfully synced to ${service.code}. Invoice ID: ${id}`);
    
    await prisma.customerOrderManagement.update({
      where: { id: order.id },
      data: { accountingProvider: service.code, accountingInvoiceId: String(id), accountingInvoiceUrl: url, accountingSyncError: null }
    });
    return { provider: service.code, id: String(id), url, data };
  } catch (error) {
    console.error(`[ACCOUNTING SYNC ERROR] Exception during sync for order ${orderId}:`, error.message);
    await prisma.customerOrderManagement.update({
      where: { id: order.id },
      data: { accountingProvider: service.code, accountingSyncError: String(error.message || error).slice(0, 2000) }
    }).catch(() => {});
    throw error;
  }
}

async function fetchAccountingInvoices(prisma, ispId, orders) {
  const eligible = orders.filter(order => order.accountingInvoiceId);
  if (!eligible.length) return new Map();
  const service = await getEnabledAccountingClient(prisma, ispId);
  if (!service) return new Map();
  
  console.log(`[ACCOUNTING FETCH] Fetching ${eligible.length} invoices using provider ${service.code}...`);
  
  const pairs = await Promise.all(eligible.map(async order => {
    if (order.accountingProvider && order.accountingProvider !== service.code) return [order.id, null];
    try {
      console.log(`[ACCOUNTING FETCH REQUEST] Fetching invoice ${order.accountingInvoiceId} from ${service.code}...`);
      const invoice = await service.client.sales.get(order.accountingInvoiceId);
      console.log(`[ACCOUNTING FETCH SUCCESS] Invoice ${order.accountingInvoiceId} fetched successfully`);
      return [order.id, invoice?.Data || invoice?.data || invoice];
    } catch (error) {
      console.error(`[ACCOUNTING FETCH ERROR] Failed to fetch invoice ${order.accountingInvoiceId}:`, error.message);
      return [order.id, { id: order.accountingInvoiceId, invoicePrintUrl: order.accountingInvoiceUrl, fetchError: error.message }];
    }
  }));
  return new Map(pairs);
}

module.exports = { taxName, buildNepurixPayload, syncOrderToAccounting, fetchAccountingInvoices };
