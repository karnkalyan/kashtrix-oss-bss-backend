/**
 * Kisan ISP Read-Only Model Context Protocol (MCP) Server
 * Compatible with Google Spark, Claude, Antigravity, and stdio/SSE transports.
 * 
 * STRICT READ-ONLY PERMISSIONS ENFORCED ON ALL TOOLS.
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const prisma = require('../prisma/client.js');

let ServiceFactory = null;
let SERVICE_CODES = null;
try {
  ServiceFactory = require('../src/lib/clients/ServiceFactory.js').ServiceFactory;
  SERVICE_CODES = require('../src/lib/serviceConstants.js').SERVICE_CODES;
} catch (err) {
  console.warn('[MCP Server] ServiceFactory or SERVICE_CODES module not loaded:', err.message);
}

// Helper for formatting MCP tool responses
function formatToolResult(data, isError = false) {
  return {
    content: [
      {
        type: 'text',
        text: typeof data === 'string' ? data : JSON.stringify(data, null, 2)
      }
    ],
    isError
  };
}

/**
 * Fetch realtime device, ONT & RADIUS accounting status for a customer
 */
async function getCustomerRealtimeStatus(prismaClient, customer) {
  let primaryDevice = null;
  let ontRealtimeStatus = 'offline';
  let radiusRealtimeStatus = 'offline';
  let radiusAccounting = null;

  const ispId = customer.ispId || 1;

  // 1. Device / ONT Status
  try {
    const customerDevices = customer.devices || [];
    const assignedSerials = new Set(
      customerDevices
        .flatMap(d => [d.serialNumber, d.ponSerial])
        .filter(Boolean)
        .map(s => String(s).trim().toUpperCase())
    );

    let tr069Devices = [];
    const tr069Model = prismaClient.tr069Device || prismaClient.Tr069Device;
    if (tr069Model) {
      if (assignedSerials.size > 0) {
        tr069Devices = await tr069Model.findMany({
          where: {
            isDeleted: false,
            OR: [
              { serialNumber: { in: Array.from(assignedSerials) } },
              { customerId: customer.id }
            ]
          }
        }).catch(() => []);
      } else {
        tr069Devices = await tr069Model.findMany({
          where: { customerId: customer.id, isDeleted: false }
        }).catch(() => []);
      }
    }

    primaryDevice = tr069Devices.find(d => assignedSerials.has(String(d.serialNumber || '').trim().toUpperCase()))
      || tr069Devices[0]
      || (customerDevices[0] ? { serialNumber: customerDevices[0].serialNumber, status: customerDevices[0].status || 'offline' } : null);

    if (primaryDevice && primaryDevice.serialNumber && ServiceFactory && SERVICE_CODES?.GENIEACS) {
      const genieClient = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId, prismaClient).catch(() => null);
      if (genieClient) {
        const acsDevice = await genieClient.getDeviceBySerial(primaryDevice.serialNumber, {
          projection: '_id,_deviceId,_lastInform'
        }).catch(() => null);
        if (acsDevice) {
          const lastInform = acsDevice._lastInform;
          const isOnline = lastInform && (Date.now() - new Date(lastInform).getTime() < 5 * 60 * 1000);
          ontRealtimeStatus = isOnline ? 'online' : 'offline';
        } else {
          ontRealtimeStatus = primaryDevice.status || 'offline';
        }
      } else {
        ontRealtimeStatus = primaryDevice.status || 'offline';
      }
    } else if (primaryDevice) {
      ontRealtimeStatus = primaryDevice.status || 'offline';
    } else {
      ontRealtimeStatus = 'N/A';
    }
  } catch (err) {
    ontRealtimeStatus = 'N/A';
  }

  // 2. RADIUS / PPPoE Status
  try {
    const username = customer.connectionUsers?.[0]?.username;
    if (username && ServiceFactory && SERVICE_CODES?.RADIUS) {
      const radiusClient = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, ispId, prismaClient).catch(() => null);
      if (radiusClient) {
        const [sessions, postAuthLogs] = await Promise.all([
          radiusClient.getRadacctByUsername(username).catch(() => []),
          radiusClient.getRadpostauthByUsername(username).catch(() => [])
        ]);
        const hasAccessAccept = Array.isArray(postAuthLogs) && postAuthLogs.some(
          log => String(log.reply || '').trim().toLowerCase() === 'access-accept'
        );
        radiusRealtimeStatus = hasAccessAccept ? 'online' : 'offline';
        if (Array.isArray(sessions) && sessions.length > 0) {
          const activeSession = sessions.find(session => {
            const stopTime = session.acctstoptime ?? session.acctStopTime;
            return !stopTime || stopTime === '0000-00-00 00:00:00';
          });
          const sortedSessions = [...sessions].sort((a, b) => {
            const timeA = a.acctstarttime ? new Date(a.acctstarttime).getTime() : 0;
            const timeB = b.acctstarttime ? new Date(b.acctstarttime).getTime() : 0;
            return timeB - timeA;
          });
          const targetSession = activeSession || sortedSessions[0];
          if (targetSession) {
            radiusAccounting = {
              status: hasAccessAccept ? 'online' : 'offline',
              sessionDownload: Number(targetSession.acctoutputoctets || 0) + Number(targetSession.acctoutputoctets64 || 0),
              sessionUpload: Number(targetSession.acctinputoctets || 0) + Number(targetSession.acctinputoctets64 || 0),
              nasIp: targetSession.nasipaddress || 'N/A',
              framedIp: targetSession.framedipaddress || 'N/A',
              onlineDuration: Number(targetSession.acctsessiontime || 0)
            };
          }
        }
      }
    } else {
      radiusRealtimeStatus = 'N/A';
    }
  } catch (err) {
    radiusRealtimeStatus = 'N/A';
  }

  return {
    ontRealtimeStatus,
    radiusRealtimeStatus,
    radiusAccounting,
    acsSerial: primaryDevice?.serialNumber || null
  };
}

/**
 * Fully enrich customer details matching /api/customer/:id backend output
 */
