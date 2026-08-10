const crypto = require('crypto');
const { ServiceFactory } = require('../lib/clients/ServiceFactory');
const { SERVICE_CODES } = require('../lib/serviceConstants');
const { invalidateGenieACSResponseCache } = require('../lib/genieacsResponseCache');
const getDriver = require('../drivers');
const { ponSerialCandidates, samePonSerial } = require('../utils/ponSerial');

const TR069_PROVIDER_SECRET_KEY = 'tr069ProviderAccessSecretHash';

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

// Sync TR069 devices from GenieACS to local database
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

    // Fetch devices from GenieACS with enough WAN data to list IP and PPPoE username.
    const devices = await genieClient.getDevices({
      projection: '_id,_deviceId,_lastInform,VirtualParameters,InternetGatewayDevice.DeviceInfo,InternetGatewayDevice.WANDevice,Device'
    });

    if (!Array.isArray(devices)) {
      return res.status(500).json({ error: 'Invalid response from GenieACS' });
    }

    const providerOverride = await hasProviderOverride(req);
    let created = 0;
    let updated = 0;
    let protectedTenantDevices = 0;
    const syncedSerialNumbers = [];
    const syncStartedAt = new Date();

    const customerDevices = await req.prisma.customerDevice.findMany({
      where: { customer: { ispId, isDeleted: false } },
      include: { customer: { select: { leadId: true } } }
    });

    const allowedSerials = new Set(customerDevices
      .flatMap(customerDevice => [customerDevice.serialNumber, customerDevice.ponSerial])
      .filter(Boolean)
      .flatMap(ponSerialCandidates));
    const devicesToSync = providerOverride
      ? devices
      : devices.filter(device => ponSerialCandidates(device._deviceId?._SerialNumber).some(candidate => allowedSerials.has(candidate)));

    const leadIdBySerial = new Map();
    customerDevices.forEach((customerDevice) => {
      if (!customerDevice.customer?.leadId) return;
      [customerDevice.serialNumber, customerDevice.ponSerial].filter(Boolean).flatMap(ponSerialCandidates)
        .forEach((candidate) => leadIdBySerial.set(candidate, customerDevice.customer.leadId));
    });

    for (const device of devicesToSync) {
      const serialNumber = device._deviceId?._SerialNumber;
      if (!serialNumber) continue;
      const now = new Date();
      const username = extractFirstWanValue(device, 'WANPPPConnection', 'Username');
      const ipAddress =
        extractFirstWanValue(device, 'WANIPConnection', 'ExternalIPAddress') ||
        extractFirstWanValue(device, 'WANPPPConnection', 'ExternalIPAddress');

      const resolvedLeadId = ponSerialCandidates(serialNumber).map(candidate => leadIdBySerial.get(candidate)).find(Boolean) || null;

      const deviceData = {
        serialNumber,
        oui: device._deviceId?._OUI || null,
        productClass: device._deviceId?._ProductClass || null,
        manufacturer: device._deviceId?._Manufacturer || null,
        modelName: device._deviceId?._ModelName || null,
        status: isOnline(device._lastInform) ? 'online' : 'offline',
        lastContact: device._lastInform ? new Date(device._lastInform) : null,
        firmwareVersion: extractValue(device, 'InternetGatewayDevice.DeviceInfo.SoftwareVersion'),
        rxPower: extractRxPower(device),
        uptime: extractUptime(device),
        ipAddress,
        notes: JSON.stringify({ username: username || null }),
        ispId: ispId,
        isActive: true,
        isDeleted: false,
        updatedAt: now,
        ...(resolvedLeadId ? { leadId: resolvedLeadId } : {})
      };

      const existing = await req.prisma.tr069Device.findUnique({
        where: { serialNumber }
      });

      // A sync can refresh only its own tenant. Never transfer a globally
      // unique CPE serial from another ISP, even with provider visibility.
      if (existing && existing.ispId !== ispId) {
        protectedTenantDevices++;
        continue;
      }
      syncedSerialNumbers.push(serialNumber);

      if (existing) {
        await req.prisma.tr069Device.update({
          where: { serialNumber },
          data: deviceData
        });
        updated++;
      } else {
        await req.prisma.tr069Device.create({ data: deviceData });
        created++;
      }
    }

    const localDevices = await req.prisma.tr069Device.findMany({
      where: { ispId, isDeleted: false },
      select: { id: true, serialNumber: true }
    });
    const syncedAliases = new Set(syncedSerialNumbers.flatMap(ponSerialCandidates));
    const staleIds = localDevices
      .filter(device => providerOverride || ponSerialCandidates(device.serialNumber).some(candidate => allowedSerials.has(candidate)))
      .filter(device => !ponSerialCandidates(device.serialNumber).some(candidate => syncedAliases.has(candidate)))
      .map(device => device.id);
    const staleResult = staleIds.length
      ? await req.prisma.tr069Device.updateMany({
          where: { id: { in: staleIds }, ispId },
          data: {
            isActive: false,
            isDeleted: true,
            updatedAt: syncStartedAt
          }
        })
      : { count: 0 };

    return res.json({
      success: true,
      message: 'Device sync completed',
      stats: {
        total: devicesToSync.length,
        created,
        updated,
        removed: staleResult.count,
        protectedTenantDevices,
        scope: providerOverride ? 'provider' : 'customer-linked'
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

    const genieClient = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, req.ispId);
    const device = await genieClient.getDeviceBySerial(serialNumber, {
      projection: '_id,_deviceId,_lastInform,VirtualParameters,InternetGatewayDevice.DeviceInfo,InternetGatewayDevice.WANDevice,Device'
    });
    if (!device) return res.status(404).json({ error: 'Device was not found in ACS' });

    const oldNotes = parseDeviceNotes(localDevice.notes);
    const username = extractFirstWanValue(device, 'WANPPPConnection', 'Username');
    const ipAddress = extractFirstWanValue(device, 'WANIPConnection', 'ExternalIPAddress') || extractFirstWanValue(device, 'WANPPPConnection', 'ExternalIPAddress');
    const updated = await req.prisma.tr069Device.update({
      where: { id: localDevice.id },
      data: {
        oui: device._deviceId?._OUI || localDevice.oui,
        productClass: device._deviceId?._ProductClass || localDevice.productClass,
        manufacturer: device._deviceId?._Manufacturer || localDevice.manufacturer,
        modelName: device._deviceId?._ModelName || localDevice.modelName,
        status: isOnline(device._lastInform) ? 'online' : 'offline',
        lastContact: device._lastInform ? new Date(device._lastInform) : localDevice.lastContact,
        firmwareVersion: extractValue(device, 'InternetGatewayDevice.DeviceInfo.SoftwareVersion') || localDevice.firmwareVersion,
        rxPower: extractRxPower(device) ?? localDevice.rxPower,
        uptime: extractUptime(device) ?? localDevice.uptime,
        ipAddress: ipAddress || localDevice.ipAddress,
        notes: JSON.stringify({ ...oldNotes, username: username || oldNotes.username || null }),
        isActive: true,
        updatedAt: new Date()
      }
    });
    invalidateGenieACSResponseCache(req.ispId, serialNumber);
    return res.json({ success: true, message: `ACS device ${serialNumber} synchronized`, data: updated });
  } catch (err) {
    console.error('TR069 device sync error:', err);
    return next(err);
  }
}

