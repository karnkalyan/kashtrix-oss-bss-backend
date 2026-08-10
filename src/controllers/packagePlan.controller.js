const { ServiceFactory } = require('../lib/clients/ServiceFactory');
const { SERVICE_CODES } = require('../lib/serviceConstants');

async function convertMbpsToKbps(mbps) {
  if (typeof mbps !== 'number' || isNaN(mbps)) return 0;
  return mbps * 1000;
}

function calculateJuniperBurstBytes(mbps) {
  const speed = Number(mbps) || 0;
  return Math.round((speed * 1000000 / 8) * 0.005);
}

function formatMikrotikRateLimit(plan, upMbps, downMbps) {
  const upload = Number(upMbps) || 0;
  const download = Number(downMbps) || 0;
  const priority = Number(plan.priority) >= 1 && Number(plan.priority) <= 8 ? Number(plan.priority) : 8;
  const burstUpload = Number(plan.mikrotikBurstUpload || plan.burstUpload || upload) || upload;
  const burstDownload = Number(plan.mikrotikBurstDownload || plan.burstDownload || download) || download;
  const thresholdUpload = Number(plan.mikrotikBurstThresholdUpload || plan.burstThresholdUpload || Math.floor(upload * 0.8)) || upload;
  const thresholdDownload = Number(plan.mikrotikBurstThresholdDownload || plan.burstThresholdDownload || Math.floor(download * 0.8)) || download;
  const burstTime = plan.mikrotikBurstTime || plan.burstTime || '5/5';
  const minUpload = Number(plan.mikrotikMinUpload || plan.minUpload || upload) || upload;
  const minDownload = Number(plan.mikrotikMinDownload || plan.minDownload || download) || download;

  return [
    `${upload}M/${download}M`,
    `${burstUpload}M/${burstDownload}M`,
    `${thresholdUpload}M/${thresholdDownload}M`,
    burstTime,
    String(priority),
    `${minUpload}M/${minDownload}M`
  ].join(' ');
}

