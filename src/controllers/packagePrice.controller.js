const { ServiceFactory } = require('../lib/clients/ServiceFactory');
const { SERVICE_CODES } = require('../lib/serviceConstants');

async function resolveOneTimeCharges(prisma, ispId, requestedCharges) {
  const finalIds = [];
  if (!Array.isArray(requestedCharges) || requestedCharges.length === 0) {
    return finalIds;
  }

  for (const item of requestedCharges) {
    const id = (typeof item === 'object' && item !== null) ? item.id : item;
    if (!id) continue;

    const original = await prisma.OneTimeCharge.findFirst({
      where: { id: Number(id), isDeleted: false }
    });
    if (!original) continue;

    let baseCharge = original;
    if (!original.forPackageCreation) {
      const cleanName = original.name.split(' (')[0].trim();
      const catalogCharge = await prisma.OneTimeCharge.findFirst({
        where: {
          name: cleanName,
          forPackageCreation: true,
          ispId,
          isDeleted: false
        }
      });
      if (catalogCharge) {
        baseCharge = catalogCharge;
      }
    }
    finalIds.push(baseCharge.id);
  }
  return [...new Set(finalIds)];
}

async function createPackagePrice(req, res, next) {
  try {
    const {
      planId,
      price,
      packageDuration,
      isTrial,
      packageName,
      isActive,
      isOnline,
      initialTotalWithTax,
      renewAmountWithTax,
      isTscApplicable,
      oneTimeCharges = [],
      oneTimeChargeIds = []
    } = req.body;
    const ispId = Number(req.ispId);

    if (!planId || price === undefined || !packageDuration) {
      return res.status(400).json({ error: 'planId, price and packageDuration are required' });
    }

    // Fetch plan details
    const plan = await req.prisma.PackagePlan.findUnique({
      where: { id: Number(planId) },
      select: { planName: true, downSpeed: true, upSpeed: true, planCode: true }
    });
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    // === build a sanitized, short baseRefId ===
    const cleanPlanCode = plan.planCode.replace(/[\s-]/g, '');       // remove spaces & hyphens
    const cleanDuration = packageDuration.replace(/[\s-]/g, '');     // remove spaces & hyphens
    const baseRefId = `INT-${cleanPlanCode}${cleanDuration}`;
    const referenceId = `${baseRefId}`;

    // (optional) ensure uniqueness
    const exists = await req.prisma.PackagePrice.findFirst({ where: { referenceId } });
    if (exists) return res.status(400).json({ error: 'Reference ID collision, try again' });

    const addonPrices = {};
    const chargesToResolve = oneTimeCharges.length > 0 ? oneTimeCharges : oneTimeChargeIds;
    if (Array.isArray(chargesToResolve)) {
      for (const charge of chargesToResolve) {
        if (charge && typeof charge === 'object' && charge.id && charge.amount !== undefined) {
          const original = await req.prisma.OneTimeCharge.findFirst({
            where: { id: Number(charge.id), isDeleted: false }
          });
          let targetId = charge.id;
          if (original && !original.forPackageCreation) {
            const cleanName = original.name.split(' (')[0].trim();
            const catalogCharge = await req.prisma.OneTimeCharge.findFirst({
              where: {
                name: cleanName,
                forPackageCreation: true,
                ispId,
                isDeleted: false
              }
            });
            if (catalogCharge) {
              targetId = catalogCharge.id;
            }
          }
          addonPrices[String(targetId)] = Number(charge.amount);
        }
      }
    }
    const addonPricesJson = Object.keys(addonPrices).length > 0 ? JSON.stringify(addonPrices) : null;

    // Create DB record
    const record = await req.prisma.PackagePrice.create({
      data: {
        packageDuration: String(packageDuration),
        planId: Number(planId),
        price: parseFloat(price),
        initialTotalWithTax: initialTotalWithTax !== undefined && initialTotalWithTax !== null ? parseFloat(initialTotalWithTax) : null,
        renewAmountWithTax: renewAmountWithTax !== undefined && renewAmountWithTax !== null ? parseFloat(renewAmountWithTax) : null,
        isTscApplicable: isTscApplicable !== undefined ? Boolean(isTscApplicable) : false,
        packageName: packageName || `${plan.planName} - ${packageDuration}`,
        isActive: isActive !== false,
        isOnline: isOnline === true,
        ispId: ispId,
        referenceId,
        isTrial: isTrial === true,
        addonPricesJson,
        updatedAt: new Date()
      }
    });

    // Link addon charges (oneTimeCharges)
    const resolvedChargeIds = await resolveOneTimeCharges(req.prisma, ispId, chargesToResolve);
    if (resolvedChargeIds.length > 0) {
      await req.prisma.packageonetimecharges.createMany({
        data: resolvedChargeIds.map(cid => ({ A: record.id, B: Number(cid) })),
        skipDuplicates: true
      });
    }

    // Sync package price creation to all active billing clients!
    const syncResponses = {};
    try {
      const billingClients = await ServiceFactory.getActiveBillingClients(ispId, req.prisma);
      for (const { code, client } of billingClients) {
        try {
          const itemPayload = {
            Name: record.packageName,
            Code: `${cleanPlanCode}${cleanDuration}`,
            Unit: 'Mbps',
            ReferenceId: referenceId,
            ItemGroupReferenceId: 'TI-001',
            IsTaxable: true,
            IsExcisable: false,
            IsPurchaseItem: false,
            IsSalesItem: true,
            IsServiceItem: true,
            ReorderLevel: 0,
            ReorderQty: 0,
            IsBatchApplied: false,
            IsBatchPerQuantity: false,
            IsExpirable: false,
            PurchaseRate: 0.00,
            SalesMargin: 0.00,
            SalesRate: record.price,
            IsBOM: false
          };
          const itemResponse = await client.item.create(itemPayload);
          syncResponses[code] = itemResponse;
        } catch (syncErr) {
          console.warn(`[WARNING] ${code} sync failed for package price:`, syncErr.message);
          syncResponses[code] = { Error: syncErr.message };
        }
      }
    } catch (err) {
      console.warn('[WARNING] Failed to fetch active billing clients for package price sync:', err.message);
    }

    return res.status(201).json({ dbRecord: record, syncResponses });
  } catch (err) {
    console.error('[ERROR] Failed to create item in DB:', err.message);
    return next(err);
  }
}

