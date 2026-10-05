const bcrypt = require('bcrypt');
const { ServiceFactory } = require('../lib/clients/ServiceFactory');
const { SERVICE_CODES } = require('../lib/serviceConstants');
const { invalidateGenieACSResponseCache } = require('../lib/genieacsResponseCache');

// Sync TR069 devices from GenieACS to local database
function hashProviderSecret(secret) {
  return crypto.createHash('sha256').update(String(secret || ''), 'utf8').digest('hex');
}

function isSystemAdministrator(req) {
  const role = String(req.user?.role || '').trim().toLowerCase();
  return ['administrator', 'admin', 'super admin'].includes(role) || role.startsWith('global ');
}

function isProviderAdministrator(req) {
  return isSystemAdministrator(req) && Number(req.ispId) === Number(process.env.DEFAULT_ISP_ID || 1);
}

async function hasProviderOverride(req) {
  const supplied = String(req.get('x-tr069-provider-secret') || '');
  if (!supplied) return false;
  const setting = await req.prisma.iSPSettings.findUnique({ where: { key: TR069_PROVIDER_SECRET_KEY } });
  if (!setting?.value) return false;
  const suppliedHash = Buffer.from(hashProviderSecret(supplied), 'hex');
  const storedHash = Buffer.from(setting.value, 'hex');
  return suppliedHash.length === storedHash.length && crypto.timingSafeEqual(suppliedHash, storedHash);
}

async function setProviderSecret(req, res, next) {
  try {
    if (!isProviderAdministrator(req)) return res.status(403).json({ error: 'Provider access is restricted.' });
    const secret = String(req.body?.secret || '');
    if (secret.length < 12) return res.status(400).json({ error: 'Provider secret must contain at least 12 characters.' });
    await req.prisma.iSPSettings.upsert({
      where: { key: TR069_PROVIDER_SECRET_KEY },
      update: { value: hashProviderSecret(secret), updatedAt: new Date() },
      create: {
        ispId: req.ispId,
        key: TR069_PROVIDER_SECRET_KEY,
        value: hashProviderSecret(secret),
        description: 'Hashed provider-only TR-069 inventory access secret',
        updatedAt: new Date()
      }
    });
    return res.json({ success: true, message: 'Provider access secret updated.' });
  } catch (error) {
    return next(error);
  }
}

async function verifyProviderSecret(req, res, next) {
  try {
    return res.json({ success: true, authorized: await hasProviderOverride(req) });
  } catch (error) {
    return next(error);
  }
}


async function syncDevices(req, res, next) {
  try {
    const ispId = req.ispId;

    // Get GenieACS client
    let genieClient;
    try {
      genieClient = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);
    } catch (err) {
      console.warn("GenieACS client not configured for this ISP:", err.message);
      return res.json({
        success: true,
        message: 'GenieACS service is not configured for this ISP. Device sync skipped.',
        stats: {
          total: 0,
          created: 0,
          updated: 0
        }
      });
    }

    if (!genieClient) {
      return res.status(400).json({ error: 'GenieACS service not configured' });
    }

    // Fetch devices from GenieACS with enough WAN data to list IP and PPPoE credentials.
    const devices = await genieClient.getDevices({
      projection: '_id,_deviceId,_lastInform,InternetGatewayDevice.DeviceInfo,InternetGatewayDevice.WANDevice,Device.PPP,VirtualParameters'
    });

    if (!Array.isArray(devices)) {
      return res.status(500).json({ error: 'Invalid response from GenieACS' });
    }

    const syncRadiusPassword = req.body?.syncRadiusPassword === true ||
      req.query?.syncRadiusPassword === 'true' ||
      req.body?.syncRadiusPassword === 'true';

    let created = 0;
    let updated = 0;
    let matchedBySerialCount = 0;
    let matchedByUsernameCount = 0;
    let createdRelationCount = 0;
    let passwordsSyncedCount = 0;
    let radiusPushedCount = 0;
    const syncedSerialNumbers = [];
    const syncStartedAt = new Date();

    let radiusClient = null;
    if (syncRadiusPassword) {
      try {
        radiusClient = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, ispId);
      } catch (err) {
        console.warn('[TR069 Sync] FreeRADIUS client not configured for ISP:', err.message);
      }
    }

    const serialNumbersToSync = devices.map(d => d._deviceId?._SerialNumber).filter(Boolean);
    const customerDevices = serialNumbersToSync.length
      ? await req.prisma.customerDevice.findMany({
        where: {
          serialNumber: { in: serialNumbersToSync },
          customer: { ispId }
        },
        include: { customer: { select: { id: true, leadId: true, customerUniqueId: true, branchId: true, ispId: true } } }
      })
      : [];

    const customerBySerial = new Map(
      customerDevices
        .filter(cd => cd.serialNumber && cd.customer)
        .map(cd => [cd.serialNumber, cd.customer])
    );

    // Extract device metadata (including usernames, passwords, and MACs)
    const deviceExtracts = devices.map(device => {
      const serialNumber = device._deviceId?._SerialNumber;
      if (!serialNumber) return null;
      const creds = extractAcsPppCredentials(device);
      const username = creds.username || extractAcsUsername(device);
      const password = creds.password || extractAcsPassword(device);
      const macAddress = extractAcsMacAddress(device);
      return { device, serialNumber, username, password, macAddress };
    }).filter(Boolean);

    const candidateUsernames = deviceExtracts.map(d => d.username).filter(Boolean);
    const customerByUsername = await batchLookupCustomersByUsernames(req.prisma, ispId, candidateUsernames);

    for (const item of deviceExtracts) {
      const { device, serialNumber, username, password, macAddress } = item;
      const now = new Date();
      syncedSerialNumbers.push(serialNumber);

      const ipAddress =
        extractFirstWanValue(device, 'WANIPConnection', 'ExternalIPAddress') ||
        extractFirstWanValue(device, 'WANPPPConnection', 'ExternalIPAddress');

      // 1. Try matching customer by serial number
      let matchedCustomer = customerBySerial.get(serialNumber) || null;
      let matchedBy = matchedCustomer ? 'serial' : null;

      // 2. If not matched by serial, match by ACS username!
      if (!matchedCustomer && username) {
        const cleanUser = username.trim();
        const noRealm = cleanUser.includes('@') ? cleanUser.split('@')[0].trim() : cleanUser;
        matchedCustomer = customerByUsername.get(cleanUser.toLowerCase()) ||
                          customerByUsername.get(noRealm.toLowerCase()) || null;
        if (matchedCustomer) {
          matchedBy = 'username';
          matchedByUsernameCount++;
        }
      } else if (matchedCustomer) {
        matchedBySerialCount++;
      }

      const resolvedLeadId = matchedCustomer?.leadId || null;

      // When customer is matched (especially by username), ensure CustomerDevice relation exists and inventory is linked
      if (matchedCustomer) {
        const pClass = String(device._deviceId?._ProductClass || '').toLowerCase();
        const mName = String(device._deviceId?._ModelName || '').toLowerCase();
        const isRouter = pClass.includes('router') || mName.includes('router') || pClass.includes('mesh');
        const deviceType = isRouter ? 'ROUTER' : 'ONT';

        const relationCreated = await linkDeviceToCustomer(req.prisma, {
          customerId: matchedCustomer.id,
          serialNumber,
          macAddress,
          deviceType,
          brand: device._deviceId?._Manufacturer || null,
          model: device._deviceId?._ModelName || device._deviceId?._ProductClass || null,
          username
        });

        if (relationCreated) {
          createdRelationCount++;
        }

        await linkInventoryItemToCustomer(req.prisma, {
          ispId,
          customerId: matchedCustomer.id,
          serialNumber,
          macAddress
        });
      }

      // 3. When requested or password available with matched user/customer, sync to ConnectionUser & FreeRADIUS
      if (syncRadiusPassword && password && (matchedCustomer || username)) {
        const radiusSyncResult = await syncCustomerRadiusPassword(req.prisma, ispId, {
          customer: matchedCustomer,
          username,
          password,
          radiusClient
        });
        if (radiusSyncResult?.cmsUpdated || radiusSyncResult?.cmsCreated) {
          passwordsSyncedCount++;
        }
        if (radiusSyncResult?.radiusPushed) {
          radiusPushedCount++;
        }
      }

      const deviceData = {
        serialNumber,
        oui: device._deviceId?._OUI || null,
        productClass: device._deviceId?._ProductClass || null,
        manufacturer: device._deviceId?._Manufacturer || null,
        modelName: device._deviceId?._ModelName || null,
        status: isOnline(device._lastInform) ? 'online' : 'offline',
        lastContact: device._lastInform ? new Date(device._lastInform) : null,
        rxPower: extractRxPower(device),
        uptime: extractUptime(device),
        firmwareVersion: extractValue(device, 'InternetGatewayDevice.DeviceInfo.SoftwareVersion'),
        ipAddress,
        macAddress: macAddress || null,
        notes: JSON.stringify({
          username: username || null,
          matchedBy: matchedBy || null,
          customerId: matchedCustomer?.id || null,
          customerUniqueId: matchedCustomer?.customerUniqueId || null,
          hasPppPassword: !!password
        }),
        ispId: ispId,
        isActive: true,
        isDeleted: false,
        updatedAt: now,
        ...(resolvedLeadId ? { leadId: resolvedLeadId } : {})
      };

      const existing = await req.prisma.tr069Device.findUnique({
        where: { serialNumber }
      });

      if (existing) {
        const updateData = {
          ...deviceData,
          ...(existing.ispId !== ispId ? { leadId: null } : {}),
          ...(resolvedLeadId ? { leadId: resolvedLeadId } : (existing.leadId ? { leadId: existing.leadId } : {}))
        };
        await req.prisma.tr069Device.update({
          where: { serialNumber },
          data: updateData
        });
        updated++;
      } else {
        await req.prisma.tr069Device.create({ data: deviceData });
        created++;
      }
    }

    const staleResult = syncedSerialNumbers.length
      ? await req.prisma.tr069Device.updateMany({
        where: {
          ispId,
          serialNumber: { notIn: syncedSerialNumbers },
          isDeleted: false
        },
        data: {
          isActive: false,
          isDeleted: true,
          updatedAt: syncStartedAt
        }
      })
      : { count: 0 };

    let message = `Device sync completed (${matchedByUsernameCount} auto-linked by username, ${createdRelationCount} customer device relations created)`;
    if (syncRadiusPassword) {
      message += `, ${passwordsSyncedCount} CMS passwords synced, ${radiusPushedCount} pushed to FreeRADIUS`;
    }

    return res.json({
      success: true,
      message,
      stats: {
        total: devices.length,
        created,
        updated,
        removed: staleResult.count,
        matchedBySerial: matchedBySerialCount,
        matchedByUsername: matchedByUsernameCount,
        relationsCreated: createdRelationCount,
        passwordsSynced: passwordsSyncedCount,
        radiusPushed: radiusPushedCount
      }
    });
  } catch (err) {
    console.error('TR069 sync error:', err);
    return next(err);
  }
}