function normalizeVendorProfiles(plan) {
  const selectedNas = (plan.nasType || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const profiles = Array.isArray(plan.vendorProfiles) ? [...plan.vendorProfiles] : [];
  const hasVendor = (vendor) => profiles.some(profile => (profile.vendor || "").toLowerCase() === vendor);

  if (selectedNas.includes('juniper') && !hasVendor('juniper')) {
    profiles.push({ vendor: 'juniper', profile: 'x-ppp-profile' });
  }

  return profiles;
}

/**
 * Generates vendor-specific RADIUS attributes based on plan speeds and profiles.
 * Supports MikroTik (static), Juniper (dynamic), and Nokia (dynamic).
 */
async function generateRadiusAttributes(plan) {
  const replyAttrs = [];
  const nasList = (plan.nasType || "").split(",").map(s => s.trim().toLowerCase());

  const downMbps = Number(plan.downSpeed) || 0;
  const upMbps = Number(plan.upSpeed) || 0;
  const downKbps = await convertMbpsToKbps(downMbps);
  const upKbps = await convertMbpsToKbps(upMbps);

  // 1. MikroTik logic (Standard attribute)
  if (nasList.includes('mikrotik')) {
    replyAttrs.push({
      attribute: 'Mikrotik-Rate-Limit',
      op: ':=',
      value: formatMikrotikRateLimit(plan, upMbps, downMbps)
    });
  }

  // 2. Generic / Multi-vendor Dynamic Profiles
  const vendorProfiles = normalizeVendorProfiles(plan);
  if (Array.isArray(vendorProfiles)) {
    for (const vp of vendorProfiles) {
      const vendor = (vp.vendor || "").toLowerCase();
      const profile = vp.profile || "";

      if (vendor === 'juniper') {
        const bandwidthMbps = downMbps || upMbps;
        const burstBytes = calculateJuniperBurstBytes(bandwidthMbps);
        replyAttrs.push(
          { attribute: 'ERX-Client-Profile-Name', op: '=', value: profile || 'x-ppp-profile' },
          { attribute: 'ERX-Service-Description', op: '+=', value: `bandwidth=${bandwidthMbps}m` },
          { attribute: 'ERX-Service-Description', op: '+=', value: `burst=${burstBytes}` },
          { attribute: 'ERX-IPv6-Delegated-Pool-Name', op: ':=', value: 'v6-default-pd' },
          { attribute: 'Framed-IPv6-Pool', op: ':=', value: 'v6-ndra' }
        );
      }
    }
  }

  // 3. Nokia QoS override attributes
  const hasNokiaProfile = vendorProfiles.some(profile => String(profile.vendor || '').toLowerCase() === 'nokia');
  if (nasList.includes('nokia') || hasNokiaProfile) {
    const egressRate = downKbps || upKbps;
    const ingressRate = upKbps || downKbps;
    replyAttrs.push(
      { attribute: 'Alc-Subscriber-Qos-Override', op: '+=', value: `E:Q:1:pir=${egressRate},cir=${egressRate}` },
      { attribute: 'Alc-Subscriber-Qos-Override', op: '+=', value: `I:Q:1:pir=${ingressRate},cir=${ingressRate}` }
    );
  }

  // 4. Common attributes (Framed-Pool)
  if (plan.applyFramedPool && plan.framedPoolValue) {
    replyAttrs.push({
      attribute: 'Framed-Pool',
      op: ':=',
      value: plan.framedPoolValue
    });
  }

  // 5. Custom Attributes
  if (Array.isArray(plan.customRadiusAttributes)) {
    for (const attr of plan.customRadiusAttributes) {
      if (attr.attribute && attr.op && attr.value) {
        replyAttrs.push({
          attribute: attr.attribute,
          op: attr.op,
          value: String(attr.value)
        });
      }
    }
  }

  return replyAttrs;
}

async function enrichPackagePlans(prisma, plans) {
  const list = Array.isArray(plans) ? plans : [plans].filter(Boolean);
  if (!list.length) return Array.isArray(plans) ? [] : null;

  const connectionTypeIds = [...new Set(list.map(plan => plan.connectionType).filter(Boolean))];
  const planIds = list.map(plan => plan.id);

  const [connectionTypes, branchLinks, resellerLinks] = await Promise.all([
    connectionTypeIds.length
      ? prisma.ConnectionType.findMany({
        where: { id: { in: connectionTypeIds } },
        select: { id: true, name: true, code: true }
      })
      : [],
    planIds.length
      ? prisma.PackagePlanBranch.findMany({
        where: { packagePlanId: { in: planIds } }
      })
      : [],
    planIds.length
      ? prisma.packagePlanReseller.findMany({
        where: { packagePlanId: { in: planIds } }
      })
      : []
  ]);

  const branchIds = [...new Set(branchLinks.map(link => link.branchId).filter(Boolean))];
  const branches = branchIds.length
    ? await prisma.Branch.findMany({
      where: { id: { in: branchIds } },
      select: { id: true, name: true, code: true }
    })
    : [];
  const resellerIds = [...new Set(resellerLinks.map(link => link.resellerId).filter(Boolean))];
  const resellers = resellerIds.length
    ? await prisma.reseller.findMany({
      where: { id: { in: resellerIds }, isDeleted: false },
      select: { id: true, name: true, code: true }
    })
    : [];

  const connectionTypeById = new Map(connectionTypes.map(type => [type.id, type]));
  const branchById = new Map(branches.map(branch => [branch.id, branch]));
  const resellerById = new Map(resellers.map(reseller => [reseller.id, reseller]));
  const linksByPlanId = new Map();
  const resellerLinksByPlanId = new Map();

  branchLinks.forEach(link => {
    if (!linksByPlanId.has(link.packagePlanId)) linksByPlanId.set(link.packagePlanId, []);
    linksByPlanId.get(link.packagePlanId).push({
      ...link,
      branch: branchById.get(link.branchId) || null
    });
  });
  resellerLinks.forEach(link => {
    if (!resellerLinksByPlanId.has(link.packagePlanId)) resellerLinksByPlanId.set(link.packagePlanId, []);
    resellerLinksByPlanId.get(link.packagePlanId).push({
      ...link,
      reseller: resellerById.get(link.resellerId) || null
    });
  });

  const enriched = list.map(plan => ({
    ...plan,
    connectionTypeDetails: plan.connectionType ? connectionTypeById.get(plan.connectionType) || null : null,
    branches: linksByPlanId.get(plan.id) || [],
    resellers: resellerLinksByPlanId.get(plan.id) || []
  }));

  return Array.isArray(plans) ? enriched : enriched[0];
}

// Create a new package plan
async function createPackagePlan(req, res, next) {
  try {
    const {
      planName, planCode, connectionType, dataLimit, downSpeed, upSpeed,
      intUpload, firDownload, localUpload, localDownload, isPopular,
      description, deviceLimit, nasType, service, priority,
      packageType, allowRename, fupApply, fupLimitGb, fupPenaltyPlanId, isFupPackage,
      onlyRenewal, applyFramedPool, framedPoolValue, customRadiusAttributes,
      vendorProfiles, maxDiscountPercentage, maxDiscountCount, highPriority,
      branchIds,
      resellerIds
    } = req.body;

    const connectionTypeId = Number(connectionType);
    if (!Number.isInteger(connectionTypeId) || connectionTypeId <= 0) {
      return res.status(400).json({ error: 'connectionType is required' });
    }

    const planData = {
      planName, planCode,
      connectionTypeDetails: { connect: { id: connectionTypeId } },
      dataLimit: Number(dataLimit) || 0,
      downSpeed: downSpeed ? Number(downSpeed) : null,
      upSpeed: upSpeed ? Number(upSpeed) : null,
      intUpload: intUpload ? Number(intUpload) : null,
      firDownload: firDownload ? Number(firDownload) : null,
      localUpload: localUpload ? Number(localUpload) : null,
      localDownload: localDownload ? Number(localDownload) : null,
      isPopular: Boolean(isPopular),
      description,
      deviceLimit: deviceLimit ? Number(deviceLimit) : null,
      nasType: nasType || null,
      service: service || null,
      priority: priority || null,
      vendorProfiles: vendorProfiles || null,
      packageType: packageType || null,
      allowRename: Boolean(allowRename),
      fupApply: fupApply !== undefined ? Boolean(fupApply) : true,
      fupLimitGb: fupLimitGb !== undefined && fupLimitGb !== null && fupLimitGb !== '' ? Number(fupLimitGb) : null,
      fupPenaltyPlanId: fupPenaltyPlanId !== undefined && fupPenaltyPlanId !== null && fupPenaltyPlanId !== '' ? Number(fupPenaltyPlanId) : null,
      isFupPackage: Boolean(isFupPackage),
      onlyRenewal: Boolean(onlyRenewal),
      applyFramedPool: Boolean(applyFramedPool),
      framedPoolValue: framedPoolValue || null,
      customRadiusAttributes: customRadiusAttributes || null,
      maxDiscountPercentage: maxDiscountPercentage !== undefined ? Number(maxDiscountPercentage) : 100,
      maxDiscountCount: maxDiscountCount !== undefined ? Number(maxDiscountCount) : 0,
      highPriority: Boolean(highPriority),
      isActive: true,
      isp: req.ispId ? { connect: { id: req.ispId } } : undefined,
      isDeleted: false,
      updatedAt: new Date()
    };

    const isExisting = await req.prisma.PackagePlan.findFirst({
      where: { planCode, ispId: req.ispId, isDeleted: false }
    });
    if (isExisting) return res.status(409).json({ error: 'Package plan already exists' });

    const plan = await req.prisma.PackagePlan.create({ data: planData });

    // Handle branch associations
    if (Array.isArray(branchIds) && branchIds.length > 0) {
      await req.prisma.PackagePlanBranch.createMany({
        data: branchIds.map(bId => ({ packagePlanId: plan.id, branchId: Number(bId) })),
        skipDuplicates: true
      });
    }
    if (Array.isArray(resellerIds) && resellerIds.length > 0) {
      const validResellers = await req.prisma.reseller.findMany({
        where: { id: { in: resellerIds.map(Number) }, ispId: Number(req.ispId), isDeleted: false },
        select: { id: true }
      });
      if (validResellers.length !== new Set(resellerIds.map(Number)).size) {
        await req.prisma.PackagePlan.update({ where: { id: plan.id }, data: { isDeleted: true } });
        return res.status(400).json({ error: 'One or more reseller assignments are invalid' });
      }
      await req.prisma.packagePlanReseller.createMany({
        data: validResellers.map(reseller => ({ packagePlanId: plan.id, resellerId: reseller.id })),
        skipDuplicates: true
      });
    }

    // RADIUS sync
    try {
      const client = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, req.ispId);
      if (client) {
        await client.createRadgroupcheck({ groupname: planCode, attribute: 'Auth-Type', op: ':=', value: 'Accept' });
        const replyAttrs = await generateRadiusAttributes(plan);
        let firstReplyId = null;
        for (const attr of replyAttrs) {
          const result = await client.createRadgroupreply({ groupname: planCode, ...attr });
          if (!firstReplyId) firstReplyId = result.id;
        }
        if (firstReplyId) {
          await req.prisma.PackagePlan.update({ where: { id: plan.id }, data: { radgroupreplyId: firstReplyId } });
        }
      }
    } catch (err) { console.error("Radius sync failed:", err); }

    const finalPlan = await enrichPackagePlans(req.prisma, plan);
    return res.status(201).json(finalPlan);
  } catch (err) { return next(err); }
}