async function getScopedPackagePlanIds(req) {
  if (req.user?.resellerId) {
    const links = await req.prisma.packagePlanReseller.findMany({
      where: { resellerId: Number(req.user.resellerId) },
      select: { packagePlanId: true }
    });
    return links.map(link => link.packagePlanId);
  }
  if (req.branchId) {
    const links = await req.prisma.PackagePlanBranch.findMany({
      where: { branchId: Number(req.branchId) },
      select: { packagePlanId: true }
    });
    return links.map(link => link.packagePlanId);
  }
  return null;
}

// List package prices without one-time charges
async function listPackagePrices(req, res, next) {
  try {
    const scopedPlanIds = await getScopedPackagePlanIds(req);
    const list = await req.prisma.PackagePrice.findMany({
      where: {
        isDeleted: false,
        ispId: req.ispId,
        ...(scopedPlanIds ? { planId: { in: scopedPlanIds } } : {}),
        ...(req.query.online === 'true' ? { isOnline: true, isActive: true } : {}),
        ...(req.query.active === 'true' ? { isActive: true } : {})
      },
      select: {
        id: true,
        price: true,
        initialTotalWithTax: true,
        renewAmountWithTax: true,
        isTscApplicable: true,
        packageDuration: true,
        packageName: true,
        isActive: true,
        isOnline: true,
        planId: true,
        referenceId: true,
        isTrial: true,
        addonPricesJson: true,
        packagePlanDetails: { select: { planName: true, downSpeed: true, upSpeed: true } }
      }
    });

    // Enrich with linked addon charges (oneTimeCharges)
    const enriched = await Promise.all(list.map(async (p) => {
      const links = await req.prisma.packageonetimecharges.findMany({
        where: { A: p.id }
      }).catch(() => []);
      const chargeIds = links.map(link => link.B);
      const customPrices = p.addonPricesJson ? JSON.parse(p.addonPricesJson) : {};
      const charges = chargeIds.length ? await req.prisma.OneTimeCharge.findMany({
        where: { id: { in: chargeIds }, isDeleted: false }
      }) : [];
      const mappedCharges = charges.map(c => ({
        ...c,
        amount: customPrices[String(c.id)] !== undefined ? customPrices[String(c.id)] : c.amount
      }));
      return {
        ...p,
        oneTimeCharges: mappedCharges
      };
    }));

    return res.json(enriched);
  } catch (err) {
    return next(err);
  }
}

