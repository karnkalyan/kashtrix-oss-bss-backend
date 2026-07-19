const { ServiceFactory } = require('../lib/clients/ServiceFactory');
const { SERVICE_CODES } = require('../lib/serviceConstants');
const { invalidateGenieACSResponseCache } = require('../lib/genieacsResponseCache');

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
      projection: '_id,_deviceId,_lastInform,InternetGatewayDevice.DeviceInfo.SoftwareVersion,InternetGatewayDevice.WANDevice'
    });

    if (!Array.isArray(devices)) {
      return res.status(500).json({ error: 'Invalid response from GenieACS' });
    }

    let created = 0;
    let updated = 0;
    const syncedSerialNumbers = [];
    const syncStartedAt = new Date();

    const serialNumbersToSync = devices.map(d => d._deviceId?._SerialNumber).filter(Boolean);
    const customerDevices = serialNumbersToSync.length
      ? await req.prisma.customerDevice.findMany({
          where: {
            serialNumber: { in: serialNumbersToSync },
            customer: { ispId }
          },
          include: { customer: { select: { leadId: true } } }
        })
      : [];

    const leadIdBySerial = new Map(
      customerDevices
        .filter(cd => cd.serialNumber && cd.customer?.leadId)
        .map(cd => [cd.serialNumber, cd.customer.leadId])
    );

    for (const device of devices) {
      const serialNumber = device._deviceId?._SerialNumber;
      if (!serialNumber) continue;
      const now = new Date();
      syncedSerialNumbers.push(serialNumber);
      const username = extractFirstWanValue(device, 'WANPPPConnection', 'Username');
      const ipAddress =
        extractFirstWanValue(device, 'WANIPConnection', 'ExternalIPAddress') ||
        extractFirstWanValue(device, 'WANPPPConnection', 'ExternalIPAddress');

      const resolvedLeadId = leadIdBySerial.get(serialNumber) || null;

      const deviceData = {
        serialNumber,
        oui: device._deviceId?._OUI || null,
        productClass: device._deviceId?._ProductClass || null,
        manufacturer: device._deviceId?._Manufacturer || null,
        modelName: device._deviceId?._ModelName || null,
        status: isOnline(device._lastInform) ? 'online' : 'offline',
        lastContact: device._lastInform ? new Date(device._lastInform) : null,
        firmwareVersion: extractValue(device, 'InternetGatewayDevice.DeviceInfo.SoftwareVersion'),
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

      if (existing) {
        const updateData = {
          ...deviceData,
          ...(existing.ispId !== ispId ? { leadId: null } : {})
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

    return res.json({
      success: true,
      message: 'Device sync completed',
      stats: {
        total: devices.length,
        created,
        updated,
        removed: staleResult.count
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
      projection: '_id,_deviceId,_lastInform,InternetGatewayDevice.DeviceInfo,InternetGatewayDevice.WANDevice'
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

    const [devices, total] = await Promise.all([
      req.prisma.tr069Device.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take: Number(limit)
      }),
      req.prisma.tr069Device.count({ where })
    ]);

    // Auto-link devices assigned to customers in inventory
    const serialsToCheck = devices.map(d => d.serialNumber).filter(Boolean);
    if (serialsToCheck.length > 0) {
      const customerDevices = await req.prisma.customerDevice.findMany({
        where: {
          serialNumber: { in: serialsToCheck },
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
        if (cd.serialNumber && cd.customer?.leadId) {
          leadIdBySerial.set(cd.serialNumber, cd.customer.leadId);
        }
      });

      for (const d of devices) {
        const matchingLeadId = leadIdBySerial.get(d.serialNumber);
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

    // Map to frontend expected structure (PascalCase for hardware identification fields)
    const formattedDevices = devices.map(d => ({
      id: d.id,
      device: d.modelName || d.productClass || 'Unknown Device',
      ipAddress: d.ipAddress || 'N/A',
      username: parseDeviceNotes(d.notes).username || 'N/A',
      status: d.status,
      signal: 'N/A', // Signal currently not stored in local DB
      lastContact: d.lastContact,
      uptime: 'N/A', // Uptime currently not stored in local DB
      ProductClass: d.productClass,
      Manufacturer: d.manufacturer,
      SerialNumber: d.serialNumber,
      OUI: d.oui,
      leadId: d.leadId,
      lead: d.leadId ? leadById.get(d.leadId) || null : null
    }));

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

    // Map to frontend expected structure
    const formattedDevice = {
      id: device.id,
      device: device.modelName || device.productClass || 'Unknown Device',
      ipAddress: device.ipAddress || 'N/A',
      status: device.status,
      username: parseDeviceNotes(device.notes).username || 'N/A',
      signal: 'N/A',
      lastContact: device.lastContact,
      uptime: 'N/A',
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
  syncDevices,
  syncDevice,
  listDevices,
  getRadiusCredentialsBySerial,
  getDeviceBySerial,
  linkLead,
  unlinkLead,
  deleteDevice
};