async function listPackagePlans(req, res, next) {
  try {
    const scopedPlanLinks = req.user?.resellerId
      ? await req.prisma.packagePlanReseller.findMany({
        where: { resellerId: Number(req.user.resellerId) },
        select: { packagePlanId: true }
      })
      : req.branchId
        ? await req.prisma.PackagePlanBranch.findMany({
          where: { branchId: Number(req.branchId) },
          select: { packagePlanId: true }
        })
      : null;
    const list = await req.prisma.PackagePlan.findMany({
      where: {
        isDeleted: false,
        ispId: req.ispId,
        ...(scopedPlanLinks ? { id: { in: scopedPlanLinks.map(link => link.packagePlanId) } } : {})
      },
      orderBy: { createdAt: 'desc' }
    });
    return res.json(await enrichPackagePlans(req.prisma, list));
  } catch (err) { return next(err); }
}

async function getPackagePlanById(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (req.user?.resellerId) {
      const assignment = await req.prisma.packagePlanReseller.findFirst({
        where: { packagePlanId: id, resellerId: Number(req.user.resellerId) },
        select: { id: true }
      });
      if (!assignment) return res.status(404).json({ error: 'Plan not found' });
    } else if (req.branchId) {
      const assignment = await req.prisma.PackagePlanBranch.findFirst({
        where: { packagePlanId: id, branchId: Number(req.branchId) },
        select: { id: true }
      });
      if (!assignment) return res.status(404).json({ error: 'Plan not found' });
    }
    const plan = await req.prisma.PackagePlan.findFirst({
      where: { id, ispId: req.ispId, isDeleted: false }
    });
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    return res.json(await enrichPackagePlans(req.prisma, plan));
  } catch (err) { return next(err); }
}