// Get single package price without charges
async function getPackagePriceById(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

    const scopedPlanIds = await getScopedPackagePlanIds(req);
    const item = await req.prisma.PackagePrice.findFirst({
      where: {
        id,
        ispId: req.ispId,
        isDeleted: false,
        ...(scopedPlanIds ? { planId: { in: scopedPlanIds } } : {})
      },
      select: {
        id: true,
        price: true,
        initialTotalWithTax: true,
        renewAmountWithTax: true,
        isTscApplicable: true,
        packageDuration: true,
        packageName: true,
        isActive: true,
        isOnline: true,
        planId: true,
        referenceId: true,
        isTrial: true,
        addonPricesJson: true,
        packagePlanDetails: { select: { planName: true, downSpeed: true, upSpeed: true } }
      }
    });
    if (!item) return res.status(404).json({ error: 'Price record not found' });

    const links = await req.prisma.packageonetimecharges.findMany({
      where: { A: item.id }
    }).catch(() => []);
    const chargeIds = links.map(link => link.B);
    const customPrices = item.addonPricesJson ? JSON.parse(item.addonPricesJson) : {};
    const charges = chargeIds.length ? await req.prisma.OneTimeCharge.findMany({
      where: { id: { in: chargeIds }, isDeleted: false }
    }) : [];
    const mappedCharges = charges.map(c => ({
      ...c,
      amount: customPrices[String(c.id)] !== undefined ? customPrices[String(c.id)] : c.amount
    }));

    return res.json({
      ...item,
      oneTimeCharges: mappedCharges
    });
  } catch (err) {
    return next(err);
  }
}