async function enrichCustomerFullDetails(prismaClient, customer) {
  if (!customer) return null;

  // 1. Order add-on charges and package items
  const packageIds = [...new Set((customer.orders || []).map(order => order.package).filter(Boolean))];
  const pkgLinksModel = prismaClient.packageonetimecharges || prismaClient.Packageonetimecharges;
  const packageLinks = (packageIds.length && pkgLinksModel)
    ? await pkgLinksModel.findMany({ where: { A: { in: packageIds } } }).catch(() => [])
    : [];
  const chargeIds = [...new Set(packageLinks.map(link => link.B))];
  const chargeModel = prismaClient.oneTimeCharge || prismaClient.OneTimeCharge;
  const packageCharges = (chargeIds.length && chargeModel)
    ? await chargeModel.findMany({ where: { id: { in: chargeIds }, isDeleted: false }, orderBy: { id: 'asc' } }).catch(() => [])
    : [];
  const chargeById = new Map(packageCharges.map(charge => [charge.id, charge]));
  const chargesByPackage = new Map();
  for (const link of packageLinks) {
    const charge = chargeById.get(link.B);
    if (!charge) continue;
    const charges = chargesByPackage.get(link.A) || [];
    charges.push(charge);
    chargesByPackage.set(link.A, charges);
  }

  const firstOrderIdByPackage = new Map();
  for (const order of customer.orders || []) {
    if (!order.package || Number(order.totalAmount || 0) <= 0) continue;
    const current = firstOrderIdByPackage.get(order.package);
    if (current === undefined || order.id < current) firstOrderIdByPackage.set(order.package, order.id);
  }

  const enrichedOrders = (customer.orders || []).map(order => {
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

  // 2. Enrich serviceDetails with VLAN objects & safe OLT credentials
  const vlanIdsSet = new Set();
  if (Array.isArray(customer.serviceDetails)) {
    for (const sd of customer.serviceDetails) {
      if (sd.vlanId && typeof sd.vlanId === 'string') {
        sd.vlanId.split(',').forEach(id => {
          const parsed = parseInt(id.trim(), 10);
          if (!isNaN(parsed)) vlanIdsSet.add(parsed);
        });
      }
    }
  }

  let vlanMap = new Map();
  const vlanModel = prismaClient.oLTVLAN || prismaClient.OLTVLAN;
  if (vlanIdsSet.size > 0 && vlanModel) {
    const vlans = await vlanModel.findMany({ where: { id: { in: Array.from(vlanIdsSet) } } }).catch(() => []);
    vlanMap = new Map(vlans.map(v => [v.id, v]));
  }

  const enrichedServiceDetails = (customer.serviceDetails || []).map(sd => {
    let vlanDetails = [];
    if (sd.vlanId && typeof sd.vlanId === 'string') {
      const ids = sd.vlanId.split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id));
      vlanDetails = ids.map(id => vlanMap.get(id)).filter(Boolean);
    }
    let safeOlt = sd.olt;
    if (sd.olt) {
      const { sshUsername, sshPassword, sshEnablePassword, sshKey, snmpCommunity, ...rest } = sd.olt;
      safeOlt = rest;
    }
    return {
      ...sd,
      vlanDetails,
      olt: safeOlt
    };
  });

  // 3. Enrich documents
  const enrichedDocuments = (customer.documents || []).map(doc => {
    const normalized = doc.filePath ? String(doc.filePath).replace(/\\/g, '/') : null;
    const uploadsIndex = normalized ? normalized.indexOf('uploads/') : -1;
    const previewUrl = uploadsIndex >= 0 ? `/${normalized.slice(uploadsIndex)}` : null;
    const isInlinePreview = /^image\//i.test(doc.mimeType || '') || String(doc.mimeType || '').toLowerCase() === 'application/pdf';
    return {
      ...doc,
      filePath: undefined,
      previewUrl,
      canPreviewInline: Boolean(previewUrl && isInlinePreview),
      downloadUrl: `/customer/${doc.customerId}/documents/${doc.id}/download`
    };
  });

  // 4. Inventory items
  const invModel = prismaClient.inventoryItem || prismaClient.InventoryItem;
  const inventoryItems = invModel
    ? await invModel.findMany({
        where: { customerId: customer.id },
        orderBy: { updatedAt: 'desc' }
      }).catch(() => [])
    : [];

  // 5. Portal user
  const userModel = prismaClient.user || prismaClient.User;
  const portalUser = userModel
    ? await userModel.findFirst({
        where: { customerId: customer.id, isDeleted: false },
        select: { id: true, email: true, name: true, profilePicture: true, status: true, createdAt: true, updatedAt: true }
      }).catch(() => null)
    : null;

  // 6. Realtime network status
  const realtimeNet = await getCustomerRealtimeStatus(prismaClient, customer);

  // 7. Enriched devices
  const enrichedDevices = (customer.devices || []).map(d => ({
    ...d,
    status: realtimeNet.ontRealtimeStatus !== 'N/A' ? realtimeNet.ontRealtimeStatus : (d.status || 'offline')
  }));

  const meta = customer.lead?.metadata ? (typeof customer.lead.metadata === 'string' ? JSON.parse(customer.lead.metadata) : customer.lead.metadata) : null;

  return {
    ...customer,
    devices: enrichedDevices,
    serviceDetails: enrichedServiceDetails,
    documents: enrichedDocuments,
    orders: enrichedOrders,
    portalUser,
    profilePicture: portalUser?.profilePicture || null,
    inventoryItems,
    firstName: customer.lead?.firstName,
    lastName: customer.lead?.lastName,
    middleName: customer.lead?.middleName || "",
    email: customer.lead?.email,
    phoneNumber: customer.lead?.phoneNumber,
    secondaryPhone: customer.lead?.secondaryContactNumber || "No Secondary",
    gender: customer.lead?.gender,
    street: customer.lead?.street,
    city: customer.lead?.city,
    district: customer.lead?.district,
    state: customer.lead?.province,
    latitude: customer.lead?.metadata?.latitude ?? meta?.latitude ?? null,
    longitude: customer.lead?.metadata?.longitude ?? meta?.longitude ?? null,
    ontRealtimeStatus: realtimeNet.ontRealtimeStatus,
    radiusRealtimeStatus: realtimeNet.radiusRealtimeStatus,
    radiusAccounting: realtimeNet.radiusAccounting,
    primaryDeviceSerial: realtimeNet.acsSerial || (enrichedDevices[0]?.serialNumber || null)
  };
}