async function updatePackagePlan(req, res, next) {
  try {
    const id = Number(req.params.id);
    const existing = await req.prisma.PackagePlan.findFirst({ where: { id, ispId: req.ispId, isDeleted: false } });
    if (!existing) return res.status(404).json({ error: 'Plan not found' });

    const data = {};
    const fields = [
      'planName', 'planCode', 'dataLimit', 'downSpeed', 'upSpeed',
      'intUpload', 'firDownload', 'localUpload', 'localDownload',
      'isPopular', 'description', 'deviceLimit', 'isActive',
      'nasType', 'service', 'priority', 'vendorProfiles',
      'packageType', 'allowRename', 'fupApply', 'fupLimitGb', 'fupPenaltyPlanId',
      'isFupPackage', 'onlyRenewal', 'applyFramedPool',
      'framedPoolValue', 'customRadiusAttributes',
      'maxDiscountPercentage', 'maxDiscountCount', 'highPriority'
    ];

    fields.forEach(f => {
      if (req.body[f] !== undefined) {
        if (['downSpeed', 'upSpeed', 'intUpload', 'firDownload', 'localUpload', 'localDownload', 'dataLimit', 'fupLimitGb', 'fupPenaltyPlanId', 'maxDiscountPercentage', 'maxDiscountCount'].includes(f)) {
          data[f] = req.body[f] === null ? null : Number(req.body[f]);
        } else if (['isPopular', 'isActive', 'allowRename', 'fupApply', 'isFupPackage', 'onlyRenewal', 'applyFramedPool', 'highPriority'].includes(f)) {
          data[f] = Boolean(req.body[f]);
        } else {
          data[f] = req.body[f];
        }
      }
    });

    if (req.body.connectionType !== undefined) {
      if (!req.body.connectionType) return res.status(400).json({ error: 'connectionType is required' });
      data.connectionTypeDetails = { connect: { id: Number(req.body.connectionType) } };
    }
    data.updatedAt = new Date();

    const updated = await req.prisma.PackagePlan.update({
      where: { id },
      data
    });

    if (Array.isArray(req.body.branchIds)) {
      await req.prisma.PackagePlanBranch.deleteMany({ where: { packagePlanId: id } });
      if (req.body.branchIds.length > 0) {
        await req.prisma.PackagePlanBranch.createMany({
          data: req.body.branchIds.map(bId => ({ packagePlanId: id, branchId: Number(bId) })),
          skipDuplicates: true
        });
      }
    }
    if (Array.isArray(req.body.resellerIds)) {
      const requestedIds = [...new Set(req.body.resellerIds.map(Number))];
      const validResellers = requestedIds.length ? await req.prisma.reseller.findMany({
        where: { id: { in: requestedIds }, ispId: Number(req.ispId), isDeleted: false },
        select: { id: true }
      }) : [];
      if (validResellers.length !== requestedIds.length) {
        return res.status(400).json({ error: 'One or more reseller assignments are invalid' });
      }
      await req.prisma.packagePlanReseller.deleteMany({ where: { packagePlanId: id } });
      if (validResellers.length) {
        await req.prisma.packagePlanReseller.createMany({
          data: validResellers.map(reseller => ({ packagePlanId: id, resellerId: reseller.id })),
          skipDuplicates: true
        });
      }
    }

    try {
      const client = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, req.ispId);
      if (client) {
        const existingReplies = await client.getRadgroupreplyByGroupname(existing.planCode);
        for (const r of existingReplies) await client.deleteRadgroupreply(r.id);

        const replyAttrs = await generateRadiusAttributes(updated);
        let firstId = null;
        for (const attr of replyAttrs) {
          const result = await client.createRadgroupreply({ groupname: updated.planCode, ...attr });
          if (!firstId) firstId = result.id;
        }
        if (firstId) await req.prisma.PackagePlan.update({ where: { id }, data: { radgroupreplyId: firstId } });

        if (updated.planCode !== existing.planCode) {
          const checks = await client.getRadgroupcheck();
          const check = checks.find(c => c.groupname === existing.planCode && c.attribute === 'Auth-Type');
          if (check) await client.updateRadgroupcheck(check.id, { groupname: updated.planCode, attribute: 'Auth-Type', op: ':=', value: 'Accept' });
          else await client.createRadgroupcheck({ groupname: updated.planCode, attribute: 'Auth-Type', op: ':=', value: 'Accept' });
        }
      }
    } catch (err) { console.error("Radius update failed:", err); }

    const finalPlan = await enrichPackagePlans(req.prisma, updated);
    return res.json(finalPlan);
  } catch (err) { return next(err); }
}