// Update package price
async function updatePackagePrice(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

    const {
      planId,
      price,
      isTrial,
      packageName,
      isActive,
      isOnline,
      initialTotalWithTax,
      renewAmountWithTax,
      isTscApplicable,
      oneTimeCharges,
      oneTimeChargeIds
    } = req.body;

    const existing = await req.prisma.PackagePrice.findUnique({
      where: { id }
    });
    if (!existing) return res.status(404).json({ error: 'NOT_FOUND' });

    const chargesToResolve = oneTimeCharges !== undefined ? oneTimeCharges : oneTimeChargeIds;
    let addonPricesJson = undefined;
    if (chargesToResolve !== undefined) {
      const addonPrices = {};
      if (Array.isArray(chargesToResolve)) {
        for (const charge of chargesToResolve) {
          if (charge && typeof charge === 'object' && charge.id && charge.amount !== undefined) {
            const original = await req.prisma.OneTimeCharge.findFirst({
              where: { id: Number(charge.id), isDeleted: false }
            });
            let targetId = charge.id;
            if (original && !original.forPackageCreation) {
              const cleanName = original.name.split(' (')[0].trim();
              const catalogCharge = await req.prisma.OneTimeCharge.findFirst({
                where: {
                  name: cleanName,
                  forPackageCreation: true,
                  ispId: Number(req.ispId || original.ispId),
                  isDeleted: false
                }
              });
              if (catalogCharge) {
                targetId = catalogCharge.id;
              }
            }
            addonPrices[String(targetId)] = Number(charge.amount);
          }
        }
      }
      addonPricesJson = Object.keys(addonPrices).length > 0 ? JSON.stringify(addonPrices) : null;
    }

    const updated = await req.prisma.PackagePrice.update({
      where: { id },
      data: {
        planId: planId !== undefined ? Number(planId) : undefined,
        price: price !== undefined ? parseFloat(price) : undefined,
        initialTotalWithTax: initialTotalWithTax !== undefined ? (initialTotalWithTax !== null ? parseFloat(initialTotalWithTax) : null) : undefined,
        renewAmountWithTax: renewAmountWithTax !== undefined ? (renewAmountWithTax !== null ? parseFloat(renewAmountWithTax) : null) : undefined,
        isTscApplicable: isTscApplicable !== undefined ? Boolean(isTscApplicable) : undefined,
        packageName: packageName !== undefined ? packageName : undefined,
        isActive: isActive !== undefined ? Boolean(isActive) : undefined,
        isOnline: isOnline !== undefined ? Boolean(isOnline) : undefined,
        isTrial: isTrial !== undefined ? isTrial : undefined,
        addonPricesJson: addonPricesJson !== undefined ? addonPricesJson : undefined,
        updatedAt: new Date()
      }
    });

    if (chargesToResolve !== undefined) {
      const resolvedChargeIds = await resolveOneTimeCharges(req.prisma, Number(req.ispId || updated.ispId), chargesToResolve);
      await req.prisma.packageonetimecharges.deleteMany({ where: { A: id } });
      if (resolvedChargeIds.length > 0) {
        await req.prisma.packageonetimecharges.createMany({
          data: resolvedChargeIds.map(cid => ({ A: id, B: Number(cid) })),
          skipDuplicates: true
        });
      }
    }

    return res.json(updated);
  } catch (err) {
    return next(err);
  }
}

// Soft delete package price
async function deletePackagePrice(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ID' });

    await req.prisma.PackagePrice.update({
      where: { id },
      data: { isDeleted: true, updatedAt: new Date() }
    });

    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
}

// Resync prices with active billing clients
async function resyncPackagePrice(req, res, next) {
  try {
    const ispId = Number(req.ispId);
    const billingClients = await ServiceFactory.getActiveBillingClients(ispId, req.prisma);
    if (billingClients.length === 0) return res.status(400).json({ error: 'No active billing service available' });

    const prices = await req.prisma.PackagePrice.findMany({
      where: { ispId, isDeleted: false },
      include: { packagePlanDetails: true }
    });

    const results = {};
    for (const { code, client } of billingClients) {
      let successCount = 0;
      for (const p of prices) {
        const payload = {
          Name: `${p.packagePlanDetails?.planName || 'Plan'} - ${p.packageDuration}`,
          Code: p.referenceId?.split('-')[1] || p.id.toString(),
          Unit: 'Mbps',
          ReferenceId: p.referenceId,
          IsSalesItem: true,
          SalesRate: p.price
        };
        try {
          await client.item.create(payload);
          successCount++;
        } catch (e) {
          console.warn(`[${code}] Sync failed for price ${p.id}:`, e.message);
        }
      }
      results[code] = { synced: successCount, total: prices.length };
    }

    return res.json({ success: true, syncResults: results });
  } catch (err) {
    return next(err);
  }
}