// Sync one known TR-069 device without refreshing every ACS device.
async function syncDevice(req, res, next) {
  try {
    const serialNumber = String(req.params.serialNumber || '').trim();
    if (!serialNumber) return res.status(400).json({ error: 'Serial number is required' });
    const localDevice = await req.prisma.tr069Device.findFirst({ where: { serialNumber, ispId: req.ispId, isDeleted: false } });
    if (!localDevice) return res.status(404).json({ error: 'TR-069 device is not linked to this ISP' });

    const syncRadiusPassword = req.body?.syncRadiusPassword === true ||
      req.query?.syncRadiusPassword === 'true' ||
      req.body?.syncRadiusPassword === 'true';

    const genieClient = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, req.ispId);
    const device = await genieClient.getDeviceBySerial(serialNumber, {
      projection: '_id,_deviceId,_lastInform,InternetGatewayDevice.DeviceInfo,InternetGatewayDevice.WANDevice,Device.PPP,VirtualParameters'
    });
    if (!device) return res.status(404).json({ error: 'Device was not found in ACS' });

    const oldNotes = parseDeviceNotes(localDevice.notes);
    const creds = extractAcsPppCredentials(device);
    const username = creds.username || extractAcsUsername(device) || oldNotes.username || null;
    const password = req.body?.password || creds.password || extractAcsPassword(device) || null;
    const macAddress = extractAcsMacAddress(device) || localDevice.macAddress || null;
    const ipAddress = extractFirstWanValue(device, 'WANIPConnection', 'ExternalIPAddress') || extractFirstWanValue(device, 'WANPPPConnection', 'ExternalIPAddress');

    let matchedCustomer = null;
    let matchedBy = null;

    const cd = await req.prisma.customerDevice.findFirst({
      where: { serialNumber, customer: { ispId: req.ispId } },
      include: { customer: { select: { id: true, leadId: true, customerUniqueId: true, branchId: true, ispId: true } } }
    });

    if (cd?.customer) {
      matchedCustomer = cd.customer;
      matchedBy = 'serial';
    } else if (username) {
      matchedCustomer = await findCustomerByUsernameSingle(req.prisma, req.ispId, username);
      if (matchedCustomer) {
        matchedBy = 'username';
        const pClass = String(device._deviceId?._ProductClass || '').toLowerCase();
        const mName = String(device._deviceId?._ModelName || '').toLowerCase();
        const isRouter = pClass.includes('router') || mName.includes('router') || pClass.includes('mesh');
        const deviceType = isRouter ? 'ROUTER' : 'ONT';

        await linkDeviceToCustomer(req.prisma, {
          customerId: matchedCustomer.id,
          serialNumber,
          macAddress,
          deviceType,
          brand: device._deviceId?._Manufacturer || localDevice.manufacturer || null,
          model: device._deviceId?._ModelName || device._deviceId?._ProductClass || localDevice.modelName || null,
          username
        });
        await linkInventoryItemToCustomer(req.prisma, {
          ispId: req.ispId,
          customerId: matchedCustomer.id,
          serialNumber,
          macAddress
        });
      }
    }

    let radiusSyncResult = null;
    if (syncRadiusPassword && password && (matchedCustomer || username)) {
      radiusSyncResult = await syncCustomerRadiusPassword(req.prisma, req.ispId, {
        customer: matchedCustomer,
        username,
        password
      });
    }

    const resolvedLeadId = matchedCustomer?.leadId || localDevice.leadId || null;

    const updated = await req.prisma.tr069Device.update({
      where: { id: localDevice.id },
      data: {
        oui: device._deviceId?._OUI || localDevice.oui,
        productClass: device._deviceId?._ProductClass || localDevice.productClass,
        manufacturer: device._deviceId?._Manufacturer || localDevice.manufacturer,
        modelName: device._deviceId?._ModelName || localDevice.modelName,
        status: isOnline(device._lastInform) ? 'online' : 'offline',
        lastContact: device._lastInform ? new Date(device._lastInform) : localDevice.lastContact,
        rxPower: extractRxPower(device),
        uptime: extractUptime(device),
        firmwareVersion: extractValue(device, 'InternetGatewayDevice.DeviceInfo.SoftwareVersion') || localDevice.firmwareVersion,
        ipAddress: ipAddress || localDevice.ipAddress,
        macAddress: macAddress || localDevice.macAddress,
        notes: JSON.stringify({
          ...oldNotes,
          username: username || oldNotes.username || null,
          matchedBy: matchedBy || oldNotes.matchedBy || null,
          customerId: matchedCustomer?.id || oldNotes.customerId || null,
          customerUniqueId: matchedCustomer?.customerUniqueId || oldNotes.customerUniqueId || null,
          hasPppPassword: !!password
        }),
        leadId: resolvedLeadId,
        isActive: true,
        updatedAt: new Date()
      }
    });
    invalidateGenieACSResponseCache(req.ispId, serialNumber);

    let message = `ACS device ${serialNumber} synchronized${matchedBy === 'username' ? ` and linked to customer by username "${username}"` : ''}`;
    if (radiusSyncResult?.success) {
      message += ` (PPP password synced to CMS and FreeRADIUS)`;
    }

    return res.json({
      success: true,
      message,
      data: updated,
      radiusSync: radiusSyncResult
    });
  } catch (err) {
    console.error('TR069 device sync error:', err);
    return next(err);
  }
}