async function deletePackagePlan(req, res, next) {
  try {
    const id = Number(req.params.id);
    const existing = await req.prisma.PackagePlan.findFirst({ where: { id, ispId: req.ispId } });
    if (!existing) return res.status(404).json({ error: 'Plan not found' });
    await req.prisma.PackagePlan.update({ where: { id }, data: { isDeleted: true } });
    try {
      const client = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, req.ispId);
      if (client) {
        const replies = await client.getRadgroupreplyByGroupname(existing.planCode);
        for (const r of replies) await client.deleteRadgroupreply(r.id);
        const checks = await client.getRadgroupcheck();
        const groupChecks = checks.filter(c => c.groupname === existing.planCode);
        for (const c of groupChecks) await client.deleteRadgroupcheck(c.id);
      }
    } catch (err) { console.error("Radius delete failed:", err); }
    return res.json({ message: 'Plan deleted', id });
  } catch (err) { return next(err); }
}

async function resyncPackagePlan(req, res, next) {
  try {
    const client = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, req.ispId);
    if (!client) throw new Error("Radius client not available");

    const localList = await req.prisma.PackagePlan.findMany({ where: { ispId: req.ispId, isDeleted: false } });
    let createdRadius = 0;

    for (const local of localList) {
      // Refresh logic as recommended in plan
      const existingReplies = await client.getRadgroupreplyByGroupname(local.planCode);
      for (const r of existingReplies) await client.deleteRadgroupreply(r.id);

      // Re-create Auth check
      const checks = await client.getRadgroupcheck();
      const hasCheck = checks.some(c => c.groupname === local.planCode && c.attribute === 'Auth-Type');
      if (!hasCheck) {
        await client.createRadgroupcheck({ groupname: local.planCode, attribute: 'Auth-Type', op: ':=', value: 'Accept' });
      }

      const replyAttrs = await generateRadiusAttributes(local);
      let firstId = null;
      for (const attr of replyAttrs) {
        const result = await client.createRadgroupreply({ groupname: local.planCode, ...attr });
        if (!firstId) firstId = result.id;
      }
      if (firstId) await req.prisma.PackagePlan.update({ where: { id: local.id }, data: { radgroupreplyId: firstId } });
      createdRadius++;
    }
    res.json({ message: "Resync completed", stats: { createdRadius } });
  } catch (err) { next(err); }
}

module.exports = { createPackagePlan, listPackagePlans, getPackagePlanById, updatePackagePlan, deletePackagePlan, resyncPackagePlan };