async function createBulkPackagePrices(req, res, next) {
  try {
    const { planId, packageName, prices } = req.body;
    const ispId = Number(req.ispId);

    if (!planId || !Array.isArray(prices) || prices.length === 0) {
      return res.status(400).json({ error: 'planId and prices array are required' });
    }

    const plan = await req.prisma.PackagePlan.findUnique({
      where: { id: Number(planId) },
      select: { planName: true, planCode: true }
    });
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const results = [];

    for (const p of prices) {
      const {
        duration,
        price,
        initialTotalWithTax,
        renewAmountWithTax,
        isTscApplicable,
        isActive,
        isOnline,
        oneTimeCharges = [],
        oneTimeChargeIds = []
      } = p;
      if (price === undefined || !duration) continue;

      const cleanPlanCode = plan.planCode.replace(/[\s-]/g, '');
      const cleanDuration = duration.replace(/[\s-]/g, '');
      const baseRefId = `INT-${cleanPlanCode}${cleanDuration}`;
      const referenceId = `${baseRefId}`;

      const chargesToResolve = oneTimeCharges.length > 0 ? oneTimeCharges : oneTimeChargeIds;
      const resolvedChargeIds = await resolveOneTimeCharges(req.prisma, ispId, chargesToResolve);

      const addonPrices = {};
      if (Array.isArray(chargesToResolve)) {
        for (const charge of chargesToResolve) {
          if (charge && typeof charge === 'object' && charge.id && charge.amount !== undefined) {
            addonPrices[String(charge.id)] = Number(charge.amount);
          }
        }
      }
      const addonPricesJson = Object.keys(addonPrices).length > 0 ? JSON.stringify(addonPrices) : null;

      const exists = await req.prisma.PackagePrice.findFirst({ where: { referenceId, isDeleted: false } });
      if (exists) {
        const record = await req.prisma.PackagePrice.update({
          where: { id: exists.id },
          data: {
            price: parseFloat(price),
            initialTotalWithTax: initialTotalWithTax !== undefined && initialTotalWithTax !== null ? parseFloat(initialTotalWithTax) : null,
            renewAmountWithTax: renewAmountWithTax !== undefined && renewAmountWithTax !== null ? parseFloat(renewAmountWithTax) : null,
            isTscApplicable: isTscApplicable !== undefined ? Boolean(isTscApplicable) : false,
            packageName: `${String(packageName || plan.planName).trim()} - ${duration}`,
            isActive: isActive !== false,
            isOnline: isOnline === true,
            addonPricesJson,
            updatedAt: new Date()
          }
        });

        await req.prisma.packageonetimecharges.deleteMany({ where: { A: record.id } });
        if (resolvedChargeIds.length > 0) {
          await req.prisma.packageonetimecharges.createMany({
            data: resolvedChargeIds.map(cid => ({ A: record.id, B: Number(cid) })),
            skipDuplicates: true
          });
        }

        results.push(record);
        continue;
      }

      const record = await req.prisma.PackagePrice.create({
        data: {
          packageDuration: String(duration),
          planId: Number(planId),
          price: parseFloat(price),
          initialTotalWithTax: initialTotalWithTax !== undefined && initialTotalWithTax !== null ? parseFloat(initialTotalWithTax) : null,
          renewAmountWithTax: renewAmountWithTax !== undefined && renewAmountWithTax !== null ? parseFloat(renewAmountWithTax) : null,
          isTscApplicable: isTscApplicable !== undefined ? Boolean(isTscApplicable) : false,
          packageName: `${String(packageName || plan.planName).trim()} - ${duration}`,
          isActive: isActive !== false,
          isOnline: isOnline === true,
          ispId: ispId,
          referenceId,
          isTrial: false,
          addonPricesJson,
          updatedAt: new Date()
        }
      });

      if (resolvedChargeIds.length > 0) {
        await req.prisma.packageonetimecharges.createMany({
          data: resolvedChargeIds.map(cid => ({ A: record.id, B: Number(cid) })),
          skipDuplicates: true
        });
      }

      results.push(record);

      try {
        const billingClients = await ServiceFactory.getActiveBillingClients(ispId, req.prisma);
        for (const { code, client } of billingClients) {
          const itemPayload = {
            Name: record.packageName,
            Code: `${cleanPlanCode}${cleanDuration}`,
            Unit: 'Mbps',
            ReferenceId: referenceId,
            ItemGroupReferenceId: 'TI-001',
            IsTaxable: true,
            IsSalesItem: true,
            IsServiceItem: true,
            SalesRate: record.price
          };
          await client.item.create(itemPayload).catch(() => {});
        }
      } catch (err) {}
    }

    return res.status(201).json({ success: true, count: results.length, data: results });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createPackagePrice,
  listPackagePrices,
  getPackagePriceById,
  updatePackagePrice,
  deletePackagePrice,
  resyncPackagePrice,
  createBulkPackagePrices
};