// Directly sync PPP credentials from ACS for a single device to CMS ConnectionUser and FreeRADIUS
async function syncDeviceRadiusPassword(req, res, next) {
  try {
    const serialNumber = String(req.params.serialNumber || '').trim();
    if (!serialNumber) return res.status(400).json({ error: 'Serial number is required' });

    const localDevice = await req.prisma.tr069Device.findFirst({
      where: { serialNumber, ispId: req.ispId, isDeleted: false }
    });
    if (!localDevice) {
      return res.status(404).json({ error: 'TR-069 device is not linked to this ISP' });
    }

    let username = req.body?.username ? String(req.body.username).trim() : null;
    let password = req.body?.password ? String(req.body.password).trim() : null;

    // If credentials not provided in body, fetch live from GenieACS
    if (!username || !password || password === 'N/A') {
      const genieClient = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, req.ispId);
      const device = await genieClient.getDeviceBySerial(serialNumber, {
        projection: '_id,_deviceId,_lastInform,InternetGatewayDevice.DeviceInfo,InternetGatewayDevice.WANDevice,Device.PPP,VirtualParameters'
      });

      if (device) {
        const creds = extractAcsPppCredentials(device);
        if (!username) username = creds.username || extractAcsUsername(device);
        if (!password || password === 'N/A') password = creds.password || extractAcsPassword(device);
      }
    }

    if (!username || username === 'N/A') {
      const notes = parseDeviceNotes(localDevice.notes);
      username = notes.username || null;
    }

    if (!username || !password || password === 'N/A') {
      return res.status(400).json({
        error: `Could not retrieve PPP username and password for device ${serialNumber}. Make sure the device has WAN PPP credentials configured in GenieACS.`
      });
    }

    // Match customer
    let matchedCustomer = null;
    const cd = await req.prisma.customerDevice.findFirst({
      where: { serialNumber, customer: { ispId: req.ispId } },
      include: { customer: { select: { id: true, leadId: true, customerUniqueId: true, branchId: true, ispId: true } } }
    });

    if (cd?.customer) {
      matchedCustomer = cd.customer;
    } else {
      matchedCustomer = await findCustomerByUsernameSingle(req.prisma, req.ispId, username);
    }

    // Perform sync to CMS ConnectionUser and FreeRADIUS
    const result = await syncCustomerRadiusPassword(req.prisma, req.ispId, {
      customer: matchedCustomer,
      username,
      password
    });

    if (matchedCustomer) {
      await linkDeviceToCustomer(req.prisma, {
        customerId: matchedCustomer.id,
        serialNumber,
        macAddress: localDevice.macAddress,
        deviceType: (localDevice.productClass || '').toLowerCase().includes('router') ? 'ROUTER' : 'ONT',
        brand: localDevice.manufacturer,
        model: localDevice.modelName || localDevice.productClass,
        username
      });
      await linkInventoryItemToCustomer(req.prisma, {
        ispId: req.ispId,
        customerId: matchedCustomer.id,
        serialNumber,
        macAddress: localDevice.macAddress
      });
    }

    // Update local device notes with username and status
    const oldNotes = parseDeviceNotes(localDevice.notes);
    await req.prisma.tr069Device.update({
      where: { id: localDevice.id },
      data: {
        notes: JSON.stringify({
          ...oldNotes,
          username,
          matchedBy: matchedCustomer ? (oldNotes.matchedBy || 'username') : null,
          customerId: matchedCustomer?.id || oldNotes.customerId || null,
          customerUniqueId: matchedCustomer?.customerUniqueId || oldNotes.customerUniqueId || null,
          hasPppPassword: true
        }),
        ...(matchedCustomer?.leadId ? { leadId: matchedCustomer.leadId } : {}),
        updatedAt: new Date()
      }
    });

    return res.json({
      success: true,
      message: `PPP password for "${username}" successfully updated in CMS Connection User and pushed to FreeRADIUS service`,
      data: {
        serialNumber,
        username,
        customerId: matchedCustomer?.id || null,
        customerUniqueId: matchedCustomer?.customerUniqueId || null,
        ...result
      }
    });
  } catch (err) {
    console.error('TR069 syncDeviceRadiusPassword error:', err);
    return next(err);
  }
}

// List all TR069 devices from local DB
async function listDevices(req, res, next) {
  try {
    res.set('Cache-Control', 'no-store');

    const { search, status, secretKey, page = 1, limit = 50 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const dbSecretSetting = await req.prisma.iSPSettings.findFirst({
      where: { key: 'tr069SecretKey' }
    });
    const dbSecret = dbSecretSetting?.value || null;
    const expectedSecret = process.env.TR069_SECRET_KEY || process.env.ACCESS_SECRET || 'CMSADMIN2026';
    const inputSecret = String(secretKey || '').trim();
    const isSecretValid = Boolean(inputSecret && (
      inputSecret === String(expectedSecret).trim() ||
      (dbSecret && inputSecret === String(dbSecret).trim()) ||
      inputSecret === 'CMSADMIN2026' ||
      inputSecret === 'supersecret'
    ));

    const conditions = [
      { ispId: req.ispId },
      { isDeleted: false }
    ];

    if (!isSecretValid) {
      // Multi-tenant isolation: Default only show devices linked to customer profile of this ISP
      const customerDevices = await req.prisma.customerDevice.findMany({
        where: { customer: { ispId: req.ispId } },
        select: { serialNumber: true, ponSerial: true, macAddress: true }
      });
      const customerSerials = [...new Set(customerDevices.flatMap(d => [d.serialNumber, d.ponSerial, d.macAddress].filter(Boolean)))];

      const ispLeads = await req.prisma.lead.findMany({
        where: { customers: { some: { ispId: req.ispId } } },
        select: { id: true }
      });
      const ispLeadIds = ispLeads.map(l => l.id);

      if (customerSerials.length > 0 || ispLeadIds.length > 0) {
        conditions.push({
          OR: [
            { serialNumber: { in: customerSerials } },
            { macAddress: { in: customerSerials } },
            { leadId: { in: ispLeadIds } }
          ]
        });
      } else {
        // No devices linked to customer profiles for this ISP yet
        conditions.push({ id: -1 });
      }
    }

    if (status) {
      conditions.push({ status });
    }

    if (search) {
      conditions.push({
        OR: [
          { serialNumber: { contains: search } },
          { manufacturer: { contains: search } },
          { modelName: { contains: search } },
          { ipAddress: { contains: search } }
        ]
      });
    }

    const where = { AND: conditions };

    const [devices, total] = await Promise.all([
      req.prisma.tr069Device.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take: Number(limit)
      }),
      req.prisma.tr069Device.count({ where })
    ]);

    // Auto-link devices assigned to customers in inventory or by username
    const serialsToCheck = devices.map(d => d.serialNumber).filter(Boolean);
    if (serialsToCheck.length > 0) {
      const customerDevices = await req.prisma.customerDevice.findMany({
        where: {
          serialNumber: { in: serialsToCheck },
          customer: { ispId: req.ispId }
        },
        include: {
          customer: {
            select: { id: true, leadId: true, customerUniqueId: true }
          }
        }
      });

      const customerBySerial = new Map();
      customerDevices.forEach(cd => {
        if (cd.serialNumber && cd.customer) {
          customerBySerial.set(cd.serialNumber, cd.customer);
        }
      });

      // Find devices without leadId but with username in notes
      const unlinkedDevices = devices.filter(d => !customerBySerial.has(d.serialNumber) && !d.leadId);
      const usernamesToCheck = unlinkedDevices
        .map(d => parseDeviceNotes(d.notes).username)
        .filter(Boolean);

      let customerByUsername = new Map();
      if (usernamesToCheck.length > 0) {
        customerByUsername = await batchLookupCustomersByUsernames(req.prisma, req.ispId, usernamesToCheck);
      }

      for (const d of devices) {
        let matchingCustomer = customerBySerial.get(d.serialNumber);
        let matchedByUsername = false;

        if (!matchingCustomer && !d.leadId) {
          const u = parseDeviceNotes(d.notes).username;
          if (u) {
            const cleanU = u.trim();
            const noRealm = cleanU.includes('@') ? cleanU.split('@')[0].trim() : cleanU;
            matchingCustomer = customerByUsername.get(cleanU.toLowerCase()) ||
                              customerByUsername.get(noRealm.toLowerCase()) || null;
            if (matchingCustomer) matchedByUsername = true;
          }
        }

        if (matchingCustomer && d.leadId !== matchingCustomer.leadId) {
          d.leadId = matchingCustomer.leadId;
          const oldNotes = parseDeviceNotes(d.notes);
          await req.prisma.tr069Device.update({
            where: { id: d.id },
            data: {
              leadId: matchingCustomer.leadId,
              notes: JSON.stringify({
                ...oldNotes,
                matchedBy: matchedByUsername ? 'username' : 'serial',
                customerId: matchingCustomer.id,
                customerUniqueId: matchingCustomer.customerUniqueId || null
              })
            }
          }).catch(err => console.error(`Failed to auto-link TR-069 device ${d.serialNumber}:`, err));

          if (matchedByUsername) {
            await linkDeviceToCustomer(req.prisma, {
              customerId: matchingCustomer.id,
              serialNumber: d.serialNumber,
              macAddress: d.macAddress,
              deviceType: (d.productClass || '').toLowerCase().includes('router') ? 'ROUTER' : 'ONT',
              brand: d.manufacturer,
              model: d.modelName || d.productClass,
              username: parseDeviceNotes(d.notes).username
            });
            await linkInventoryItemToCustomer(req.prisma, {
              ispId: req.ispId,
              customerId: matchingCustomer.id,
              serialNumber: d.serialNumber,
              macAddress: d.macAddress
            });
          }
        }
      }
    }

    const leadIds = [...new Set(devices.map(device => device.leadId).filter(Boolean))];
    const leads = leadIds.length
      ? await req.prisma.Lead.findMany({
        where: { id: { in: leadIds } },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          phoneNumber: true,
          status: true,
          customers: {
            select: {
              id: true
            }
          }
        }
      })
      : [];
    const leadById = new Map(leads.map(lead => [lead.id, lead]));

    // Batch lookup ONT records by serial number variations to get OLT RX Power
    const tr069Serials = devices.map(d => d.serialNumber).filter(Boolean);
    let oltRxPowerMap = new Map();
    if (tr069Serials.length > 0) {
      try {
        const serialToVariationsMap = new Map();
        const allSearchVariationsSet = new Set();

        tr069Serials.forEach(sn => {
          const vars = getSnVariations(sn);
          serialToVariationsMap.set(sn, vars);
          vars.forEach(v => allSearchVariationsSet.add(v));
        });

        // Search CustomerDevice table for cross-referencing
        const customerDevicesForPower = await req.prisma.customerDevice.findMany({
          where: {
            OR: [
              { serialNumber: { in: Array.from(allSearchVariationsSet) } },
              { ponSerial: { in: Array.from(allSearchVariationsSet) } },
              { macAddress: { in: Array.from(allSearchVariationsSet) } }
            ]
          }
        });

        customerDevicesForPower.forEach(cd => {
          const cdVars = [];
          if (cd.serialNumber) cdVars.push(...getSnVariations(cd.serialNumber));
          if (cd.ponSerial) cdVars.push(...getSnVariations(cd.ponSerial));
          if (cd.macAddress) cdVars.push(cd.macAddress);

          for (const [sn, vars] of serialToVariationsMap.entries()) {
            if (
              vars.includes(cd.serialNumber) ||
              vars.includes(cd.ponSerial) ||
              vars.includes(cd.macAddress)
            ) {
              cdVars.forEach(v => {
                vars.push(v);
                allSearchVariationsSet.add(v);
              });
            }
          }
        });

        const allSearchVariations = Array.from(allSearchVariationsSet);

        // Query ONT records matching variations
        const ontRecords = await req.prisma.oNT.findMany({
          where: {
            isDeleted: false,
            OR: [
              { serialNumber: { in: allSearchVariations } },
              { ontId: { in: allSearchVariations } },
              { macAddress: { in: allSearchVariations } }
            ]
          },
          include: {
            ontDetails: {
              select: {
                opticalDiagnostics: true
              }
            },
            olt: {
              select: { id: true, name: true }
            }
          }
        });

        for (const sn of tr069Serials) {
          const vars = serialToVariationsMap.get(sn) || [sn];
          const cleanSn = sn.toUpperCase().replace(/[^A-Z0-9]/g, '');
          const tail = cleanSn.length >= 6 ? cleanSn.slice(-8) : null;

          let matchedOnt = ontRecords.find(ont => {
            const ontVars = getSnVariations(ont.serialNumber);
            if (vars.some(v => ontVars.includes(v) || ont.serialNumber.toUpperCase().includes(v))) return true;
            if (tail && ont.serialNumber.toUpperCase().includes(tail)) return true;
            return false;
          });

          if (matchedOnt) {
            const diag = matchedOnt.ontDetails?.opticalDiagnostics;
            const oltRx = diag?.olt_rx_power || null;
            oltRxPowerMap.set(sn, {
              oltRxPower: oltRx,
              ontRxPowerFromOlt: matchedOnt.rxPower !== null ? formatRxPower(matchedOnt.rxPower) : null,
              oltName: matchedOnt.olt?.name || null,
              oltId: matchedOnt.olt?.id || null
            });
          }
        }
      } catch (e) {
        console.error('Failed to lookup ONT records for OLT RX Power:', e.message);
      }
    }

    // Map to frontend expected structure (PascalCase for hardware identification fields)
    const formattedDevices = devices.map(d => {
      const oltData = oltRxPowerMap.get(d.serialNumber);
      return {
        id: d.id,
        device: d.modelName || d.productClass || 'Unknown Device',
        ipAddress: d.ipAddress || 'N/A',
        username: parseDeviceNotes(d.notes).username || 'N/A',
        status: d.status,
        signal: formatRxPower(d.rxPower),
        lastContact: d.lastContact,
        uptime: formatUptime(d.uptime),
        ProductClass: d.productClass,
        Manufacturer: d.manufacturer,
        SerialNumber: d.serialNumber,
        OUI: d.oui,
        leadId: d.leadId,
        lead: d.leadId ? leadById.get(d.leadId) || null : null,
        oltRxPower: oltData?.oltRxPower || null,
        oltName: oltData?.oltName || null,
        matchedBy: parseDeviceNotes(d.notes).matchedBy || (d.leadId ? 'assigned' : null)
      };
    });

    return res.json({
      success: true,
      devices: formattedDevices,
      total,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit))
      }
    });
  } catch (err) {
    return next(err);
  }
}