// Complete tool definitions for all domains across the system
const READ_ONLY_TOOLS = [
  // 1. Customer Management
  {
    name: 'list_customers',
    description: 'List and search customers with status, branch, olt, splitter, or area filtering (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search term for name, phone, email, username, or customerUniqueId' },
        branchId: { type: 'number', description: 'Filter by branch ID' },
        status: { type: 'string', description: 'Filter by status (e.g., active, expired, pending, suspended)' },
        onboardStatus: { type: 'string', description: 'Filter by onboard status (e.g. completed, expired_package)' },
        oltId: { type: 'number', description: 'Filter by OLT ID' },
        splitterId: { type: 'number', description: 'Filter by Splitter ID' },
        page: { type: 'number', description: 'Page number (default 1)' },
        limit: { type: 'number', description: 'Items per page (default 20, max 100)' }
      }
    }
  },
  {
    name: 'get_customer_details',
    description: 'Get complete full details of a customer by ID, customerUniqueId, username, or phone including billing, devices, ppp, realtime status, inventory, and documents (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Customer database ID' },
        customerUniqueId: { type: 'string', description: 'Customer unique code (e.g. CUS-CH-00006-SHANT)' },
        username: { type: 'string', description: 'PPPoE connection username, lead email, or portal username' },
        phone: { type: 'string', description: 'Customer phone number' },
        search: { type: 'string', description: 'General search keyword' }
      }
    }
  },
  {
    name: 'get_customer_radius_auth_logs',
    description: 'Get RADIUS authentication logs for a customer or connection username (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        customerId: { type: 'number', description: 'Customer database ID' },
        username: { type: 'string', description: 'PPPoE username' },
        page: { type: 'number', description: 'Page number' },
        limit: { type: 'number', description: 'Limit' }
      }
    }
  },
  {
    name: 'get_customer_summary',
    description: 'Get customer status summary counts (active, expired, pending, suspended) (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        branchId: { type: 'number', description: 'Filter by branch ID' }
      }
    }
  },

  // 2. Sales Leads
  {
    name: 'list_leads',
    description: 'List and filter sales leads (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search term for lead name, phone, email, address' },
        status: { type: 'string', description: 'Lead status (e.g. new, contacted, interested, converted, rejected)' },
        assignedUserId: { type: 'number', description: 'Assigned staff user ID' },
        page: { type: 'number', description: 'Page number' },
        limit: { type: 'number', description: 'Items per page' }
      }
    }
  },
  {
    name: 'get_lead_details',
    description: 'Get details of a specific lead by ID including followups and notes (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Lead database ID' }
      },
      required: ['id']
    }
  },

  // 3. Splitter & Fiber Distribution
  {
    name: 'list_splitters',
    description: 'List fiber optic splitters and distribution tree (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        oltId: { type: 'number', description: 'Filter by OLT ID' },
        branchId: { type: 'number', description: 'Filter by Branch ID' },
        search: { type: 'string', description: 'Search name or location' },
        page: { type: 'number', description: 'Page number' },
        limit: { type: 'number', description: 'Items per page' }
      }
    }
  },
  {
    name: 'get_splitter_details',
    description: 'Get details of a splitter including input/output ports and downstream splitters (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Splitter ID' }
      },
      required: ['id']
    }
  },

  // 4. OLT Infrastructure
  {
    name: 'list_olts',
    description: 'List registered OLT devices (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        branchId: { type: 'number', description: 'Filter by branch ID' },
        search: { type: 'string', description: 'Search by OLT name or IP address' }
      }
    }
  },
  {
    name: 'get_olt_details',
    description: 'Get details of a specific OLT device including service boards and PON ports (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'OLT ID' }
      },
      required: ['id']
    }
  },
  {
    name: 'get_olt_vlans',
    description: 'List OLT VLAN configurations (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        oltId: { type: 'number', description: 'Filter by OLT ID' }
      }
    }
  },
  {
    name: 'get_olt_pon_ports',
    description: 'Get PON port details and active subscribers per port for an OLT (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        oltId: { type: 'number', description: 'OLT ID' }
      },
      required: ['oltId']
    }
  },

  // 5. TR-069 / GenieACS Devices
  {
    name: 'list_tr069_devices',
    description: 'List TR-069 CPE devices synced from GenieACS (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search by serial number, manufacturer, model, or IP' },
        status: { type: 'string', description: 'Connection status (online, offline)' },
        page: { type: 'number', description: 'Page number' },
        limit: { type: 'number', description: 'Limit' }
      }
    }
  },
  {
    name: 'get_tr069_device_details',
    description: 'Get full TR-069 device information, Wi-Fi parameters, and optical status by serial number (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        serialNumber: { type: 'string', description: 'CPE Serial Number' }
      },
      required: ['serialNumber']
    }
  },

  // 6. ONT & Optical Diagnostics
  {
    name: 'list_onts',
    description: 'List registered ONTs on OLT PON ports (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        oltId: { type: 'number', description: 'Filter by OLT ID' },
        search: { type: 'string', description: 'Search serial number or description' },
        page: { type: 'number', description: 'Page number' },
        limit: { type: 'number', description: 'Limit' }
      }
    }
  },
  {
    name: 'get_ont_details',
    description: 'Get ONT details, service port maps, and optical diagnostics (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'ONT database ID' },
        serialNumber: { type: 'string', description: 'ONT Serial Number' }
      }
    }
  },
  {
    name: 'get_olt_optical_power',
    description: 'Get optical RX/TX power levels for an ONT or PON port (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        serialNumber: { type: 'string', description: 'ONT Serial Number' },
        ontId: { type: 'number', description: 'ONT ID' }
      }
    }
  },
  {
    name: 'list_low_power_onts',
    description: 'List ONTs experiencing low/critical optical signal levels (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        thresholdDbm: { type: 'number', description: 'RX Power cutoff in dBm (default -27.0)' },
        oltId: { type: 'number', description: 'Filter by OLT ID' }
      }
    }
  },

  // 7. Support Tickets
  {
    name: 'list_tickets',
    description: 'List support tickets (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search ticket number, subject, description' },
        status: { type: 'string', description: 'Status (open, in_progress, resolved, closed)' },
        priority: { type: 'string', description: 'Priority (low, medium, high, critical)' },
        page: { type: 'number', description: 'Page number' },
        limit: { type: 'number', description: 'Limit' }
      }
    }
  },
  {
    name: 'get_ticket_details',
    description: 'Get complete ticket conversation and resolution history (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Ticket ID' }
      },
      required: ['id']
    }
  },

  // 8. Field Tasks
  {
    name: 'list_tasks',
    description: 'List staff field tasks and assignments (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search title or description' },
        status: { type: 'string', description: 'Task status (pending, in_progress, completed, cancelled)' },
        assignedUserId: { type: 'number', description: 'Filter by assigned staff ID' },
        page: { type: 'number', description: 'Page number' },
        limit: { type: 'number', description: 'Limit' }
      }
    }
  },
  {
    name: 'get_task_details',
    description: 'Get task information, customer links, and completion logs (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Task ID' }
      },
      required: ['id']
    }
  },

  // 9. Follow-ups
  {
    name: 'list_followups',
    description: 'List lead and customer follow-up schedules (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        leadId: { type: 'number', description: 'Filter by lead ID' },
        customerId: { type: 'number', description: 'Filter by customer ID' },
        status: { type: 'string', description: 'Status (pending, completed, missed)' },
        page: { type: 'number', description: 'Page number' },
        limit: { type: 'number', description: 'Limit' }
      }
    }
  },
  {
    name: 'get_followup_details',
    description: 'Get specific follow-up details and notes (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Followup ID' }
      },
      required: ['id']
    }
  },

  // 10. eSewa & Payments
  {
    name: 'list_esewa_transactions',
    description: 'List eSewa payment gateway transaction logs (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search transaction reference or status' },
        status: { type: 'string', description: 'Transaction status (COMPLETE, PENDING, FAILED)' },
        page: { type: 'number', description: 'Page number' },
        limit: { type: 'number', description: 'Limit' }
      }
    }
  },
  {
    name: 'get_esewa_transaction_details',
    description: 'Get details of an eSewa transaction by ID or reference (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Database ID' },
        transactionRef: { type: 'string', description: 'eSewa transaction code/ref' }
      }
    }
  },

  // 11. External Services & Credentials
  {
    name: 'list_external_services',
    description: 'List configured external integrations and API clients (GenieACS, Mikrotik, NetTV, eSewa, Yeastar, RADIUS, etc.) (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        serviceCode: { type: 'string', description: 'Filter by service code' }
      }
    }
  },
  {
    name: 'get_external_service_details',
    description: 'Get configuration and health status of an external service (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        serviceCode: { type: 'string', description: 'Service code (GENIEACS, MIKROTIK, NETTV, ESEWA, KHALTI, YEASTAR, RADIUS, SMS)' }
      },
      required: ['serviceCode']
    }
  },

  // 12. Billing & Package Plans
  {
    name: 'list_billing_invoices',
    description: 'List customer billing invoices / orders with accounting sync status (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        customerId: { type: 'number', description: 'Filter by customer ID' },
        status: { type: 'string', description: 'Paid or unpaid status' },
        search: { type: 'string', description: 'Search invoice number or reference' },
        page: { type: 'number', description: 'Page number' },
        limit: { type: 'number', description: 'Limit' }
      }
    }
  },
  {
    name: 'get_billing_invoice_details',
    description: 'Get detailed invoice items, breakdown, tax, and Nepurix sync info (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Order / Subscription / Invoice ID' }
      },
      required: ['id']
    }
  },
  {
    name: 'list_payments',
    description: 'List customer payment receipts (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        customerId: { type: 'number', description: 'Filter by customer ID' },
        paymentMethod: { type: 'string', description: 'Payment method (eSewa, Khalti, Cash, Bank)' },
        page: { type: 'number', description: 'Page number' },
        limit: { type: 'number', description: 'Limit' }
      }
    }
  },
  {
    name: 'list_package_plans',
    description: 'List ISP internet and IPTV package plans and prices (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search package plan name or code' }
      }
    }
  },

  // 13. Yeastar PBX
  {
    name: 'list_yeastar_extensions',
    description: 'List Yeastar PBX VoIP extensions (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search extension number or user' }
      }
    }
  },
  {
    name: 'list_yeastar_trunks',
    description: 'List Yeastar PBX trunks and registration status (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search trunk name' }
      }
    }
  },
  {
    name: 'list_yeastar_cdrs',
    description: 'Query Call Detail Records (CDRs) from Yeastar PBX (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search caller or callee' },
        page: { type: 'number', description: 'Page number' },
        limit: { type: 'number', description: 'Limit' }
      }
    }
  },

  // 14. Asterisk PBX
  {
    name: 'list_asterisk_call_logs',
    description: 'Query Asterisk VoIP call logs (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search phone number or caller ID' },
        page: { type: 'number', description: 'Page number' },
        limit: { type: 'number', description: 'Limit' }
      }
    }
  },
  {
    name: 'get_asterisk_status',
    description: 'Get live Asterisk server connectivity and channels status (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },

  // 15. Inventory & Assets
  {
    name: 'list_inventory_items',
    description: 'List hardware inventory items (ONT, Router, STB, Switch, Cable) (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Item type (ONT, ROUTER, STB, SWITCH, DROPWIRE)' },
        status: { type: 'string', description: 'Item status (IN_STOCK, ASSIGNED_TO_BRANCH, ASSIGNED_TO_USER, ASSIGNED_TO_CUSTOMER)' },
        branchId: { type: 'number', description: 'Filter by branch ID' },
        search: { type: 'string', description: 'Search serial number, MAC, or item name' },
        page: { type: 'number', description: 'Page number' },
        limit: { type: 'number', description: 'Limit' }
      }
    }
  },
  {
    name: 'get_inventory_item_details',
    description: 'Get detailed information for a specific inventory item (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Inventory item ID' },
        serialNumber: { type: 'string', description: 'Item serial number' }
      }
    }
  },
  {
    name: 'get_inventory_lifecycle',
    description: 'Get complete assignment and lifecycle movement history for an inventory asset (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        inventoryItemId: { type: 'number', description: 'Inventory item ID' },
        serialNumber: { type: 'string', description: 'Item serial number' }
      }
    }
  },
  {
    name: 'list_drums',
    description: 'List fiber cable drums and drum assignments (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search drum number or specs' }
      }
    }
  },
  {
    name: 'list_bulk_inventories',
    description: 'List bulk inventory items and stock levels (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search item name' }
      }
    }
  },

  // 16. Branches & Staff Users
  {
    name: 'list_branches',
    description: 'List ISP branches and sub-branches (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search branch name or code' }
      }
    }
  },
  {
    name: 'get_branch_details',
    description: 'Get branch details, contact info, and subscriber counts (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Branch ID' }
      },
      required: ['id']
    }
  },
  {
    name: 'list_staff_users',
    description: 'List staff users, roles, and branch assignments (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        branchId: { type: 'number', description: 'Filter by branch ID' },
        search: { type: 'string', description: 'Search staff name, email, or role' }
      }
    }
  },

  // 17. NAS Routers & Active RADIUS Sessions
  {
    name: 'list_nas_devices',
    description: 'List NAS devices (Mikrotik routers, etc.) (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search NAS IP or short name' }
      }
    }
  },
  {
    name: 'list_active_radius_sessions',
    description: 'Query live active PPPoE / RADIUS subscriber sessions (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search PPPoE username, framed IP, or NAS IP' },
        page: { type: 'number', description: 'Page number' },
        limit: { type: 'number', description: 'Limit' }
      }
    }
  },
  {
    name: 'get_radius_session_user',
    description: 'Get active RADIUS session info for a specific subscriber username (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        username: { type: 'string', description: 'PPPoE username' }
      },
      required: ['username']
    }
  },

  // 18. Audit Logs & System Overview
  {
    name: 'list_audit_logs',
    description: 'Query system audit activity logs (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'number', description: 'Filter by user ID' },
        action: { type: 'string', description: 'Filter by action' },
        search: { type: 'string', description: 'Search details or IP' },
        page: { type: 'number', description: 'Page number' },
        limit: { type: 'number', description: 'Limit' }
      }
    }
  },
  {
    name: 'get_dashboard_summary',
    description: 'Get high-level ISP network overview, subscriber totals, active counts, and stats (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        branchId: { type: 'number', description: 'Filter by branch ID' }
      }
    }
  },
  {
    name: 'get_isp_settings',
    description: 'Get ISP system configuration settings (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        ispId: { type: 'number', description: 'ISP ID (default 1)' }
      }
    }
  },
  {
    name: 'list_branch_requests',
    description: 'List branch transfer and material requests (Read-Only)',
    inputSchema: {
      type: 'object',
      properties: {
        branchId: { type: 'number', description: 'Filter by branch ID' },
        status: { type: 'string', description: 'Filter by status (pending, approved, rejected)' }
      }
    }
  }
];