// List all TR069 devices from local DB
async function listDevices(req, res, next) {
  try {
    res.set('Cache-Control', 'no-store');

    const { search, status, page = 1, limit = 50 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const providerOverride = await hasProviderOverride(req);
    const customerDevices = providerOverride ? [] : await req.prisma.customerDevice.findMany({
      where: { customer: { ispId: req.ispId, isDeleted: false } },
      select: { serialNumber: true, ponSerial: true }
    });
    const customerSerialAliases = providerOverride ? [] : [...new Set(customerDevices
      .flatMap(device => [device.serialNumber, device.ponSerial])
      .filter(Boolean)
      .flatMap(ponSerialCandidates))];
    const customerSerialSet = new Set(customerSerialAliases);

    const where = {
      ispId: req.ispId,
      isDeleted: false
    };

    if (status) {
      where.status = status;
    }

    if (search) {
      where.OR = [
        { serialNumber: { contains: search } },
        { manufacturer: { contains: search } },
        { modelName: { contains: search } },
        { ipAddress: { contains: search } }
      ];
    }

    const tenantDevices = await req.prisma.tr069Device.findMany({ where, orderBy: { updatedAt: 'desc' } });
    const scopedDevices = providerOverride
      ? tenantDevices
      : tenantDevices.filter(device => ponSerialCandidates(device.serialNumber).some(candidate => customerSerialSet.has(candidate)));
    const total = scopedDevices.length;
    const devices = scopedDevices.slice(skip, skip + Number(limit));

    // Auto-link devices assigned to customers in inventory
    const serialsToCheck = devices.map(d => d.serialNumber).filter(Boolean);
    const serialAliasesToCheck = [...new Set(serialsToCheck.flatMap(ponSerialCandidates))];
    if (serialsToCheck.length > 0) {
      const customerDevices = await req.prisma.customerDevice.findMany({
        where: {
          OR: [
            { serialNumber: { in: serialAliasesToCheck } },
            { ponSerial: { in: serialAliasesToCheck } }
          ],
          customer: { ispId: req.ispId }
        },
        include: {
          customer: {
            select: { leadId: true }
          }
        }
      });

      const leadIdBySerial = new Map();
      customerDevices.forEach(cd => {
        if (!cd.customer?.leadId) return;
        [cd.serialNumber, cd.ponSerial].filter(Boolean).flatMap(ponSerialCandidates)
          .forEach(candidate => leadIdBySerial.set(candidate, cd.customer.leadId));
      });

      for (const d of devices) {
        const matchingLeadId = ponSerialCandidates(d.serialNumber).map(candidate => leadIdBySerial.get(candidate)).find(Boolean);
        if (matchingLeadId && d.leadId !== matchingLeadId) {
          d.leadId = matchingLeadId;
          await req.prisma.tr069Device.update({
            where: { id: d.id },
            data: { leadId: matchingLeadId }
          }).catch(err => console.error(`Failed to auto-link TR-069 device ${d.serialNumber}:`, err));
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

    const onts = serialsToCheck.length
      ? await req.prisma.oNT.findMany({
          where: { ispId: req.ispId, isDeleted: false, serialNumber: { in: serialAliasesToCheck } },
          include: {
            olt: { select: { id: true, name: true, vendor: true } },
            ontDetails: { select: { opticalDiagnostics: true } }
          }
        })
      : [];
    const ontBySerial = new Map();
    onts.forEach(ont => ponSerialCandidates(ont.serialNumber).forEach(candidate => ontBySerial.set(candidate, ont)));

    // Map to frontend expected structure (PascalCase for hardware identification fields)
    const formattedDevices = devices.map(d => {
      const ont = ponSerialCandidates(d.serialNumber).map(candidate => ontBySerial.get(candidate)).find(Boolean);
      const oltRxPower = extractOltRxPower(ont);
      return ({
      id: d.id,
      device: d.modelName || d.productClass || 'Unknown Device',
      ipAddress: d.ipAddress || 'N/A',
      username: parseDeviceNotes(d.notes).username || 'N/A',
      status: d.status,
      rxPower: d.rxPower,
      signal: formatPower(d.rxPower),
      oltRxPower,
      oltName: ont?.olt?.name || null,
      lastContact: d.lastContact,
      uptime: d.uptime,
      ProductClass: d.productClass,
      Manufacturer: d.manufacturer,
      SerialNumber: d.serialNumber,
      OUI: d.oui,
      leadId: d.leadId,
      lead: d.leadId ? leadById.get(d.leadId) || null : null
      });
    });

    return res.json({
      success: true,
      devices: formattedDevices,
      total,
      scope: providerOverride ? 'provider' : 'customer-linked',
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

    // Auto-link check on detail view
    if (!device.leadId) {
      const cd = await req.prisma.customerDevice.findFirst({
        where: { serialNumber, customer: { ispId: req.ispId } },
        include: { customer: { select: { leadId: true } } }
      });
      if (cd?.customer?.leadId) {
        device.leadId = cd.customer.leadId;
        await req.prisma.tr069Device.update({
          where: { id: device.id },
          data: { leadId: cd.customer.leadId }
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

    const ont = await req.prisma.oNT.findFirst({
      where: { ispId: req.ispId, isDeleted: false, serialNumber: { in: ponSerialCandidates(serialNumber) } },
      include: {
        olt: { select: { id: true, name: true, vendor: true } },
        ontDetails: { select: { opticalDiagnostics: true } }
      }
    });

    // Map to frontend expected structure
    const formattedDevice = {
      id: device.id,
      device: device.modelName || device.productClass || 'Unknown Device',
      ipAddress: device.ipAddress || 'N/A',
      status: device.status,
      username: parseDeviceNotes(device.notes).username || 'N/A',
      rxPower: device.rxPower,
      signal: formatPower(device.rxPower),
      oltRxPower: extractOltRxPower(ont),
      oltName: ont?.olt?.name || null,
      lastContact: device.lastContact,
      uptime: device.uptime,
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

async function closeOpticalDriver(driver) {
  try {
    if (typeof driver?.disconnect === 'function') {
      await Promise.resolve(driver.disconnect());
      return;
    }
    if (typeof driver?.ssh?.close === 'function') await Promise.resolve(driver.ssh.close());
  } catch (error) {
    console.warn('[TR069 Optics] Driver close failed:', error.message);
  }
}

async function refreshDeviceOptics(req, res, next) {
  let driver;
  try {
    const serialNumber = String(req.params.serialNumber || '').trim();
    const serialCandidates = ponSerialCandidates(serialNumber);
    if (!serialCandidates.length) return res.status(400).json({ error: 'A valid CPE serial number is required' });

    let ont = await req.prisma.oNT.findFirst({
      where: { ispId: req.ispId, isDeleted: false, serialNumber: { in: serialCandidates } },
      include: { olt: true, ontDetails: true }
    });
    let liveOnt = null;

    if (!ont) {
      const olts = await req.prisma.oLT.findMany({
        where: { ispId: req.ispId, isDeleted: false, isActive: true },
        orderBy: { id: 'asc' }
      });
      for (const candidateOlt of olts) {
        try {
          driver = getDriver(candidateOlt);
          if (typeof driver.getOntInfoBySN !== 'function') continue;
          await driver.connect();
          for (const candidate of serialCandidates) {
            try {
              liveOnt = await Promise.resolve(driver.getOntInfoBySN(candidate));
            } catch {
              liveOnt = null;
            }
            if (liveOnt) break;
          }
          if (!liveOnt) {
            await closeOpticalDriver(driver);
            driver = null;
            continue;
          }

          const discoveredDiagnostics = liveOnt.optical_diagnostics || liveOnt.diagnostics || {};
          const discoveredPort = String(liveOnt.fsp || liveOnt.servicePort || '0/0/0');
          const discoveredOntId = String(liveOnt.ont_id ?? liveOnt.ontId ?? liveOnt.onu_id ?? serialNumber);
          const discoveredSerial = String(liveOnt.sn || liveOnt.serialNumber || liveOnt.serial_number || serialCandidates[1] || serialCandidates[0]);
          const discoveredData = {
            ontId: discoveredOntId,
            serialNumber: discoveredSerial,
            vendor: serialCandidates[0]?.slice(0, 4) || null,
            status: String(liveOnt.run_state || liveOnt.status || 'online').toLowerCase(),
            distance: finiteNumber(liveOnt.distance),
            rxPower: finiteNumber(liveOnt.rx_power ?? discoveredDiagnostics.rx_power),
            txPower: finiteNumber(liveOnt.tx_power ?? discoveredDiagnostics.tx_power),
            temperature: finiteNumber(liveOnt.temperature ?? discoveredDiagnostics.temperature),
            servicePort: discoveredPort,
            serviceState: liveOnt.control_flag || null,
            rawData: { optical_diagnostics: discoveredDiagnostics },
            lastSync: new Date(),
            isDeleted: false,
            oltId: candidateOlt.id,
            ispId: req.ispId
          };
          const existing = await req.prisma.oNT.findFirst({
            where: { oltId: candidateOlt.id, ontId: discoveredOntId, servicePort: discoveredPort }
          });
          ont = existing
            ? await req.prisma.oNT.update({ where: { id: existing.id }, data: discoveredData, include: { olt: true, ontDetails: true } })
            : await req.prisma.oNT.create({ data: discoveredData, include: { olt: true, ontDetails: true } });
          break;
        } catch (error) {
          console.warn(`[TR069 Optics] ${candidateOlt.name}: ${error.message}`);
          await closeOpticalDriver(driver);
          driver = null;
        }
      }
      if (!ont) return res.status(404).json({
        error: `No configured OLT returned ${serialNumber}`,
        serialCandidates,
        message: 'Both printed and hexadecimal vendor serial formats were queried.'
      });
    }

    if (!driver) {
      driver = getDriver(ont.olt);
      await driver.connect();
    }

    const fsp = String(ont.servicePort || ont.ontDetails?.fsp || '').match(/(\d+)\/(\d+)\/(\d+)/);
    if (!liveOnt && typeof driver.getOntInfoWithOptical === 'function') {
      const rows = await driver.getOntInfoWithOptical(
        fsp ? Number(fsp[1]) : 0,
        fsp ? Number(fsp[2]) : 0,
        fsp ? Number(fsp[3]) : undefined
      );
      const list = Array.isArray(rows) ? rows : (rows ? [rows] : []);
      liveOnt = list.find(row => {
        const rowSerial = row.serialNumber || row.serial_number || row.sn || row.serial || row.mac_address;
        return (rowSerial && samePonSerial(rowSerial, serialNumber)) ||
          (String(row.ont_id ?? row.ontId ?? '') === String(ont.ontId) && (!fsp || String(row.fsp || '').includes(`${fsp[1]}/${fsp[2]}/${fsp[3]}`)));
      }) || null;
    }

    if (!liveOnt && typeof driver.getOntInfoBySN === 'function') {
      for (const candidate of serialCandidates) {
        try {
          liveOnt = await Promise.resolve(driver.getOntInfoBySN(candidate, fsp ? Number(fsp[2]) : 0));
        } catch {
          liveOnt = null;
        }
        if (liveOnt) break;
      }
    }
    if (!liveOnt) return res.status(404).json({ error: 'The ONT was not returned by the configured OLT driver' });

    const diagnostics = liveOnt.optical_diagnostics || liveOnt.diagnostics || {};
    const rxPower = finiteNumber(liveOnt.rx_power ?? liveOnt.rxPower ?? diagnostics.rx_power) ?? ont.rxPower;
    const txPower = finiteNumber(liveOnt.tx_power ?? liveOnt.txPower ?? diagnostics.tx_power) ?? ont.txPower;
    const temperature = finiteNumber(liveOnt.temperature ?? diagnostics.temperature) ?? ont.temperature;
    const oltRxPower = extractOltRxPower({ rawData: diagnostics }) ?? extractOltRxPower(ont);
    const currentRaw = ont.rawData && typeof ont.rawData === 'object' && !Array.isArray(ont.rawData) ? ont.rawData : {};

    const updatedOnt = await req.prisma.oNT.update({
      where: { id: ont.id },
      data: {
        rxPower,
        txPower,
        temperature,
        rawData: { ...currentRaw, optical_diagnostics: diagnostics },
        lastSync: new Date()
      }
    });
    if (ont.ontDetails) {
      await req.prisma.oNTDetails.update({
        where: { id: ont.ontDetails.id },
        data: { opticalDiagnostics: diagnostics, lastSync: new Date() }
      });
    }

    return res.json({
      success: true,
      data: {
        serialNumber,
        oltSerialNumber: ont.serialNumber,
        serialCandidates,
        rxPower: updatedOnt.rxPower,
        oltRxPower,
        oltName: ont.olt.name,
        oltVendor: ont.olt.vendor,
        lastSync: updatedOnt.lastSync
      }
    });
  } catch (err) {
    console.error('TR069 live optical refresh error:', err);
    return next(err);
  } finally {
    await closeOpticalDriver(driver);
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

function finiteNumber(value) {
  const raw = value && typeof value === 'object' && '_value' in value ? value._value : value;
  const parsed = Number.parseFloat(String(raw ?? '').replace(/[^\d+.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function findParameterByName(node, acceptedNames, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return null;
  for (const [key, value] of Object.entries(node)) {
    if (acceptedNames.has(key.toLowerCase())) {
      const parsed = finiteNumber(value);
      if (parsed !== null) return parsed;
    }
  }
  for (const value of Object.values(node)) {
    const found = findParameterByName(value, acceptedNames, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function extractRxPower(device) {
  const directPaths = [
    'VirtualParameters.RxPower',
    'Device.Optical.Interface.1.RXPower',
    'Device.DeviceInfo.X_PON_RXPower',
    'InternetGatewayDevice.DeviceInfo.X_PON_RXPower'
  ];
  for (const path of directPaths) {
    const value = finiteNumber(extractValue(device, path));
    if (value !== null) return value;
  }
  return findParameterByName(device, new Set(['rxpower', 'rx_power', 'opticalrxpower', 'receivepower']));
}

function extractUptime(device) {
  const paths = ['Device.DeviceInfo.UpTime', 'InternetGatewayDevice.DeviceInfo.UpTime', 'VirtualParameters.UpTime'];
  for (const path of paths) {
    const value = finiteNumber(extractValue(device, path));
    if (value !== null) return Math.max(0, Math.trunc(value));
  }
  return null;
}

function extractOltRxPower(ont) {
  if (!ont) return null;
  const sources = [ont.rawData, ont.ontDetails?.opticalDiagnostics];
  const names = new Set(['oltrxpower', 'olt_rx_power', 'oltreceivepower', 'rxpoweratolt']);
  for (let source of sources) {
    if (typeof source === 'string') {
      try { source = JSON.parse(source); } catch { continue; }
    }
    const value = findParameterByName(source, names);
    if (value !== null) return value;
  }
  return null;
}

function formatPower(value) {
  const parsed = finiteNumber(value);
  return parsed === null ? 'N/A' : `${parsed.toFixed(2)} dBm`;
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

module.exports = {
  setProviderSecret,
  verifyProviderSecret,
  syncDevices,
  syncDevice,
  listDevices,
  getRadiusCredentialsBySerial,
  getDeviceBySerial,
  refreshDeviceOptics,
  linkLead,
  unlinkLead,
  deleteDevice
};