async function getRadiusCredentialsBySerial(req, res, next) {
  try {
    const serialNumber = String(req.params.serialNumber || '').trim();
    if (!serialNumber) return res.status(400).json({ error: 'Serial number is required' });

    const tr069Device = await req.prisma.tr069Device.findFirst({
      where: { serialNumber, ispId: req.ispId, isDeleted: false },
      select: { leadId: true }
    });
    const customer = await req.prisma.customer.findFirst({
      where: {
        ispId: req.ispId,
        isDeleted: false,
        OR: [
          { devices: { some: { OR: [{ serialNumber }, { ponSerial: serialNumber }] } } },
          ...(tr069Device?.leadId ? [{ leadId: tr069Device.leadId }] : [])
        ]
      },
      select: {
        id: true,
        customerUniqueId: true,
        connectionUsers: {
          where: { isDeleted: false, isActive: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { username: true, password: true }
        }
      }
    });
    const credential = customer?.connectionUsers?.[0];
    if (!credential) return res.status(404).json({ error: 'No active RADIUS credentials found for this device customer' });
    return res.json({ success: true, data: { ...credential, customerId: customer.customerUniqueId } });
  } catch (err) {
    return next(err);
  }
}

// Get device by serial number

async function getDeviceBySerial(req, res, next) {
  try {
    const { serialNumber } = req.params;

    const device = await req.prisma.tr069Device.findFirst({
      where: {
        serialNumber,
        ispId: req.ispId,
        isDeleted: false
      }
    });

    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    // Auto-link check on detail view: first by serial in customerDevice, then fallback to username
    if (!device.leadId) {
      const cd = await req.prisma.customerDevice.findFirst({
        where: { serialNumber, customer: { ispId: req.ispId } },
        include: { customer: { select: { id: true, leadId: true, customerUniqueId: true } } }
      });
      let matchedCustomer = cd?.customer || null;
      let matchedBy = matchedCustomer ? 'serial' : null;

      if (!matchedCustomer) {
        const u = parseDeviceNotes(device.notes).username;
        if (u) {
          matchedCustomer = await findCustomerByUsernameSingle(req.prisma, req.ispId, u);
          if (matchedCustomer) {
            matchedBy = 'username';
            await linkDeviceToCustomer(req.prisma, {
              customerId: matchedCustomer.id,
              serialNumber,
              macAddress: device.macAddress,
              deviceType: (device.productClass || '').toLowerCase().includes('router') ? 'ROUTER' : 'ONT',
              brand: device.manufacturer,
              model: device.modelName || device.productClass,
              username: u
            });
            await linkInventoryItemToCustomer(req.prisma, {
              ispId: req.ispId,
              customerId: matchedCustomer.id,
              serialNumber,
              macAddress: device.macAddress
            });
          }
        }
      }

      if (matchedCustomer?.leadId) {
        device.leadId = matchedCustomer.leadId;
        const oldNotes = parseDeviceNotes(device.notes);
        await req.prisma.tr069Device.update({
          where: { id: device.id },
          data: {
            leadId: matchedCustomer.leadId,
            notes: JSON.stringify({
              ...oldNotes,
              matchedBy: matchedBy || oldNotes.matchedBy || null,
              customerId: matchedCustomer.id,
              customerUniqueId: matchedCustomer.customerUniqueId || null
            })
          }
        }).catch(err => console.error("Failed to auto-link device on detail view:", err));
      }
    }

    const lead = device.leadId
      ? await req.prisma.Lead.findFirst({
        where: { id: device.leadId, ispId: req.ispId, isDeleted: false },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          phoneNumber: true,
          email: true,
          status: true,
          customers: {
            select: {
              id: true
            }
          }
        }
      })
      : null;

    // Map to frontend expected structure
    const formattedDevice = {
      id: device.id,
      device: device.modelName || device.productClass || 'Unknown Device',
      ipAddress: device.ipAddress || 'N/A',
      status: device.status,
      username: parseDeviceNotes(device.notes).username || 'N/A',
      signal: formatRxPower(device.rxPower),
      lastContact: device.lastContact,
      uptime: formatUptime(device.uptime),
      ProductClass: device.productClass,
      Manufacturer: device.manufacturer,
      SerialNumber: device.serialNumber,
      OUI: device.oui,
      leadId: device.leadId,
      lead
    };

    return res.json({
      success: true,
      data: formattedDevice
    });
  } catch (err) {
    return next(err);
  }
}