// Tool call handler enforcing STRICT READ-ONLY querying
async function handleToolCall(name, args = {}) {
  const page = Math.max(1, Number(args.page || 1));
  const limit = Math.min(100, Math.max(1, Number(args.limit || 20)));
  const skip = (page - 1) * limit;

  const custModel = prisma.customer || prisma.Customer;
  const leadModel = prisma.lead || prisma.Lead;
  const oltModel = prisma.oLT || prisma.OLT;
  const splitterModel = prisma.splitter || prisma.Splitter;
  const tr069Model = prisma.tr069Device || prisma.Tr069Device;
  const ontModel = prisma.oNT || prisma.ONT;
  const ticketModel = prisma.ticket || prisma.Ticket;
  const taskModel = prisma.task || prisma.Task;
  const followupModel = prisma.followUp || prisma.FollowUp;
  const esewaModel = prisma.eSewaTokenPayment || prisma.ESewaTokenPayment;
  const svcCredModel = prisma.serviceCredential || prisma.ServiceCredential;
  const subModel = prisma.customerSubscription || prisma.CustomerSubscription;
  const yeastarExtModel = prisma.yeastarExtension || prisma.YeastarExtension;
  const yeastarTrunkModel = prisma.yeastarTrunk || prisma.YeastarTrunk;
  const yeastarCdrModel = prisma.yeastarCallLog || prisma.YeastarCallLog;
  const asteriskCallModel = prisma.asteriskCallLog || prisma.AsteriskCallLog;
  const invModel = prisma.inventoryItem || prisma.InventoryItem;
  const branchModel = prisma.branch || prisma.Branch;
  const userModel = prisma.user || prisma.User;
  const pkgPlanModel = prisma.packagePlan || prisma.PackagePlan;
  const pkgPriceModel = prisma.packagePrice || prisma.PackagePrice;
  const nasModel = prisma.nAS || prisma.NAS;
  const auditModel = prisma.auditLog || prisma.AuditLog;
  const settingModel = prisma.iSPSettings || prisma.ISPSettings;
  const drumModel = prisma.drum || prisma.Drum;
  const bulkInvModel = prisma.bulkInventory || prisma.BulkInventory;
  const branchReqModel = prisma.branchRequest || prisma.BranchRequest;

  switch (name) {
    // 1. Customer Management
    case 'list_customers': {
      const where = { isDeleted: false };
      if (args.branchId) where.branchId = Number(args.branchId);
      if (args.status) where.status = args.status;
      if (args.onboardStatus) where.onboardStatus = args.onboardStatus;
      if (args.oltId) {
        where.serviceDetails = { some: { oltId: Number(args.oltId) } };
      }
      if (args.splitterId) {
        where.serviceDetails = { some: { splitterId: Number(args.splitterId) } };
      }
      if (args.search) {
        where.OR = [
          { customerUniqueId: { contains: args.search } },
          { lead: { firstName: { contains: args.search } } },
          { lead: { lastName: { contains: args.search } } },
          { lead: { phoneNumber: { contains: args.search } } },
          { lead: { email: { contains: args.search } } },
          { connectionUsers: { some: { username: { contains: args.search }, isDeleted: false } } }
        ];
      }
      const [items, total] = await Promise.all([
        custModel.findMany({
          where,
          include: {
            lead: true,
            branch: { select: { id: true, name: true, code: true } },
            connectionUsers: { where: { isDeleted: false }, select: { username: true } },
            packagePrice: { include: { packagePlanDetails: true } },
            subscribedPkg: { include: { packagePlanDetails: true } }
          },
          skip,
          take: limit,
          orderBy: { id: 'desc' }
        }),
        custModel.count({ where })
      ]);

      const formatted = items.map(c => ({
        id: c.id,
        customerUniqueId: c.customerUniqueId,
        status: c.status,
        onboardStatus: c.onboardStatus,
        branch: c.branch?.name || null,
        name: `${c.lead?.firstName || ''} ${c.lead?.lastName || ''}`.trim(),
        phone: c.lead?.phoneNumber,
        email: c.lead?.email,
        username: c.connectionUsers?.[0]?.username || null,
        packageName: c.subscribedPkg?.packageName || c.packagePrice?.packageName || null,
        createdAt: c.createdAt
      }));

      return formatToolResult({ page, limit, total, totalPages: Math.ceil(total / limit), customers: formatted });
    }

    case 'get_customer_details': {
      if (!args.id && !args.customerUniqueId && !args.username && !args.phone && !args.search) {
        return formatToolResult('Please provide customer id, customerUniqueId, username, phone, or search term', true);
      }

      let where = { isDeleted: false };
      if (args.id) {
        where.id = Number(args.id);
      } else if (args.customerUniqueId) {
        where.customerUniqueId = String(args.customerUniqueId).trim();
      } else if (args.username) {
        const str = String(args.username).trim();
        where.OR = [
          { customerUniqueId: str },
          { connectionUsers: { some: { username: str, isDeleted: false } } },
          { portalUser: { email: str } },
          { lead: { email: str } },
          { lead: { phoneNumber: str } }
        ];
      } else if (args.phone) {
        const ph = String(args.phone).trim();
        where.OR = [
          { lead: { phoneNumber: ph } },
          { lead: { secondaryContactNumber: ph } }
        ];
      } else if (args.search) {
        const s = String(args.search).trim();
        const numericId = Number(s);
        where.OR = [
          ...(isNaN(numericId) ? [] : [{ id: numericId }]),
          { customerUniqueId: s },
          { connectionUsers: { some: { username: { contains: s }, isDeleted: false } } },
          { lead: { firstName: { contains: s } } },
          { lead: { lastName: { contains: s } } },
          { lead: { phoneNumber: { contains: s } } },
          { lead: { email: { contains: s } } }
        ];
      }

      const customer = await custModel.findFirst({
        where,
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
          subscribedApps: { include: { service: true } },
          customerType: true,
          branch: { select: { id: true, name: true, code: true } },
          subBranch: { select: { id: true, name: true } },
          orders: {
            where: { isActive: true, isDeleted: false },
            include: { items: true, packagePrice: { include: { packagePlanDetails: true } } },
            orderBy: { orderDate: 'desc' }
          },
          isp: { select: { companyName: true, phoneNumber: true, masterEmail: true } }
        }
      });

      if (!customer) return formatToolResult('Customer not found matching criteria', true);

      const enriched = await enrichCustomerFullDetails(prisma, customer);
      return formatToolResult(enriched);
    }

    case 'get_customer_radius_auth_logs': {
      let username = args.username;
      if (!username && args.customerId) {
        const cust = await custModel.findUnique({
          where: { id: Number(args.customerId) },
          include: { connectionUsers: { where: { isDeleted: false } } }
        });
        username = cust?.connectionUsers?.[0]?.username;
      }
      if (!username) return formatToolResult('Valid connection username or customerId required', true);

      let logs = [];
      if (ServiceFactory && SERVICE_CODES?.RADIUS) {
        const radiusClient = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, 1, prisma).catch(() => null);
        if (radiusClient) {
          logs = await radiusClient.getRadpostauthByUsername(username).catch(() => []);
        }
      }
      return formatToolResult({ username, totalLogs: logs.length, authLogs: logs.slice(skip, skip + limit) });
    }

    case 'get_customer_summary': {
      const where = { isDeleted: false };
      if (args.branchId) where.branchId = Number(args.branchId);

      const [total, active, expired, pending, suspended, free] = await Promise.all([
        custModel.count({ where }),
        custModel.count({ where: { ...where, status: 'active' } }),
        custModel.count({ where: { ...where, onboardStatus: 'expired_package' } }),
        custModel.count({ where: { ...where, status: 'pending' } }),
        custModel.count({ where: { ...where, status: 'suspended' } }),
        custModel.count({ where: { ...where, isFree: true } })
      ]);

      return formatToolResult({ summary: { total, active, expiredPackage: expired, pending, suspended, freeCustomers: free } });
    }

    // 2. Sales Leads
    case 'list_leads': {
      const where = { isDeleted: false };
      if (args.status) where.status = args.status;
      if (args.assignedUserId) where.assignedUserId = Number(args.assignedUserId);
      if (args.search) {
        where.OR = [
          { firstName: { contains: args.search } },
          { lastName: { contains: args.search } },
          { phoneNumber: { contains: args.search } },
          { email: { contains: args.search } },
          { address: { contains: args.search } }
        ];
      }
      const [items, total] = await Promise.all([
        leadModel.findMany({ where, skip, take: limit, orderBy: { id: 'desc' } }),
        leadModel.count({ where })
      ]);
      return formatToolResult({ page, limit, total, leads: items });
    }

    case 'get_lead_details': {
      const lead = await leadModel.findUnique({
        where: { id: Number(args.id) },
        include: { followups: true, customer: { select: { id: true, customerUniqueId: true, status: true } } }
      });
      if (!lead) return formatToolResult('Lead not found', true);
      return formatToolResult(lead);
    }

    // 3. Splitters
    case 'list_splitters': {
      const where = { isDeleted: false };
      if (args.oltId) where.oltId = Number(args.oltId);
      if (args.branchId) where.branchId = Number(args.branchId);
      if (args.search) where.name = { contains: args.search };
      const [items, total] = await Promise.all([
        splitterModel.findMany({ where, include: { olt: { select: { name: true } } }, skip, take: limit, orderBy: { id: 'desc' } }),
        splitterModel.count({ where })
      ]);
      return formatToolResult({ page, limit, total, splitters: items });
    }

    case 'get_splitter_details': {
      const splitter = await splitterModel.findUnique({
        where: { id: Number(args.id) },
        include: { olt: true, subSplitters: true, parentSplitter: true, customers: { select: { id: true, customerUniqueId: true } } }
      });
      if (!splitter) return formatToolResult('Splitter not found', true);
      return formatToolResult(splitter);
    }

    // 4. OLT Infrastructure
    case 'list_olts': {
      const where = { isDeleted: false };
      if (args.branchId) where.branchId = Number(args.branchId);
      if (args.search) {
        where.OR = [
          { name: { contains: args.search } },
          { ipAddress: { contains: args.search } }
        ];
      }
      const olts = await oltModel.findMany({
        where,
        select: { id: true, name: true, ipAddress: true, model: true, vendor: true, branchId: true, status: true, isActive: true }
      });
      return formatToolResult({ total: olts.length, olts });
    }

    case 'get_olt_details': {
      const olt = await oltModel.findUnique({
        where: { id: Number(args.id) },
        include: {
          serviceBoards: { include: { ports: true } },
          onts: { select: { id: true, serialNumber: true, ontId: true, servicePort: true } },
          splitters: { select: { id: true, name: true, totalPorts: true } }
        }
      });
      if (!olt) return formatToolResult('OLT not found', true);
      const { sshUsername, sshPassword, sshEnablePassword, sshKey, snmpCommunity, ...safeOlt } = olt;
      return formatToolResult(safeOlt);
    }

    case 'get_olt_vlans': {
      const vlanModel = prisma.oLTVLAN || prisma.OLTVLAN;
      if (!vlanModel) return formatToolResult({ vlans: [] });
      const where = {};
      if (args.oltId) where.oltId = Number(args.oltId);
      const vlans = await vlanModel.findMany({ where, orderBy: { vlanId: 'asc' } });
      return formatToolResult({ total: vlans.length, vlans });
    }

    case 'get_olt_pon_ports': {
      const olt = await oltModel.findUnique({
        where: { id: Number(args.oltId) },
        include: { serviceBoards: { include: { ports: true } } }
      });
      if (!olt) return formatToolResult('OLT not found', true);
      const ports = (olt.serviceBoards || []).flatMap(board => (board.ports || []).map(p => ({
        boardSlot: board.slotNumber,
        portNumber: p.portNumber,
        name: p.name || `0/${board.slotNumber}/${p.portNumber}`,
        totalSubscribers: p.usedSubscribers || 0,
        status: p.status || 'active'
      })));
      return formatToolResult({ oltId: olt.id, oltName: olt.name, totalPorts: ports.length, ports });
    }

    // 5. TR-069 / GenieACS Devices
    case 'list_tr069_devices': {
      const where = { isDeleted: false };
      if (args.status) where.status = args.status;
      if (args.search) {
        where.OR = [
          { serialNumber: { contains: args.search } },
          { manufacturer: { contains: args.search } },
          { modelName: { contains: args.search } },
          { ipAddress: { contains: args.search } }
        ];
      }
      const [items, total] = await Promise.all([
        tr069Model.findMany({ where, skip, take: limit, orderBy: { updatedAt: 'desc' } }),
        tr069Model.count({ where })
      ]);
      return formatToolResult({ page, limit, total, devices: items });
    }

    case 'get_tr069_device_details': {
      const device = await tr069Model.findFirst({
        where: { serialNumber: String(args.serialNumber).trim(), isDeleted: false }
      });
      if (!device) return formatToolResult('TR069 device not found in database', true);

      let genieInfo = null;
      if (ServiceFactory && SERVICE_CODES?.GENIEACS) {
        const genieClient = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, device.ispId || 1, prisma).catch(() => null);
        if (genieClient) {
          genieInfo = await genieClient.getDeviceBySerial(device.serialNumber).catch(() => null);
        }
      }

      return formatToolResult({ dbRecord: device, genieacsLiveInfo: genieInfo });
    }

    // 6. ONT & Optical Power
    case 'list_onts': {
      const where = { isDeleted: false };
      if (args.oltId) where.oltId = Number(args.oltId);
      if (args.search) {
        where.OR = [
          { serialNumber: { contains: args.search } },
          { macAddress: { contains: args.search } },
          { description: { contains: args.search } }
        ];
      }
      const [items, total] = await Promise.all([
        ontModel.findMany({ where, include: { ontDetails: true }, skip, take: limit }),
        ontModel.count({ where })
      ]);
      return formatToolResult({ page, limit, total, onts: items });
    }

    case 'get_ont_details': {
      const ont = await ontModel.findFirst({
        where: {
          ...(args.id ? { id: Number(args.id) } : {}),
          ...(args.serialNumber ? { serialNumber: String(args.serialNumber).trim() } : {}),
          isDeleted: false
        },
        include: { ontDetails: true, olt: { select: { id: true, name: true, ipAddress: true } } }
      });
      if (!ont) return formatToolResult('ONT not found', true);
      return formatToolResult(ont);
    }

    case 'get_olt_optical_power': {
      const ont = await ontModel.findFirst({
        where: {
          ...(args.id ? { id: Number(args.id) } : {}),
          ...(args.serialNumber ? { serialNumber: String(args.serialNumber).trim() } : {}),
          isDeleted: false
        },
        include: { ontDetails: true }
      });
      if (!ont) return formatToolResult('ONT record not found', true);
      const optical = ont.ontDetails?.opticalDiagnostics || null;
      return formatToolResult({ serialNumber: ont.serialNumber, ontId: ont.ontId, servicePort: ont.servicePort, opticalDiagnostics: optical });
    }

    case 'list_low_power_onts': {
      const threshold = Number(args.thresholdDbm || -27.0);
      const where = { isDeleted: false };
      if (args.oltId) where.oltId = Number(args.oltId);
      const onts = await ontModel.findMany({
        where,
        include: { ontDetails: true, olt: { select: { id: true, name: true } } }
      });
      const lowPowerOnts = onts.filter(o => {
        const rx = parseFloat(o.ontDetails?.rxPower || o.ontDetails?.opticalDiagnostics?.rxPower || 0);
        return rx < 0 && rx <= threshold;
      });
      return formatToolResult({ thresholdDbm: threshold, count: lowPowerOnts.length, onts: lowPowerOnts });
    }

    // 7. Support Tickets
    case 'list_tickets': {
      const where = { isDeleted: false };
      if (args.status) where.status = args.status;
      if (args.priority) where.priority = args.priority;
      if (args.search) {
        where.OR = [
          { ticketNumber: { contains: args.search } },
          { subject: { contains: args.search } }
        ];
      }
      const [items, total] = await Promise.all([
        ticketModel.findMany({
          where,
          include: { customer: { select: { id: true, customerUniqueId: true } } },
          skip,
          take: limit,
          orderBy: { id: 'desc' }
        }),
        ticketModel.count({ where })
      ]);
      return formatToolResult({ page, limit, total, tickets: items });
    }

    case 'get_ticket_details': {
      const ticket = await ticketModel.findUnique({
        where: { id: Number(args.id) },
        include: {
          customer: true,
          assignedUser: { select: { id: true, name: true, email: true } },
          comments: { include: { user: { select: { name: true } } } }
        }
      });
      if (!ticket) return formatToolResult('Ticket not found', true);
      return formatToolResult(ticket);
    }

    // 8. Tasks
    case 'list_tasks': {
      const where = {};
      if (args.status) where.status = args.status;
      if (args.assignedUserId) where.assignedToId = Number(args.assignedUserId);
      if (args.search) where.title = { contains: args.search };
      const [items, total] = await Promise.all([
        taskModel.findMany({ where, skip, take: limit, orderBy: { id: 'desc' } }),
        taskModel.count({ where })
      ]);
      return formatToolResult({ page, limit, total, tasks: items });
    }

    case 'get_task_details': {
      const task = await taskModel.findUnique({
        where: { id: Number(args.id) },
        include: {
          assignedTo: { select: { id: true, name: true, email: true } },
          customer: true,
          taskActivityLogs: true
        }
      });
      if (!task) return formatToolResult('Task not found', true);
      return formatToolResult(task);
    }

    // 9. Follow-ups
    case 'list_followups': {
      const where = {};
      if (args.leadId) where.leadId = Number(args.leadId);
      if (args.customerId) where.customerId = Number(args.customerId);
      if (args.status) where.status = args.status;
      const [items, total] = await Promise.all([
        followupModel.findMany({ where, skip, take: limit, orderBy: { id: 'desc' } }),
        followupModel.count({ where })
      ]);
      return formatToolResult({ page, limit, total, followups: items });
    }

    case 'get_followup_details': {
      const followup = await followupModel.findUnique({
        where: { id: Number(args.id) },
        include: { lead: true, customer: true }
      });
      if (!followup) return formatToolResult('Followup not found', true);
      return formatToolResult(followup);
    }

    // 10. eSewa Payments
    case 'list_esewa_transactions': {
      const where = {};
      if (args.status) where.status = args.status;
      if (args.search) where.transactionRef = { contains: args.search };
      const [items, total] = await Promise.all([
        esewaModel.findMany({ where, include: { customer: { select: { customerUniqueId: true } } }, skip, take: limit, orderBy: { id: 'desc' } }),
        esewaModel.count({ where })
      ]);
      return formatToolResult({ page, limit, total, transactions: items });
    }

    case 'get_esewa_transaction_details': {
      const payment = await esewaModel.findFirst({
        where: {
          ...(args.id ? { id: Number(args.id) } : {}),
          ...(args.transactionRef ? { transactionRef: String(args.transactionRef) } : {})
        },
        include: { customer: true }
      });
      if (!payment) return formatToolResult('eSewa payment transaction not found', true);
      return formatToolResult(payment);
    }

    // 11. External Services
    case 'list_external_services': {
      const services = await svcCredModel.findMany({});
      return formatToolResult({ total: services.length, services });
    }

    case 'get_external_service_details': {
      const service = await svcCredModel.findFirst({
        where: {
          OR: [
            { key: String(args.serviceCode || '') },
            { value: { contains: String(args.serviceCode || '') } }
          ]
        }
      });
      if (!service) return formatToolResult('External service credential not found', true);
      return formatToolResult(service);
    }

    // 12. Billing & Orders
    case 'list_billing_invoices': {
      const orderModel = prisma.customerOrderManagement || prisma.CustomerOrderManagement;
      if (!orderModel) return formatToolResult({ invoices: [] });
      const where = { isDeleted: false };
      if (args.customerId) where.customerId = Number(args.customerId);
      if (args.status === 'paid') where.isPaid = true;
      if (args.status === 'unpaid') where.isPaid = false;
      const [items, total] = await Promise.all([
        orderModel.findMany({
          where,
          include: { items: true, packagePrice: true, customer: { select: { customerUniqueId: true } } },
          skip,
          take: limit,
          orderBy: { id: 'desc' }
        }),
        orderModel.count({ where })
      ]);
      return formatToolResult({ page, limit, total, invoices: items });
    }

    case 'get_billing_invoice_details': {
      const orderModel = prisma.customerOrderManagement || prisma.CustomerOrderManagement;
      const order = orderModel ? await orderModel.findUnique({
        where: { id: Number(args.id) },
        include: { items: true, packagePrice: { include: { packagePlanDetails: true } }, customer: true }
      }) : null;
      if (!order) return formatToolResult('Invoice / Order record not found', true);
      return formatToolResult(order);
    }

    case 'list_payments': {
      const where = {};
      if (args.customerId) where.customerId = Number(args.customerId);
      const [items, total] = await Promise.all([
        esewaModel.findMany({ where, skip, take: limit, orderBy: { id: 'desc' } }),
        esewaModel.count({ where })
      ]);
      return formatToolResult({ page, limit, total, payments: items });
    }

    case 'list_package_plans': {
      const where = { isDeleted: false };
      if (args.search) {
        where.OR = [
          { planName: { contains: args.search } },
          { planCode: { contains: args.search } }
        ];
      }
      const plans = await pkgPlanModel.findMany({
        where,
        include: { packagePlanDetails: true },
        orderBy: { id: 'asc' }
      });
      return formatToolResult({ total: plans.length, plans });
    }

    // 13. Yeastar PBX
    case 'list_yeastar_extensions': {
      const extensions = await yeastarExtModel.findMany({ orderBy: { extensionNumber: 'asc' } });
      return formatToolResult({ count: extensions.length, extensions });
    }

    case 'list_yeastar_trunks': {
      const trunks = await yeastarTrunkModel.findMany({ orderBy: { id: 'asc' } });
      return formatToolResult({ count: trunks.length, trunks });
    }

    case 'list_yeastar_cdrs': {
      const where = {};
      if (args.search) {
        where.OR = [
          { src: { contains: args.search } },
          { dst: { contains: args.search } }
        ];
      }
      const [items, total] = await Promise.all([
        yeastarCdrModel.findMany({ where, skip, take: limit, orderBy: { id: 'desc' } }),
        yeastarCdrModel.count({ where })
      ]);
      return formatToolResult({ page, limit, total, cdrs: items });
    }

    // 14. Asterisk PBX
    case 'list_asterisk_call_logs': {
      const where = {};
      if (args.search) {
        where.OR = [
          { caller: { contains: args.search } },
          { callee: { contains: args.search } }
        ];
      }
      const [items, total] = await Promise.all([
        asteriskCallModel.findMany({ where, skip, take: limit, orderBy: { id: 'desc' } }),
        asteriskCallModel.count({ where })
      ]);
      return formatToolResult({ page, limit, total, callLogs: items });
    }

    case 'get_asterisk_status': {
      const statusModel = prisma.asteriskSystemStatus || prisma.AsteriskSystemStatus;
      const config = statusModel ? await statusModel.findFirst({}) : null;
      return formatToolResult({
        service: 'ASTERISK',
        configured: Boolean(config),
        status: config?.status || 'HEALTHY',
        lastSync: config?.updatedAt || null
      });
    }

    // 15. Inventory & Assets
    case 'list_inventory_items': {
      const where = {};
      if (args.type) where.type = args.type;
      if (args.status) where.status = args.status;
      if (args.branchId) where.branchId = Number(args.branchId);
      if (args.search) {
        where.OR = [
          { serialNumber: { contains: args.search } },
          { ponSerialNumber: { contains: args.search } },
          { macAddress: { contains: args.search } },
          { name: { contains: args.search } }
        ];
      }
      const [items, total] = await Promise.all([
        invModel.findMany({ where, skip, take: limit, orderBy: { id: 'desc' } }),
        invModel.count({ where })
      ]);
      return formatToolResult({ page, limit, total, items });
    }

    case 'get_inventory_item_details': {
      const item = await invModel.findFirst({
        where: {
          ...(args.id ? { id: Number(args.id) } : {}),
          ...(args.serialNumber ? { serialNumber: String(args.serialNumber).trim() } : {})
        },
        include: { customer: true, branch: true, logs: { orderBy: { id: 'desc' }, take: 10 } }
      });
      if (!item) return formatToolResult('Inventory item not found', true);
      return formatToolResult(item);
    }

    case 'get_inventory_lifecycle': {
      const item = await invModel.findFirst({
        where: {
          ...(args.inventoryItemId ? { id: Number(args.inventoryItemId) } : {}),
          ...(args.serialNumber ? { serialNumber: String(args.serialNumber).trim() } : {})
        },
        include: { logs: { orderBy: { id: 'desc' } } }
      });
      if (!item) return formatToolResult('Inventory item not found', true);
      return formatToolResult({ item: { id: item.id, name: item.name, serialNumber: item.serialNumber, status: item.status }, logs: item.logs });
    }

    case 'list_drums': {
      if (!drumModel) return formatToolResult({ drums: [] });
      const drums = await drumModel.findMany({ orderBy: { id: 'desc' }, take: limit });
      return formatToolResult({ total: drums.length, drums });
    }

    case 'list_bulk_inventories': {
      if (!bulkInvModel) return formatToolResult({ bulkItems: [] });
      const items = await bulkInvModel.findMany({ orderBy: { id: 'desc' }, take: limit });
      return formatToolResult({ total: items.length, bulkItems: items });
    }

    // 16. Branches & Staff Users
    case 'list_branches': {
      const where = { isDeleted: false };
      if (args.search) {
        where.OR = [
          { name: { contains: args.search } },
          { code: { contains: args.search } }
        ];
      }
      const branches = await branchModel.findMany({
        where,
        select: { id: true, name: true, code: true, email: true, phoneNumber: true, city: true, isActive: true },
        orderBy: { id: 'asc' }
      });
      return formatToolResult({ total: branches.length, branches });
    }

    case 'get_branch_details': {
      const branch = await branchModel.findUnique({
        where: { id: Number(args.id) },
        include: {
          subBranches: { select: { id: true, name: true } },
          _count: { select: { customers: true, olts: true, splitters: true, users: true } }
        }
      });
      if (!branch) return formatToolResult('Branch not found', true);
      return formatToolResult(branch);
    }

    case 'list_staff_users': {
      const where = { isDeleted: false };
      if (args.branchId) where.branchId = Number(args.branchId);
      if (args.search) {
        where.OR = [
          { name: { contains: args.search } },
          { email: { contains: args.search } }
        ];
      }
      const users = await userModel.findMany({
        where,
        select: { id: true, name: true, email: true, status: true, branchId: true, roleId: true, role: { select: { name: true } } },
        take: limit
      });
      return formatToolResult({ total: users.length, users });
    }

    // 17. NAS Routers & Active RADIUS Sessions
    case 'list_nas_devices': {
      if (!nasModel) return formatToolResult({ nasDevices: [] });
      const devices = await nasModel.findMany({ orderBy: { id: 'asc' } });
      return formatToolResult({ total: devices.length, nasDevices: devices });
    }

    case 'list_active_radius_sessions': {
      let sessions = [];
      if (ServiceFactory && SERVICE_CODES?.RADIUS) {
        const radiusClient = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, 1, prisma).catch(() => null);
        if (radiusClient) {
          sessions = await radiusClient.getRadacctByUsername(args.search || '').catch(() => []);
        }
      }
      return formatToolResult({ totalSessions: sessions.length, sessions: sessions.slice(skip, skip + limit) });
    }

    case 'get_radius_session_user': {
      let sessions = [];
      if (ServiceFactory && SERVICE_CODES?.RADIUS) {
        const radiusClient = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, 1, prisma).catch(() => null);
        if (radiusClient) {
          sessions = await radiusClient.getRadacctByUsername(args.username).catch(() => []);
        }
      }
      const activeSession = sessions.find(s => !s.acctstoptime || s.acctstoptime === '0000-00-00 00:00:00') || sessions[0] || null;
      return formatToolResult({ username: args.username, activeSession });
    }

    // 18. Audit Logs & System Overview
    case 'list_audit_logs': {
      const where = {};
      if (args.userId) where.userId = Number(args.userId);
      if (args.action) where.action = args.action;
      if (args.search) where.details = { contains: args.search };

      if (!auditModel) return formatToolResult({ logs: [] });

      const [items, total] = await Promise.all([
        auditModel.findMany({ where, skip, take: limit, orderBy: { id: 'desc' } }),
        auditModel.count({ where })
      ]);
      return formatToolResult({ page, limit, total, logs: items });
    }

    case 'get_dashboard_summary': {
      const where = { isDeleted: false };
      if (args.branchId) where.branchId = Number(args.branchId);

      const [totalCustomers, activeCustomers, totalOlts, totalSplitters, openTickets, pendingTasks] = await Promise.all([
        custModel.count({ where }).catch(() => 0),
        custModel.count({ where: { ...where, status: 'active' } }).catch(() => 0),
        oltModel ? oltModel.count({ where: { isDeleted: false } }).catch(() => 0) : 0,
        splitterModel ? splitterModel.count({ where: { isDeleted: false } }).catch(() => 0) : 0,
        ticketModel ? ticketModel.count({ where: { status: 'open', isDeleted: false } }).catch(() => 0) : 0,
        taskModel ? taskModel.count({ where: { status: 'pending' } }).catch(() => 0) : 0
      ]);

      return formatToolResult({
        dashboard: {
          totalCustomers,
          activeCustomers,
          totalOlts,
          totalSplitters,
          openTickets,
          pendingTasks
        }
      });
    }

    case 'get_isp_settings': {
      if (!settingModel) return formatToolResult({ settings: [] });
      const settings = await settingModel.findMany({ where: { ispId: Number(args.ispId || 1) } });
      return formatToolResult({ count: settings.length, settings });
    }

    case 'list_branch_requests': {
      if (!branchReqModel) return formatToolResult({ requests: [] });
      const where = {};
      if (args.branchId) where.branchId = Number(args.branchId);
      if (args.status) where.status = args.status;
      const requests = await branchReqModel.findMany({ where, orderBy: { id: 'desc' } });
      return formatToolResult({ total: requests.length, requests });
    }

    default:
      return formatToolResult(`Unknown tool: ${name}`, true);
  }
}

// Function to create an McpServer instance
function createMcpServer() {
  const server = new Server(
    {
      name: 'kisan-isp-mcp-server',
      version: '1.0.0'
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  // Register tools list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: READ_ONLY_TOOLS
    };
  });

  // Register tool call handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      return await handleToolCall(name, args);
    } catch (error) {
      return formatToolResult(`Error executing ${name}: ${error.message}`, true);
    }
  });

  return server;
}

// Stdio runner for standalone execution
async function runStdioServer() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Kisan ISP Read-Only MCP Server running via stdio...');
}

// Run as CLI if directly executed
if (require.main === module) {
  runStdioServer().catch(err => {
    console.error('Fatal MCP Server error:', err);
    process.exit(1);
  });
}

module.exports = {
  createMcpServer,
  runStdioServer,
  READ_ONLY_TOOLS,
  handleToolCall
};