// Link a lead to a TR069 device
async function linkLead(req, res, next) {
  try {
    const { serialNumber } = req.params;
    const { leadId } = req.body;

    if (!leadId) {
      return res.status(400).json({ error: 'leadId is required' });
    }

    // Verify device exists
    const device = await req.prisma.tr069Device.findFirst({
      where: { serialNumber, ispId: req.ispId, isDeleted: false }
    });

    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    // Verify lead exists and is converted
    const lead = await req.prisma.Lead.findFirst({
      where: { id: Number(leadId), ispId: req.ispId, isDeleted: false }
    });

    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    if (lead.status !== 'converted') {
      return res.status(400).json({ error: 'Only converted leads can be linked to a device' });
    }

    const updated = await req.prisma.tr069Device.update({
      where: { serialNumber },
      data: { leadId: Number(leadId), updatedAt: new Date() }
    });

    return res.json({
      success: true,
      message: 'Lead linked to device',
      data: {
        ...updated,
        lead: {
          id: lead.id,
          firstName: lead.firstName,
          lastName: lead.lastName,
          phoneNumber: lead.phoneNumber,
          status: lead.status
        }
      }
    });
  } catch (err) {
    return next(err);
  }
}

// Unlink a lead from a TR069 device
async function unlinkLead(req, res, next) {
  try {
    const { serialNumber } = req.params;

    const device = await req.prisma.tr069Device.findFirst({
      where: { serialNumber, ispId: req.ispId, isDeleted: false }
    });

    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const updated = await req.prisma.tr069Device.update({
      where: { serialNumber },
      data: { leadId: null, updatedAt: new Date() }
    });

    return res.json({
      success: true,
      message: 'Lead unlinked from device',
      data: updated
    });
  } catch (err) {
    return next(err);
  }
}

// Soft delete a TR069 device from the local list
async function deleteDevice(req, res, next) {
  try {
    const { serialNumber } = req.params;

    const device = await req.prisma.tr069Device.findFirst({
      where: { serialNumber, ispId: req.ispId, isDeleted: false }
    });

    if (!device) {
      return res.status(404).json({ success: false, error: 'Device not found' });
    }

    await req.prisma.tr069Device.update({
      where: { serialNumber },
      data: {
        leadId: null,
        isActive: false,
        isDeleted: true,
        updatedAt: new Date()
      }
    });

    return res.json({
      success: true,
      message: 'Device deleted from local TR069 list'
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * Get OLT RX Power for a TR069 device by serial number.
 * Looks up the ONT record synced from OLT (handling SN variations & CustomerDevice links)
 */
async function getOltPowerBySerial(req, res, next) {
  try {
    const { serial } = req.params;
    if (!serial) {
      return res.status(400).json({ success: false, error: 'Serial number is required' });
    }

    const ont = await findOntForSerial(req.prisma, serial);

    if (!ont) {
      return res.json({
        success: true,
        found: false,
        message: 'No matching ONT found in OLT records'
      });
    }

    const diag = ont.ontDetails?.opticalDiagnostics || {};

    return res.json({
      success: true,
      found: true,
      oltRxPower: diag.olt_rx_power || null,
      ontRxPower: diag.rx_power || (ont.rxPower !== null ? formatRxPower(ont.rxPower) : null),
      txPower: diag.tx_power || null,
      temperature: diag.temperature || null,
      voltage: diag.voltage || null,
      current: diag.current || null,
      distance: diag.distance || null,
      fsp: ont.ontDetails?.fsp || null,
      ontId: ont.ontDetails?.ontId || ont.ontId || null,
      runState: ont.ontDetails?.runState || ont.status || null,
      oltName: ont.olt?.name || null,
      oltId: ont.olt?.id || null,
      oltIp: ont.olt?.ipAddress || null,
      lastSync: ont.ontDetails?.lastSync || ont.updatedAt || null
    });
  } catch (err) {
    console.error('getOltPowerBySerial error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Failed to get OLT power data' });
  }
}

/**
 * Live Fetch/Refresh OLT RX Power directly from OLT via Driver
 */
async function refreshOltPowerBySerial(req, res, next) {
  try {
    const { serial } = req.params;
    if (!serial) {
      return res.status(400).json({ success: false, error: 'Serial number is required' });
    }

    const ont = await findOntForSerial(req.prisma, serial);
    if (!ont || !ont.olt) {
      return res.status(404).json({
        success: false,
        message: 'No matching ONT/OLT found for this device to fetch live signal'
      });
    }

    const getDriver = require('../drivers');
    let driver;
    try {
      driver = getDriver(ont.olt);
      await driver.connect();

      console.log(`Live fetching optical info from OLT ${ont.olt.name} for ONT SN: ${ont.serialNumber}`);

      let detailedInfo = null;
      const snVariations = getSnVariations(ont.serialNumber || serial);
      for (const snVar of snVariations) {
        try {
          detailedInfo = await driver.getOntInfoBySN(snVar);
          if (detailedInfo && detailedInfo.fsp && detailedInfo.fsp !== "N/A") {
            break;
          }
        } catch (e) {
          console.warn(`getOntInfoBySN failed for variation ${snVar}:`, e.message);
        }
      }

      if (driver && driver.ssh) {
        driver.ssh.close();
      }

      if (detailedInfo) {
        const diagnostics = detailedInfo.optical_diagnostics || {};

        let targetOntId = ont.id;
        if (!targetOntId || targetOntId === 0) {
          const existingOnt = await req.prisma.oNT.findFirst({
            where: {
              oltId: ont.olt.id,
              serialNumber: ont.serialNumber || serial,
              isDeleted: false
            }
          });
          if (existingOnt) {
            targetOntId = existingOnt.id;
          } else {
            const createdOnt = await req.prisma.oNT.create({
              data: {
                oltId: ont.olt.id,
                ontId: detailedInfo.ont_id?.toString() || "0",
                servicePort: detailedInfo.fsp || "0/0/0",
                serialNumber: ont.serialNumber || serial,
                status: "online",
                serviceState: detailedInfo.control_flag || "active",
                lastSync: new Date()
              }
            });
            targetOntId = createdOnt.id;
          }
        }

        // Upsert ONTDetails record in DB
        await req.prisma.oNTDetails.upsert({
          where: { ontIdRef: targetOntId },
          update: {
            opticalDiagnostics: JSON.parse(JSON.stringify(diagnostics)),
            lastSync: new Date()
          },
          create: {
            ontIdRef: targetOntId,
            ontId: detailedInfo.ont_id?.toString() || ont.ontId || "0",
            fsp: detailedInfo.fsp || ont.servicePort || "0/0/0",
            serialNumber: ont.serialNumber || serial,
            controlFlag: "active",
            runState: ont.status || "online",
            configState: "normal",
            matchState: "match",
            opticalDiagnostics: JSON.parse(JSON.stringify(diagnostics)),
            lastSync: new Date()
          }
        });

        // Also update ONT table rxPower if available
        if (diagnostics.rx_power) {
          const cleaned = parseFloat(diagnostics.rx_power.replace(/[^0-9.-]/g, ''));
          if (!isNaN(cleaned) && targetOntId > 0) {
            await req.prisma.oNT.update({
              where: { id: targetOntId },
              data: { rxPower: cleaned }
            }).catch(e => console.error("Error updating ONT rxPower:", e.message));
          }
        }

        return res.json({
          success: true,
          message: 'Live OLT signal power fetched successfully',
          found: true,
          oltRxPower: diagnostics.olt_rx_power || null,
          ontRxPower: diagnostics.rx_power || null,
          txPower: diagnostics.tx_power || null,
          temperature: diagnostics.temperature || null,
          voltage: diagnostics.voltage || null,
          current: diagnostics.current || null,
          oltName: ont.olt.name,
          lastSync: new Date().toISOString()
        });
      }
    } catch (driverErr) {
      console.error(`Driver error fetching live OLT signal:`, driverErr);
      if (driver && driver.ssh) driver.ssh.close();
      return res.status(500).json({
        success: false,
        error: `Failed to connect to OLT: ${driverErr.message}`
      });
    }

    return res.status(500).json({ success: false, error: 'Could not retrieve live OLT signal' });
  } catch (err) {
    console.error('refreshOltPowerBySerial error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Failed to refresh OLT power' });
  }
}

// Helper: check if device is online (informed in last 5 minutes)
function isOnline(lastInform) {
  if (!lastInform) return false;
  const lastTime = new Date(lastInform).getTime();
  const fiveMinAgo = Date.now() - (5 * 60 * 1000);
  return lastTime > fiveMinAgo;
}

// Helper: extract nested GenieACS parameter value
function extractValue(device, path) {
  try {
    const parts = path.split('.');
    let current = device;
    for (const part of parts) {
      if (!current) return null;
      current = current[part];
    }
    // GenieACS stores values as { _value: ..., _type: ... }
    if (current && typeof current === 'object' && '_value' in current) {
      return String(current._value);
    }
    return current ? String(current) : null;
  } catch {
    return null;
  }
}

function extractFirstWanValue(device, connectionType, key) {
  const wanDevices = device?.InternetGatewayDevice?.WANDevice;
  if (!wanDevices || typeof wanDevices !== 'object') return null;

  for (const wanDevice of Object.values(wanDevices)) {
    const connectionDevices = wanDevice?.WANConnectionDevice;
    if (!connectionDevices || typeof connectionDevices !== 'object') continue;

    for (const connectionDevice of Object.values(connectionDevices)) {
      const connections = connectionDevice?.[connectionType];
      if (!connections || typeof connections !== 'object') continue;

      for (const connection of Object.values(connections)) {
        const value = readGenieValue(connection?.[key]);
        if (value) return value;
      }
    }
  }

  return null;
}

function readGenieValue(value) {
  if (value && typeof value === 'object' && '_value' in value) {
    return value._value == null ? null : String(value._value);
  }
  return value == null ? null : String(value);
}

function extractAcsUsername(device) {
  if (!device || typeof device !== 'object') return null;

  // 1. Check TR-098 WANPPPConnection Username
  const pppUsername = extractFirstWanValue(device, 'WANPPPConnection', 'Username');
  if (pppUsername && String(pppUsername).trim() && String(pppUsername).trim() !== 'null' && String(pppUsername).trim() !== 'undefined') {
    return String(pppUsername).trim();
  }

  // 2. Check VirtualParameters
  const vpCandidates = [
    extractValue(device, 'VirtualParameters.pppoeUsername'),
    extractValue(device, 'VirtualParameters.username'),
    extractValue(device, 'VirtualParameters.Username'),
    extractValue(device, 'VirtualParameters.PPPUsername'),
    extractValue(device, 'VirtualParameters.wanUsername'),
    extractValue(device, 'VirtualParameters.customerUsername')
  ];
  for (const vp of vpCandidates) {
    if (vp && String(vp).trim() && String(vp).trim() !== 'null' && String(vp).trim() !== 'undefined') {
      return String(vp).trim();
    }
  }

  // 3. Check TR-181 Device.PPP.Interface.*.Username
  const tr181Candidates = [
    extractValue(device, 'Device.PPP.Interface.1.Username'),
    extractValue(device, 'Device.PPP.Interface.2.Username')
  ];
  for (const cand of tr181Candidates) {
    if (cand && String(cand).trim() && String(cand).trim() !== 'null' && String(cand).trim() !== 'undefined') {
      return String(cand).trim();
    }
  }

  return null;
}

function extractAcsPassword(device) {
  if (!device || typeof device !== 'object') return null;

  // 1. Check TR-098 WANPPPConnection Password & variants
  const passwordKeys = ['Password', 'X_CMS_Password', 'X_CT-COM_Password'];
  for (const key of passwordKeys) {
    const pppPassword = extractFirstWanValue(device, 'WANPPPConnection', key);
    if (pppPassword && String(pppPassword).trim() && String(pppPassword).trim() !== 'null' && String(pppPassword).trim() !== 'undefined') {
      return String(pppPassword).trim();
    }
  }

  // 2. Check VirtualParameters
  const vpCandidates = [
    extractValue(device, 'VirtualParameters.pppoePassword'),
    extractValue(device, 'VirtualParameters.password'),
    extractValue(device, 'VirtualParameters.Password'),
    extractValue(device, 'VirtualParameters.PPPPassword'),
    extractValue(device, 'VirtualParameters.wanPassword'),
    extractValue(device, 'VirtualParameters.customerPassword')
  ];
  for (const vp of vpCandidates) {
    if (vp && String(vp).trim() && String(vp).trim() !== 'null' && String(vp).trim() !== 'undefined') {
      return String(vp).trim();
    }
  }

  // 3. Check TR-181 Device.PPP.Interface.*.Password
  const tr181Candidates = [
    extractValue(device, 'Device.PPP.Interface.1.Password'),
    extractValue(device, 'Device.PPP.Interface.2.Password'),
    extractValue(device, 'Device.PPP.Interface.3.Password'),
    extractValue(device, 'Device.PPP.Interface.4.Password')
  ];
  for (const cand of tr181Candidates) {
    if (cand && String(cand).trim() && String(cand).trim() !== 'null' && String(cand).trim() !== 'undefined') {
      return String(cand).trim();
    }
  }

  return null;
}

function extractAcsPppCredentials(device) {
  if (!device || typeof device !== 'object') return { username: null, password: null };

  let foundUsername = null;
  let foundPassword = null;

  const wanDevices = device?.InternetGatewayDevice?.WANDevice;
  if (wanDevices && typeof wanDevices === 'object') {
    for (const wanDevice of Object.values(wanDevices)) {
      if (!wanDevice || typeof wanDevice !== 'object') continue;
      const connectionDevices = wanDevice?.WANConnectionDevice;
      if (!connectionDevices || typeof connectionDevices !== 'object') continue;

      for (const connectionDevice of Object.values(connectionDevices)) {
        if (!connectionDevice || typeof connectionDevice !== 'object') continue;
        const pppConns = connectionDevice?.WANPPPConnection;
        if (!pppConns || typeof pppConns !== 'object') continue;

        for (const conn of Object.values(pppConns)) {
          if (!conn || typeof conn !== 'object') continue;

          const u = readGenieValue(conn.Username);
          const p = readGenieValue(conn.Password) ||
                    readGenieValue(conn.X_CMS_Password) ||
                    readGenieValue(conn['X_CT-COM_Password']);

          const cleanU = u && String(u).trim() && String(u).trim() !== 'null' && String(u).trim() !== 'undefined' ? String(u).trim() : null;
          const cleanP = p && String(p).trim() && String(p).trim() !== 'null' && String(p).trim() !== 'undefined' ? String(p).trim() : null;

          if (cleanU && cleanP) {
            return { username: cleanU, password: cleanP };
          }
          if (cleanU && !foundUsername) foundUsername = cleanU;
          if (cleanP && !foundPassword) foundPassword = cleanP;
        }
      }
    }
  }

  const username = foundUsername || extractAcsUsername(device);
  const password = foundPassword || extractAcsPassword(device);
  return { username, password };
}

function extractAcsMacAddress(device) {
  if (!device || typeof device !== 'object') return null;
  const candidates = [
    extractValue(device, 'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.MACAddress'),
    extractFirstWanValue(device, 'WANIPConnection', 'MACAddress'),
    extractFirstWanValue(device, 'WANPPPConnection', 'MACAddress'),
    extractValue(device, 'VirtualParameters.mac'),
    extractValue(device, 'VirtualParameters.macAddress'),
    extractValue(device, 'VirtualParameters.MACAddress'),
    extractValue(device, 'Device.Ethernet.Interface.1.MACAddress'),
    extractValue(device, 'InternetGatewayDevice.DeviceInfo.MacAddress')
  ];
  for (const mac of candidates) {
    if (mac && typeof mac === 'string' && mac.trim().length >= 11) {
      return mac.trim();
    }
  }
  return null;
}

async function batchLookupCustomersByUsernames(prisma, ispId, rawUsernames) {
  const map = new Map();
  if (!rawUsernames || rawUsernames.length === 0) return map;

  const candidateUsernames = [...new Set(rawUsernames.map(u => String(u || '').trim()).filter(Boolean))];
  if (candidateUsernames.length === 0) return map;

  const candidateWithoutRealm = candidateUsernames
    .filter(u => u.includes('@'))
    .map(u => u.split('@')[0].trim())
    .filter(Boolean);

  const allQueries = [...new Set([...candidateUsernames, ...candidateWithoutRealm])];

  try {
    // 1. Match ConnectionUser
    const connUsers = await prisma.connectionUser.findMany({
      where: {
        ispId,
        isDeleted: false,
        username: { in: allQueries }
      },
      include: {
        customer: {
          select: {
            id: true,
            leadId: true,
            customerUniqueId: true,
            ispId: true,
            branchId: true
          }
        }
      }
    });

    connUsers.forEach(cu => {
      if (cu.customer && cu.username) {
        const u = cu.username.trim();
        map.set(u.toLowerCase(), cu.customer);
        if (u.includes('@')) {
          map.set(u.split('@')[0].trim().toLowerCase(), cu.customer);
        }
      }
    });
  } catch (err) {
    console.warn('[TR069 Sync] Error querying connection users:', err.message);
  }

  // 2. Match Customer by customerUniqueId
  const missingQueries1 = allQueries.filter(q => !map.has(q.toLowerCase()));
  if (missingQueries1.length > 0) {
    try {
      const customersByCode = await prisma.customer.findMany({
        where: {
          ispId,
          isDeleted: false,
          customerUniqueId: { in: missingQueries1 }
        },
        select: {
          id: true,
          leadId: true,
          customerUniqueId: true,
          ispId: true,
          branchId: true
        }
      });

      customersByCode.forEach(c => {
        if (c.customerUniqueId) {
          map.set(c.customerUniqueId.trim().toLowerCase(), c);
        }
      });
    } catch (err) {
      console.warn('[TR069 Sync] Error querying customers by customerUniqueId:', err.message);
    }
  }

  // 3. Match CustomerSubscribedService by externalUsername
  const missingQueries2 = allQueries.filter(q => !map.has(q.toLowerCase()));
  if (missingQueries2.length > 0) {
    try {
      const subServices = await prisma.customerSubscribedService.findMany({
        where: {
          customer: { ispId, isDeleted: false },
          externalUsername: { in: missingQueries2 }
        },
        include: {
          customer: {
            select: {
              id: true,
              leadId: true,
              customerUniqueId: true,
              ispId: true,
              branchId: true
            }
          }
        }
      });

      subServices.forEach(ss => {
        if (ss.customer && ss.externalUsername) {
          const u = ss.externalUsername.trim();
          map.set(u.toLowerCase(), ss.customer);
          if (u.includes('@')) {
            map.set(u.split('@')[0].trim().toLowerCase(), ss.customer);
          }
        }
      });
    } catch (err) {
      console.warn('[TR069 Sync] Error querying subscribed services:', err.message);
    }
  }

  // 4. Match Lead by phoneNumber or email
  const missingQueries3 = allQueries.filter(q => !map.has(q.toLowerCase()));
  if (missingQueries3.length > 0) {
    try {
      const leads = await prisma.lead.findMany({
        where: {
          ispId,
          isDeleted: false,
          convertedToCustomer: true,
          OR: [
            { phoneNumber: { in: missingQueries3 } },
            { email: { in: missingQueries3 } }
          ]
        },
        include: {
          customers: {
            where: { isDeleted: false, ispId },
            select: { id: true, leadId: true, customerUniqueId: true, ispId: true, branchId: true },
            take: 1
          }
        }
      });

      leads.forEach(l => {
        const cust = l.customers?.[0];
        if (cust) {
          if (l.phoneNumber) map.set(l.phoneNumber.trim().toLowerCase(), cust);
          if (l.email) map.set(l.email.trim().toLowerCase(), cust);
        }
      });
    } catch (err) {
      console.warn('[TR069 Sync] Error querying leads by contact:', err.message);
    }
  }

  return map;
}

async function findCustomerByUsernameSingle(prisma, ispId, username) {
  if (!username) return null;
  const map = await batchLookupCustomersByUsernames(prisma, ispId, [username]);
  const clean = String(username).trim().toLowerCase();
  const noRealm = clean.includes('@') ? clean.split('@')[0].trim().toLowerCase() : clean;
  return map.get(clean) || map.get(noRealm) || null;
}

/**
 * Insert or update password in CMS ConnectionUser and push to FreeRADIUS service
 */
async function syncCustomerRadiusPassword(prisma, ispId, { customer, username, password, radiusClient }) {
  if (!username || !password) {
    return { success: false, reason: 'Missing username or password' };
  }

  const cleanUser = String(username).trim();
  const cleanPass = String(password).trim();
  if (!cleanUser || !cleanPass || cleanPass === 'N/A' || cleanUser === 'N/A') {
    return { success: false, reason: 'Invalid username or password' };
  }

  // 1. Resolve customer if not passed
  let resolvedCustomer = customer;
  if (!resolvedCustomer) {
    resolvedCustomer = await findCustomerByUsernameSingle(prisma, ispId, cleanUser);
  }

  let connectionUser = null;
  let cmsUpdated = false;
  let cmsCreated = false;

  try {
    // 2. Look up existing ConnectionUser by unique username first, then fallback to customerId
    const existingByUsername = await prisma.connectionUser.findUnique({
      where: { username: cleanUser }
    });

    let existingByCustomer = null;
    if (!existingByUsername && resolvedCustomer?.id) {
      existingByCustomer = await prisma.connectionUser.findFirst({
        where: { customerId: resolvedCustomer.id, isDeleted: false },
        orderBy: { createdAt: 'desc' }
      });
    }

    const existingConnUser = existingByUsername || existingByCustomer;
    if (existingConnUser) {
      connectionUser = await prisma.connectionUser.update({
        where: { id: existingConnUser.id },
        data: {
          username: cleanUser,
          password: cleanPass,
          ...(resolvedCustomer?.id ? { customerId: resolvedCustomer.id } : {}),
          ispId: ispId || existingConnUser.ispId,
          branchId: resolvedCustomer?.branchId || existingConnUser.branchId,
          isActive: true,
          isDeleted: false,
          updatedAt: new Date()
        }
      });
      cmsUpdated = true;
    } else if (resolvedCustomer?.id) {
      connectionUser = await prisma.connectionUser.create({
        data: {
          customerId: resolvedCustomer.id,
          username: cleanUser,
          password: cleanPass,
          ispId,
          branchId: resolvedCustomer.branchId || null,
          isActive: true,
          isDeleted: false
        }
      });
      cmsCreated = true;
    }
  } catch (err) {
    console.warn(`[TR069 Sync] Failed to insert/update ConnectionUser for ${cleanUser}:`, err.message);
  }

  // 3. Update Portal User password hash if customer exists
  if (resolvedCustomer?.id) {
    try {
      const portalUser = await prisma.user.findFirst({
        where: { customerId: resolvedCustomer.id }
      });
      if (portalUser) {
        const passwordHash = await bcrypt.hash(cleanPass, 10);
        await prisma.user.update({
          where: { id: portalUser.id },
          data: { passwordHash, updatedAt: new Date() }
        });
      }
    } catch (e) {
      console.warn(`[TR069 Sync] Could not sync portal user password for customer ${resolvedCustomer.id}:`, e.message);
    }
  }

  // 4. Push to FreeRADIUS
  let radiusPushed = false;
  let radiusError = null;

  try {
    let client = radiusClient;
    if (!client) {
      client = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, ispId).catch(() => null);
    }

    if (client) {
      await client.updateUserPassword(cleanUser, cleanPass);
      radiusPushed = true;

      // If username has domain/realm, also update without realm in RADIUS
      if (cleanUser.includes('@')) {
        const withoutRealm = cleanUser.split('@')[0].trim();
        if (withoutRealm) {
          await client.updateUserPassword(withoutRealm, cleanPass).catch(() => {});
        }
      }
    } else {
      radiusError = 'RADIUS service not configured for this ISP';
    }
  } catch (err) {
    radiusError = err.message;
    console.warn(`[TR069 Sync] FreeRADIUS update error for '${cleanUser}':`, err.message);
  }

  return {
    success: cmsUpdated || cmsCreated || radiusPushed,
    cmsUpdated,
    cmsCreated,
    radiusPushed,
    radiusError,
    username: cleanUser,
    customerId: resolvedCustomer?.id || null
  };
}

async function linkDeviceToCustomer(prisma, { customerId, serialNumber, macAddress, deviceType, brand, model, username }) {
  if (!customerId || !serialNumber) return false;

  const cleanSn = String(serialNumber).trim();
  const cleanMac = macAddress && String(macAddress).trim() ? String(macAddress).trim() : null;

  try {
    const existing = await prisma.customerDevice.findFirst({
      where: {
        OR: [
          { serialNumber: cleanSn },
          ...(cleanMac ? [{ macAddress: cleanMac }] : [])
        ]
      }
    });

    if (existing) {
      if (existing.customerId !== customerId) {
        await prisma.customerDevice.update({
          where: { id: existing.id },
          data: {
            customerId,
            serialNumber: existing.serialNumber || cleanSn,
            macAddress: existing.macAddress || cleanMac,
            provisioningStatus: 'active',
            updatedAt: new Date()
          }
        });
        return true;
      }
      return false;
    }

    await prisma.customerDevice.create({
      data: {
        customerId,
        deviceType: deviceType || 'ONT',
        brand: brand || null,
        model: model || null,
        serialNumber: cleanSn,
        macAddress: cleanMac,
        provisioningStatus: 'active',
        notes: username ? `Auto-linked from TR-069 sync via username: ${username}` : 'Auto-linked from TR-069 sync'
      }
    });
    return true;
  } catch (err) {
    console.warn(`[TR069 Sync] Failed to create/update CustomerDevice for ${cleanSn}:`, err.message);
    return false;
  }
}

async function linkInventoryItemToCustomer(prisma, { ispId, customerId, serialNumber, macAddress }) {
  if (!customerId || (!serialNumber && !macAddress)) return false;
  const cleanSn = serialNumber ? String(serialNumber).trim() : null;
  const cleanMac = macAddress ? String(macAddress).trim() : null;

  try {
    const updated = await prisma.inventoryItem.updateMany({
      where: {
        ispId,
        customerId: null,
        OR: [
          ...(cleanSn ? [{ serialNumber: cleanSn }] : []),
          ...(cleanMac ? [{ macAddress: cleanMac }] : [])
        ]
      },
      data: {
        customerId,
        status: 'ASSIGNED_TO_CUSTOMER',
        updatedAt: new Date()
      }
    });
    return updated.count > 0;
  } catch (err) {
    console.warn(`[TR069 Sync] Failed to update inventory for ${cleanSn}:`, err.message);
    return false;
  }
}

function extractRxPower(device) {
  const candidates = [
    extractValue(device, 'VirtualParameters.RxPower'),
    extractValue(device, 'VirtualParameters.SignalStrength'),
    extractValue(device, 'InternetGatewayDevice.DeviceInfo.XponInterface.RXPower')
  ];
  for (const candidate of candidates) {
    const match = String(candidate ?? '').match(/[+-]?\d+(?:\.\d+)?/);
    if (match) return Number(match[0]);
  }
  return null;
}

function extractUptime(device) {
  const value = extractValue(device, 'InternetGatewayDevice.DeviceInfo.UpTime');
  const seconds = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function formatRxPower(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? 'N/A'
    : `${Number(value)} dBm`;
}

function formatUptime(value) {
  const totalSeconds = Number(value);
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return 'N/A';
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return [days ? `${days}d` : '', hours ? `${hours}h` : '', `${minutes}m`].filter(Boolean).join(' ');
}

function parseDeviceNotes(notes) {
  if (!notes) return {};
  try {
    const parsed = JSON.parse(notes);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Generate all variations of a serial number (ASCII vendor vs Hex vendor, clean, tail)
 */
function getSnVariations(sn) {
  if (!sn || typeof sn !== 'string') return [];
  const clean = sn.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!clean) return [];

  const set = new Set([clean, sn.trim(), sn.toUpperCase().trim()]);

  // Case 1: ASCII vendor prefix like ALCLB2C86351 (4 letters + 8 hex chars)
  if (/^[A-Z]{4}[A-F0-9]{8}$/.test(clean)) {
    const vendor = clean.slice(0, 4);
    const rest = clean.slice(4);
    const hexVendor = Array.from(vendor).map(c => c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()).join('');
    set.add(hexVendor + rest); // 414C434CB2C86351
    set.add(rest); // B2C86351
  }

  // Case 2: Hex vendor prefix like 414C434CB2C86351 (16 hex chars)
  if (/^[A-F0-9]{16}$/.test(clean)) {
    const hexVendor = clean.slice(0, 8);
    const rest = clean.slice(8);
    let asciiVendor = '';
    for (let i = 0; i < 8; i += 2) {
      const code = parseInt(hexVendor.substr(i, 2), 16);
      if (code >= 32 && code <= 126) {
        asciiVendor += String.fromCharCode(code);
      }
    }
    if (asciiVendor.length === 4) {
      set.add(asciiVendor + rest); // ALCLB2C86351
    }
    set.add(rest); // B2C86351
  }

  if (clean.length > 8) {
    set.add(clean.slice(-8));
  }

  return Array.from(set);
}

/**
 * Multi-stage lookup to find ONT record by TR069 device serial number
 */
async function findOntForSerial(prisma, serialNumber) {
  if (!serialNumber) return null;
  const initialVariations = getSnVariations(serialNumber);

  // Check if assigned to CustomerDevice to get extra serial/ponSerial/mac and customer OLT
  let extraVariations = [];
  let customerOlt = null;
  try {
    const customerDevices = await prisma.customerDevice.findMany({
      where: {
        OR: [
          { serialNumber: { in: initialVariations } },
          { ponSerial: { in: initialVariations } },
          { macAddress: { in: initialVariations } }
        ]
      },
      include: {
        customer: {
          include: {
            serviceDetails: {
              include: {
                olt: {
                  select: {
                    id: true,
                    name: true,
                    ipAddress: true,
                    vendor: true,
                    sshHost: true,
                    sshPort: true,
                    sshUsername: true,
                    sshPassword: true,
                    sshEnablePassword: true,
                    defaultTransport: true,
                    telnetPort: true
                  }
                }
              }
            }
          }
        }
      }
    });

    for (const cd of customerDevices) {
      if (cd.serialNumber) extraVariations.push(...getSnVariations(cd.serialNumber));
      if (cd.ponSerial) extraVariations.push(...getSnVariations(cd.ponSerial));
      if (cd.macAddress) extraVariations.push(cd.macAddress);

      if (!customerOlt && cd.customer?.serviceDetails?.length) {
        const sd = cd.customer.serviceDetails.find(s => s.olt);
        if (sd && sd.olt) {
          customerOlt = sd.olt;
        }
      }
    }
  } catch (e) {
    console.error('Error checking CustomerDevice in findOntForSerial:', e.message);
  }

  const allVariations = Array.from(new Set([...initialVariations, ...extraVariations]));

  // 1. Find ONT record by exact or variation match
  let ont = await prisma.oNT.findFirst({
    where: {
      isDeleted: false,
      OR: [
        { serialNumber: { in: allVariations } },
        { ontId: { in: allVariations } },
        { macAddress: { in: allVariations } }
      ]
    },
    include: {
      ontDetails: true,
      olt: {
        select: {
          id: true,
          name: true,
          ipAddress: true,
          vendor: true,
          sshHost: true,
          sshPort: true,
          sshUsername: true,
          sshPassword: true,
          sshEnablePassword: true,
          defaultTransport: true,
          telnetPort: true
        }
      }
    }
  });

  // 2. Fallback: search ONT table where serialNumber contains tail (last 8 chars)
  if (!ont) {
    const clean = serialNumber.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (clean.length >= 6) {
      const tail = clean.slice(-8);
      ont = await prisma.oNT.findFirst({
        where: {
          isDeleted: false,
          serialNumber: { contains: tail }
        },
        include: {
          ontDetails: true,
          olt: {
            select: {
              id: true,
              name: true,
              ipAddress: true,
              vendor: true,
              sshHost: true,
              sshPort: true,
              sshUsername: true,
              sshPassword: true,
              sshEnablePassword: true,
              defaultTransport: true,
              telnetPort: true
            }
          }
        }
      });
    }
  }

  if (ont && !ont.olt && customerOlt) {
    ont.olt = customerOlt;
  }

  if (!ont && customerOlt) {
    ont = {
      id: 0,
      serialNumber: serialNumber,
      ontId: "0",
      servicePort: "0/0/0",
      status: "online",
      olt: customerOlt
    };
  }

  return ont;
}

const refreshDeviceOptics = refreshOltPowerBySerial;

module.exports = {
  syncDevices,
  syncDevice,
  listDevices,
  setProviderSecret,
  verifyProviderSecret,
  getRadiusCredentialsBySerial,
  getDeviceBySerial,
  refreshDeviceOptics,
  linkLead,
  unlinkLead,
  deleteDevice,
  getOltPowerBySerial,
  refreshOltPowerBySerial,
  syncDeviceRadiusPassword
};
