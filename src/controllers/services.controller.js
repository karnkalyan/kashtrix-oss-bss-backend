const { ServiceFactory } = require('../lib/clients/ServiceFactory');
const { SERVICE_CODES, SERVICE_CATEGORIES, DEFAULT_CREDENTIALS } = require('../lib/serviceConstants');
const QRCode = require('qrcode');
const { getCachedGenieACSResponse, setCachedGenieACSResponse, invalidateGenieACSResponseCache } = require('../lib/genieacsResponseCache');

const smsCampaignQueue = {
  processing: false,
  nextTimer: null
};

const SMS_CAMPAIGN_BATCH_SIZE = Number(process.env.SMS_CAMPAIGN_BATCH_SIZE || 100);
const SMS_CAMPAIGN_BATCH_DELAY_MS = Number(process.env.SMS_CAMPAIGN_BATCH_DELAY_MS || 1000);

function normalizePhone(phone) {
  if (!phone) return null;
  let cleaned = String(phone).replace(/\D/g, '').trim();
  if (cleaned.length === 13 && cleaned.startsWith('977')) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.length === 10 && cleaned.startsWith('9')) {
    return cleaned;
  }
  return null;
}

function getSsidIndexFromInstance(instance, fallback = 1) {
  const match = String(instance || '').match(/WLANConfiguration\.(\d+)|WiFi\.SSID\.(\d+)|WiFi\.AccessPoint\.(\d+)/);
  return Number(match?.[1] || match?.[2] || match?.[3] || fallback || 1);
}

function firstMeaningful(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '' && value !== 'N/A');
}

function extractWifiPassword(ssid) {
  const params = ssid?.parameters || {};
  const security = ssid?.security || {};
  return firstMeaningful(
    ssid?.keyPassphrase,
    ssid?.KeyPassphrase,
    ssid?.preSharedKey,
    ssid?.PreSharedKey,
    security?.keyPassphrase,
    security?.KeyPassphrase,
    security?.preSharedKey,
    security?.PreSharedKey,
    params.X_CMS_KeyPassphrase,
    params.KeyPassphrase,
    params['PreSharedKey.1.KeyPassphrase'],
    params['InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.PreSharedKey.1.KeyPassphrase'],
    params['Device.WiFi.AccessPoint.1.Security.KeyPassphrase'],
    params['Security.KeyPassphrase']
  ) || '';
}

function escapeWifiQrValue(value) {
  return String(value || '').replace(/([\\;,:"])/g, '\\$1');
}

function buildWifiQrPayload(ssidName, password) {
  return `WIFI:T:WPA;S:${escapeWifiQrValue(ssidName)};P:${escapeWifiQrValue(password)};;`;
}

class ServiceController {
  constructor(prisma) {
    this.prisma = prisma;
    this.scheduleSmsCampaignProcessing(2000);
  }

  async getServiceLogs(req, res, next) {
    try {
      const { serviceCode, status, page = 1, limit = 50 } = req.query;
      const skip = (Number(page) - 1) * Number(limit);
      const take = Number(limit);

      const where = {
        ispId: req.ispId,
      };

      if (serviceCode && serviceCode !== 'all') {
        where.serviceCode = serviceCode.toUpperCase();
      }

      if (status && status !== 'all') {
        where.status = status.toLowerCase();
      }

      const [logs, total] = await Promise.all([
        this.prisma.serviceLog.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take,
        }),
        this.prisma.serviceLog.count({ where }),
      ]);

      return res.json({
        success: true,
        data: logs,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          totalPages: Math.ceil(total / Number(limit)),
        },
      });
    } catch (error) {
      next(error);
    }
  }

  async findCustomerForSerial(serialNumber, req) {
    if (req?.customerProfile) return req.customerProfile;
    if (!this.prisma || !serialNumber) return null;
    return this.prisma.customer.findFirst({
      where: {
        ispId: req?.ispId,
        isDeleted: false,
        OR: [
          { devices: { some: { serialNumber } } },
          { devices: { some: { ponSerial: serialNumber } } }
        ]
      },
      include: {
        wifiCredentials: true
      }
    });
  }

  async syncWifiCredentialsForCustomer(customer, serialNumber, ssidList) {
    if (!this.prisma || !customer || !Array.isArray(ssidList)) return [];
    const synced = [];

    for (const ssid of ssidList) {
      const ssidIndex = getSsidIndexFromInstance(ssid.instance, ssid.index);
      const ssidName = ssid.ssid || ssid.SSID || ssid.parameters?.SSID || null;
      const password = extractWifiPassword(ssid);
      if (!ssidName && !password) continue;

      const credential = await this.prisma.customerWiFiCredential.upsert({
        where: {
          customerId_serialNumber_ssidIndex: {
            customerId: customer.id,
            serialNumber,
            ssidIndex
          }
        },
        update: {
          instance: ssid.instance || null,
          ssidName,
          ...(password ? { password } : {}),
          source: 'genieacs',
          ispId: customer.ispId,
          lastSyncedAt: new Date()
        },
        create: {
          customerId: customer.id,
          ispId: customer.ispId,
          serialNumber,
          ssidIndex,
          instance: ssid.instance || null,
          ssidName,
          password: password || null,
          source: 'genieacs',
          lastSyncedAt: new Date()
        }
      });
      synced.push(credential);
    }

    return synced;
  }

  async attachStoredWifiCredentials(customer, serialNumber, ssidList) {
    if (!this.prisma || !customer || !Array.isArray(ssidList)) return ssidList;
    const credentials = await this.prisma.customerWiFiCredential.findMany({
      where: { customerId: customer.id, serialNumber },
    });
    const byIndex = new Map(credentials.map((item) => [item.ssidIndex, item]));

    return Promise.all(ssidList.map(async (ssid) => {
      const ssidIndex = getSsidIndexFromInstance(ssid.instance, ssid.index);
      const stored = byIndex.get(ssidIndex);
      const password = stored?.password || '';
      const ssidName = stored?.ssidName || ssid.ssid || ssid.SSID || '';
      const qrPayload = password ? buildWifiQrPayload(ssidName, password) : '';
      const qrCodeDataUrl = qrPayload ? await QRCode.toDataURL(qrPayload, { margin: 1, width: 220 }) : null;
      return {
        ...ssid,
        ssidIndex,
        ssid: ssidName || ssid.ssid,
        keyPassphrase: password,
        passwordSource: stored ? 'database' : 'none',
        qrPayload,
        qrCodeDataUrl
      };
    }));
  }

  sendGenieACSError(res, error, fallbackError = 'GenieACS request failed') {
    const message = error?.message || fallbackError;
    const notFoundMatch = message.match(/Device with serial\s+(.+?)\s+not found/i);

    if (notFoundMatch) {
      return res.status(404).json({
        success: false,
        error: 'Device not found',
        message: `Device with serial ${notFoundMatch[1]} not found in GenieACS`
      });
    }

    return res.status(500).json({
      success: false,
      error: fallbackError,
      message
    });
  }

  // ==================== SERVICE CATALOG ====================
  async getAllServices(req, res) {
    try {
      const { category, search, isActive } = req.query;

      const where = {
        isDeleted: false
      };

      if (category && Object.values(SERVICE_CATEGORIES).includes(category)) {
        where.category = category;
      }

      if (search) {
        where.OR = [
          { name: { contains: search } },
          { code: { contains: search } },
          { description: { contains: search } }
        ];
      }

      if (isActive !== undefined) {
        where.isActive = isActive === 'true';
      }

      const services = await this.prisma.service.findMany({
        where,
        orderBy: [{ category: 'asc' }, { name: 'asc' }],
        include: {
          _count: {
            select: { ispServices: true }
          }
        }
      });

      return res.json({
        success: true,
        data: services,
        meta: {
          total: services.length,
          categories: Object.values(SERVICE_CATEGORIES)
        }
      });
    } catch (error) {
      console.error('Error fetching services:', error);
      return res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: error.message
      });
    }
  }

  async getServiceByCode(req, res) {
    try {
      const { code } = req.params;
      const service = await this.prisma.service.findUnique({
        where: { code: code.toUpperCase(), isDeleted: false },
        include: { _count: { select: { ispServices: true } } }
      });

      if (!service) {
        return res.status(404).json({ success: false, error: 'Service not found' });
      }

      const defaultCredentials = DEFAULT_CREDENTIALS[code] || [];
      return res.json({
        success: true,
        data: { ...service, defaultCredentials }
      });
    } catch (error) {
      console.error('Error fetching service:', error);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  // ==================== ISP SERVICE MANAGEMENT ====================
  async getISPActiveServices(req, res) {
    try {
      const ispId = req.ispId;
      const { includeInactive } = req.query;

      if (!ispId) {
        return res.status(400).json({
          success: false,
          error: 'ISP ID not found in request.'
        });
      }

      const where = { ispId, isDeleted: false, isEnabled: true };
      if (includeInactive !== 'true') where.isActive = true;

      const ispServices = await this.prisma.iSPService.findMany({
        where,
        include: {
          service: {
            select: { id: true, name: true, code: true, description: true, iconUrl: true, category: true }
          },
          credentials: {
            where: { isActive: true, isDeleted: false },
            select: { id: true, credentialType: true, key: true, value: true, label: true, isEncrypted: true, description: true, createdAt: true }
          }
        }
      });

      // Sort in memory to avoid Prisma nested relation sorting compatibility issues
      ispServices.sort((a, b) => {
        const nameA = a.service?.name || '';
        const nameB = b.service?.name || '';
        return nameA.localeCompare(nameB);
      });

      const transformedServices = ispServices.map(ispService => ({
        ...ispService,
        service: ispService.service,
        credentials: ispService.credentials.map(cred => ({
          ...cred,
          value: cred.isEncrypted ? '***ENCRYPTED***' : cred.value
        })),
        credentialCount: ispService.credentials.length
      }));

      return res.json({
        success: true,
        data: transformedServices,
        meta: {
          total: transformedServices.length,
          active: transformedServices.filter(s => s.isActive).length
        }
      });
    } catch (error) {
      console.error('Error fetching ISP services:', error);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  async configureServiceForISP(req, res) {
    try {
      const ispId = req.ispId;
      const { serviceCode, apiVersion, isActive } = req.body;
      let { baseUrl, config } = req.body;

      if (!ispId) {
        return res.status(400).json({ success: false, error: 'ISP ID not found in request.' });
      }

      if (!serviceCode) {
        return res.status(400).json({ success: false, error: 'Service code is required' });
      }

      if (!Object.values(SERVICE_CODES).includes(serviceCode)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid service code',
          validCodes: Object.values(SERVICE_CODES)
        });
      }

      const service = await this.prisma.service.findUnique({
        where: { code: serviceCode, isDeleted: false, isActive: true }
      });

      if (!service) {
        return res.status(404).json({ success: false, error: 'Service not found or inactive' });
      }

      const existing = await this.prisma.iSPService.findUnique({
        where: { ispId_serviceId: { ispId, serviceId: service.id } }
      });

      // If service is an SMS service and is marked as default, unmark other SMS services
      if ((serviceCode === SERVICE_CODES.AAKASHSMS || serviceCode === SERVICE_CODES.SPARROWSMS) && config && config.isDefault === true) {
        const otherCode = serviceCode === SERVICE_CODES.AAKASHSMS ? SERVICE_CODES.SPARROWSMS : SERVICE_CODES.AAKASHSMS;
        const otherService = await this.prisma.service.findUnique({
          where: { code: otherCode }
        });
        if (otherService) {
          const otherIspService = await this.prisma.iSPService.findUnique({
            where: { ispId_serviceId: { ispId, serviceId: otherService.id } }
          });
          if (otherIspService) {
            const otherConfig = otherIspService.config && typeof otherIspService.config === 'object' ? otherIspService.config : {};
            otherConfig.isDefault = false;
            await this.prisma.iSPService.update({
              where: { id: otherIspService.id },
              data: { config: otherConfig }
            });
          }
        }
      }

      // If service is a VOIP service and is marked as default, unmark other VOIP services
      if ((serviceCode === SERVICE_CODES.YEASTAR || serviceCode === SERVICE_CODES.ASTERISK) && config && config.isDefault === true) {
        const otherCode = serviceCode === SERVICE_CODES.YEASTAR ? SERVICE_CODES.ASTERISK : SERVICE_CODES.YEASTAR;
        const otherService = await this.prisma.service.findUnique({
          where: { code: otherCode }
        });
        if (otherService) {
          const otherIspService = await this.prisma.iSPService.findUnique({
            where: { ispId_serviceId: { ispId, serviceId: otherService.id } }
          });
          if (otherIspService) {
            const otherConfig = otherIspService.config && typeof otherIspService.config === 'object' ? otherIspService.config : {};
            otherConfig.isDefault = false;
            await this.prisma.iSPService.update({
              where: { id: otherIspService.id },
              data: { config: otherConfig }
            });
          }
        }
      }

      // If service is a Billing service and is marked as default, unmark other Billing services
      if ((serviceCode === SERVICE_CODES.TSHUL || serviceCode === SERVICE_CODES.NEPURIX) && config && config.isDefault === true) {
        const otherCode = serviceCode === SERVICE_CODES.TSHUL ? SERVICE_CODES.NEPURIX : SERVICE_CODES.TSHUL;
        const otherService = await this.prisma.service.findUnique({
          where: { code: otherCode }
        });
        if (otherService) {
          const otherIspService = await this.prisma.iSPService.findUnique({
            where: { ispId_serviceId: { ispId, serviceId: otherService.id } }
          });
          if (otherIspService) {
            const otherConfig = otherIspService.config && typeof otherIspService.config === 'object' ? otherIspService.config : {};
            otherConfig.isDefault = false;
            await this.prisma.iSPService.update({
              where: { id: otherIspService.id },
              data: { config: otherConfig }
            });
          }
        }
      }

      let result;
      if (existing) {
        result = await this.prisma.iSPService.update({
          where: { id: existing.id },
          data: {
            isActive: isActive !== undefined ? isActive : existing.isActive,
            baseUrl: baseUrl || existing.baseUrl,
            apiVersion: apiVersion || existing.apiVersion,
            config: config || existing.config,
            updatedAt: new Date()
          },
          include: { service: true }
        });
      } else {
        result = await this.prisma.iSPService.create({
          data: {
            ispId,
            serviceId: service.id,
            isActive: isActive !== undefined ? isActive : true,
            baseUrl,
            apiVersion,
            config
          },
          include: { service: true }
        });
      }

      // Keep credential rows synchronized with values entered in every external
      // service's JSON. Use catalog metadata where available, but also persist
      // provider-specific keys that only exist in default/demoCredentials.
      const defaultCreds = DEFAULT_CREDENTIALS[serviceCode] || [];
      const parsedConfig = typeof result.config === 'string' ? JSON.parse(result.config) : (result.config || {});
      const configuredCredentials = parsedConfig?.defaultCredentials || parsedConfig?.demoCredentials || {};
      const credentialDefinitions = new Map(defaultCreds.map(credential => [credential.key, credential]));
      for (const key of Object.keys(configuredCredentials)) {
        if (!credentialDefinitions.has(key)) {
          credentialDefinitions.set(key, {
            key,
            label: key.replace(/_/g, ' ').replace(/\b\w/g, character => character.toUpperCase()),
            credentialType: /user(name)?|password|secret/i.test(key) ? 'username_password' : 'api_key',
            isEncrypted: /password|secret|token|api[_-]?key/i.test(key)
          });
        }
      }
      if (!credentialDefinitions.has('base_url') && result.baseUrl) {
        credentialDefinitions.set('base_url', { key: 'base_url', label: 'Base URL', credentialType: 'api_key', isEncrypted: false });
      }
      for (const credential of credentialDefinitions.values()) {
        const value = credential.key === 'base_url' ? result.baseUrl : configuredCredentials[credential.key];
        if (value === undefined || value === null || String(value).trim() === '') continue;
        await this.prisma.serviceCredential.upsert({
          where: { ispServiceId_key: { ispServiceId: result.id, key: credential.key } },
          update: { value: String(value), credentialType: credential.credentialType || 'api_key', label: credential.label || credential.key, isEncrypted: credential.isEncrypted !== false, isActive: true, isDeleted: false },
          create: { ispServiceId: result.id, credentialType: credential.credentialType || 'api_key', key: credential.key, value: String(value), label: credential.label || credential.key, isEncrypted: credential.isEncrypted !== false, isActive: true, isDeleted: false }
        });
      }

      return res.json({
        success: true,
        message: existing ? 'Service configuration updated' : 'Service enabled successfully',
        data: result
      });
    } catch (error) {
      console.error('Error configuring service:', error);
      return res.status(500).json({ success: false, error: 'Internal server error', message: error.message });
    }
  }

  async setServiceCredentials(req, res) {
    try {
      const ispId = req.ispId;
      const { serviceCode } = req.params;
      const { credentials } = req.body;

      if (!ispId) {
        return res.status(400).json({ success: false, error: 'ISP ID not found in request.' });
      }

      if (!Array.isArray(credentials)) {
        return res.status(400).json({ success: false, error: 'Credentials must be an array' });
      }

      const ispService = await this.prisma.iSPService.findFirst({
        where: { ispId, service: { code: serviceCode }, isDeleted: false }
      });

      if (!ispService) {
        return res.status(404).json({ success: false, error: 'Service not configured for this ISP' });
      }

      const defaultCreds = DEFAULT_CREDENTIALS[serviceCode] || [];
      const requiredKeys = defaultCreds.filter(c => c.required !== false).map(c => c.key);
      const providedKeys = credentials.map(c => c.key);
      const missingKeys = requiredKeys.filter(key => !providedKeys.includes(key));

      if (missingKeys.length > 0) {
        return res.status(400).json({
          success: false,
          error: 'Missing required credentials',
          missingKeys
        });
      }

      // Check for duplicate keys in the provided credentials
      const keyCount = {};
      const duplicateKeys = [];

      for (const cred of credentials) {
        if (keyCount[cred.key]) {
          duplicateKeys.push(cred.key);
        } else {
          keyCount[cred.key] = 1;
        }
      }

      if (duplicateKeys.length > 0) {
        return res.status(400).json({
          success: false,
          error: 'Duplicate credential keys found',
          duplicateKeys
        });
      }

      await this.prisma.$transaction(async (tx) => {
        // UPSERT each credential
        for (const cred of credentials) {
          const rawValue = cred.value !== undefined && cred.value !== null ? String(cred.value) : '';
          const isMaskedValue = /^\*+encrypted\*+$/i.test(rawValue.trim());
          const hasValue = rawValue !== '' && !isMaskedValue;
          const existingCredential = await tx.serviceCredential.findUnique({
            where: {
              ispServiceId_key: {
                ispServiceId: ispService.id,
                key: cred.key
              }
            }
          });

          if (!existingCredential && !hasValue) {
            throw new Error(`Missing value for credential: ${cred.key}`);
          }

          await tx.serviceCredential.upsert({
            where: {
              ispServiceId_key: {
                ispServiceId: ispService.id,
                key: cred.key
              }
            },
            update: {
              ...(hasValue && { value: rawValue }),
              credentialType: cred.credentialType || 'api_key',
              label: cred.label || cred.key,
              isEncrypted: cred.isEncrypted !== undefined ? cred.isEncrypted : true,
              description: cred.description,
              isActive: true,
              isDeleted: false,
              updatedAt: new Date()
            },
            create: {
              credentialType: cred.credentialType || 'api_key',
              key: cred.key,
              value: rawValue,
              label: cred.label || cred.key,
              isEncrypted: cred.isEncrypted !== undefined ? cred.isEncrypted : true,
              description: cred.description,
              isActive: true,
              ispServiceId: ispService.id
            }
          });
        }

        // Mark credentials not in the new list as deleted
        const newKeys = credentials.map(c => c.key);
        await tx.serviceCredential.updateMany({
          where: {
            ispServiceId: ispService.id,
            key: { notIn: newKeys },
            isDeleted: false
          },
          data: {
            isDeleted: true,
            updatedAt: new Date()
          }
        });

        await tx.iSPService.update({
          where: { id: ispService.id },
          data: { updatedAt: new Date() }
        });
      });

      return res.json({ success: true, message: 'Credentials updated successfully' });
    } catch (error) {
      console.error('Error setting credentials:', error);

      if (error.code === 'P2002') {
        return res.status(400).json({
          success: false,
          error: 'Duplicate credential key detected. Each credential key must be unique for this service.'
        });
      }

      return res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: error.message
      });
    }
  }

  async testServiceConnection(req, res) {
    try {
      const ispId = req.ispId;
      const { serviceCode } = req.params;

      if (!ispId) {
        return res.status(400).json({ success: false, error: 'ISP ID not found in request.' });
      }

      const testResult = await ServiceFactory.testServiceConnection(serviceCode, ispId, this.prisma); // Pass prisma
      return res.json({ success: testResult.connected, ...testResult });
    } catch (error) {
      console.error('Error testing service connection:', error);
      return res.status(500).json({ success: false, error: 'Test failed', message: error.message });
    }
  }

  async getServiceStatus(req, res) {
    try {
      const ispId = req.ispId;
      const { serviceCode } = req.params;

      if (!ispId) {
        return res.status(400).json({ success: false, error: 'ISP ID not found in request.' });
      }

      const status = await ServiceFactory.getServiceStatus(serviceCode, ispId, this.prisma); // Pass prisma
      return res.json({ success: true, data: status });
    } catch (error) {
      console.error('Error getting service status:', error);
      return res.status(500).json({ success: false, error: 'Failed to get service status' });
    }
  }


  async getAllServiceStatuses(req, res) {
    try {
      const ispId = req.ispId;
      if (!ispId) {
        return res.status(400).json({ success: false, error: 'ISP ID not found in request.' });
      }

      const statuses = await ServiceFactory.getAllServiceStatuses(ispId);
      return res.json({
        success: true,
        data: statuses,
        meta: {
          total: statuses.length,
          enabled: statuses.filter(s => s.enabled).length,
          configured: statuses.filter(s => s.configured).length
        }
      });
    } catch (error) {
      console.error('Error getting all service statuses:', error);
      return res.status(500).json({ success: false, error: 'Failed to get service statuses' });
    }
  }

  async toggleServiceActivation(req, res) {
    try {
      const ispId = req.ispId;
      const { serviceCode } = req.params;
      const { isActive } = req.body;

      if (!ispId) {
        return res.status(400).json({ success: false, error: 'ISP ID not found in request.' });
      }

      if (typeof isActive !== 'boolean') {
        return res.status(400).json({ success: false, error: 'isActive must be a boolean' });
      }

      const service = await this.prisma.service.findUnique({
        where: { code: serviceCode, isDeleted: false }
      });

      if (!service) {
        return res.status(404).json({ success: false, error: 'Service not found' });
      }

      const ispService = await this.prisma.iSPService.findUnique({
        where: { ispId_serviceId: { ispId, serviceId: service.id } }
      });

      if (!ispService) {
        return res.status(404).json({ success: false, error: 'Service not configured for this ISP' });
      }

      const updated = await this.prisma.iSPService.update({
        where: { id: ispService.id },
        data: { isActive, updatedAt: new Date() },
        include: { service: true }
      });

      return res.json({
        success: true,
        message: `Service ${isActive ? 'activated' : 'deactivated'} successfully`,
        data: updated
      });
    } catch (error) {
      console.error('Error toggling service activation:', error);
      return res.status(500).json({ success: false, error: 'Failed to update service status' });
    }
  }

  // ==================== SERVICE-SPECIFIC OPERATIONS ====================

  #optionalServiceUnavailable(res, serviceName, error) {
    const message = error?.message || `${serviceName} service is not configured or enabled.`;
    if (/not configured|not enabled|not.*enabled|Failed to create service client/i.test(message)) {
      return res.json({
        success: true,
        configured: false,
        data: null,
        message: `${serviceName} service is not configured or enabled for this ISP.`
      });
    }
    return null;
  }

  // NetTV Operations
  async getNetTVResellerInfo(req, res) {
    try {
      const ispId = req.ispId;
      let client;
      try {
        client = await ServiceFactory.getClient(SERVICE_CODES.NETTV, ispId);
      } catch (err) {
        return res.json({
          success: true,
          configured: false,
          data: null,
          message: 'NetTV service is not configured or enabled'
        });
      }

      const resellerId = client.resellerId;
      if (!resellerId) {
        return res.json({
          success: true,
          configured: false,
          data: null,
          message: 'Reseller ID is not configured'
        });
      }

      const [creditBalance, paymentMethods] = await Promise.all([
        client.getCreditBalance(resellerId).catch(() => null),
        client.getPaymentMethods(resellerId).catch(() => null)
      ]);

      return res.json({
        success: true,
        configured: true,
        data: {
          resellerId,
          creditBalance: creditBalance || { credit_balance: 0, enable_credit_balance: "0" },
          paymentMethods: paymentMethods || { status: 'fallback', data: [] },
          createdBy: client.config?.createdBy || 'kisannet'
        }
      });
    } catch (error) {
      console.error('Error getting NetTV reseller info:', error);
      const optional = this.#optionalServiceUnavailable(res, 'NetTV', error);
      if (optional) return optional;
      return res.status(500).json({ success: false, error: 'Failed to get reseller info', message: error.message });
    }
  }

  async getNetTVSubscribers(req, res) {
    try {
      const ispId = req.ispId;
      const { page = 1, perPage = 20, search } = req.query;
      const client = await ServiceFactory.getClient(SERVICE_CODES.NETTV, ispId);
      const subscribersResponse = await client.getSubscribers(parseInt(page), parseInt(perPage), search);
      
      const db = req.prisma || this.prisma;
      if (subscribersResponse && db) {
        const items = Array.isArray(subscribersResponse)
          ? subscribersResponse
          : (subscribersResponse.subscribers || subscribersResponse.data || subscribersResponse.items || []);
        
        if (Array.isArray(items) && items.length > 0) {
          const usernames = items.map(sub => sub.username).filter(Boolean);
          const nettvService = await db.service.findFirst({ where: { code: SERVICE_CODES.NETTV, isDeleted: false }, select: { id: true } });
          const links = nettvService ? await db.customerSubscribedService.findMany({
            where: { serviceId: nettvService.id, externalUsername: { in: usernames }, customer: { ispId, isDeleted: false } },
            include: { customer: { include: { lead: true } } }
          }) : [];
          const linkedNames = new Set(links.map(link => link.externalUsername));
          const legacyCustomers = await db.customer.findMany({
            where: { customerUniqueId: { in: usernames.filter(name => !linkedNames.has(name)) }, ispId, isDeleted: false },
            include: { lead: true }
          });
          
          const customerMap = {};
          const addCustomer = (username, cust) => {
            customerMap[username] = {
              id: cust.id,
              customerUniqueId: cust.customerUniqueId,
              status: cust.status,
              firstName: cust.lead?.firstName || "",
              lastName: cust.lead?.lastName || ""
            };
          };
          links.forEach(link => addCustomer(link.externalUsername, link.customer));
          legacyCustomers.forEach(cust => addCustomer(cust.customerUniqueId, cust));
          
          items.forEach(sub => {
            if (sub.username && customerMap[sub.username]) {
              sub.local_customer = customerMap[sub.username];
            }
          });
        }
      }

      return res.json({ success: true, data: subscribersResponse });
    } catch (error) {
      console.error('Error getting NetTV subscribers:', error);
      const optional = this.#optionalServiceUnavailable(res, 'NetTV', error);
      if (optional) return optional;
      return res.status(500).json({ success: false, error: 'Failed to get subscribers', message: error.message });
    }
  }

  async getNetTVSubscriber(req, res) {
    try {
      const ispId = req.ispId;
      const { username } = req.params;
      const client = await ServiceFactory.getClient(SERVICE_CODES.NETTV, ispId);
      const subscriber = await client.getSubscriberOverview(username);
      return res.json({ success: true, data: subscriber });
    } catch (error) {
      console.error('Error getting NetTV subscriber:', error);
      const optional = this.#optionalServiceUnavailable(res, 'NetTV', error);
      if (optional) return optional;
      return res.status(500).json({ success: false, error: 'Failed to get subscriber', message: error.message });
    }
  }

  async createNetTVSubscriber(req, res) {
    try {
      const ispId = req.ispId;
      const { customerId, provisioning, ...subscriberData } = req.body || {};
      const client = await ServiceFactory.getClient(SERVICE_CODES.NETTV, ispId);
      const result = await client.createSubscriber(subscriberData);
      if (provisioning?.stb?.serial) {
        await client.addSTBToSubscriber(subscriberData.username, provisioning.stb);
        if (provisioning.package?.packages?.length) await client.subscribePackages(provisioning.stb.serial, provisioning.package);
      }
      if (customerId) await this.#linkNetTVCustomer(subscriberData.username, customerId, ispId, subscriberData, result);
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error creating NetTV subscriber:', error);
      return res.status(500).json({ success: false, error: 'Failed to create subscriber', message: error.message });
    }
  }

  async linkNetTVCustomer(req, res) {
    try {
      await this.#linkNetTVCustomer(req.params.username, req.body?.customerId, req.ispId);
      return res.json({ success: true, message: 'NetTV subscriber linked to customer' });
    } catch (error) {
      return res.status(/already linked/i.test(error.message) ? 409 : 400).json({ success: false, error: error.message });
    }
  }

  async #linkNetTVCustomer(username, customerId, ispId, requestData = {}, apiResult = null) {
    if (!username || !Number(customerId) || !this.prisma) throw new Error('Subscriber username and customer are required');
    const [customer, service] = await Promise.all([
      this.prisma.customer.findFirst({ where: { id: Number(customerId), ispId, isDeleted: false }, select: { id: true } }),
      this.prisma.service.findFirst({ where: { code: SERVICE_CODES.NETTV, isDeleted: false }, select: { id: true } })
    ]);
    if (!customer) throw new Error('Customer not found');
    if (!service) throw new Error('NetTV service is not available');
    const duplicate = await this.prisma.customerSubscribedService.findFirst({ where: { serviceId: service.id, externalUsername: username, customerId: { not: customer.id } } });
    if (duplicate) throw new Error(`NetTV username '${username}' is already linked to another customer`);
    await this.prisma.customerSubscribedService.upsert({
      where: { customerId_serviceId: { customerId: customer.id, serviceId: service.id } },
      update: { status: 'active', externalUsername: username, serviceData: { ...requestData, username, apiResult, lastNetTVSync: new Date().toISOString() } },
      create: { customerId: customer.id, serviceId: service.id, status: 'active', externalUsername: username, serviceData: { ...requestData, username, apiResult, lastNetTVSync: new Date().toISOString() } }
    });
  }

  async updateNetTVSubscriber(req, res) {
    try {
      const ispId = req.ispId;
      const { username } = req.params;
      const client = await ServiceFactory.getClient(SERVICE_CODES.NETTV, ispId);
      const result = await client.updateSubscriber(username, req.body || {});
      await this.#syncNetTVCustomerService(username, req.body || {}, result, ispId).catch(error => {
        console.warn('NetTV local customer sync skipped:', error.message);
      });
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error updating NetTV subscriber:', error);
      const optional = this.#optionalServiceUnavailable(res, 'NetTV', error);
      if (optional) return optional;
      return res.status(500).json({ success: false, error: 'Failed to update subscriber', message: error.message });
    }
  }

  async #syncNetTVCustomerService(username, requestData, apiResult, ispId) {
    if (!username || !this.prisma) return;
    const [customer, service] = await Promise.all([
      this.prisma.customer.findFirst({
        where: {
          ispId,
          isDeleted: false,
          OR: [
            { customerUniqueId: username },
            { subscribedApps: { some: { externalUsername: username, service: { code: SERVICE_CODES.NETTV } } } }
          ]
        },
        select: { id: true }
      }),
      this.prisma.service.findFirst({
        where: { code: SERVICE_CODES.NETTV, isDeleted: false },
        select: { id: true }
      })
    ]);
    if (!customer || !service) return;
    const normalizedStatus = String(requestData.status ?? '').trim();
    const localStatus = normalizedStatus === '0' ? 'inactive' : 'active';
    if (normalizedStatus === '0' || normalizedStatus === '1') {
      await this.prisma.customer.update({
        where: { id: customer.id },
        data: { status: localStatus }
      });
    }
    await this.prisma.customerSubscribedService.upsert({
      where: { customerId_serviceId: { customerId: customer.id, serviceId: service.id } },
      update: {
        status: localStatus,
        externalUsername: username,
        serviceData: { ...requestData, lastNetTVSync: new Date().toISOString(), apiResult }
      },
      create: {
        customerId: customer.id,
        serviceId: service.id,
        status: localStatus,
        externalUsername: username,
        serviceData: { ...requestData, lastNetTVSync: new Date().toISOString(), apiResult }
      }
    });
  }

  async deleteNetTVSubscriber(req, res) {
    try {
      const ispId = req.ispId;
      const { username } = req.params;
      const client = await ServiceFactory.getClient(SERVICE_CODES.NETTV, ispId);
      const result = await client.deleteSubscriber(username);
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error deleting NetTV subscriber:', error);
      const optional = this.#optionalServiceUnavailable(res, 'NetTV', error);
      if (optional) return optional;
      return res.status(500).json({ success: false, error: 'Failed to delete subscriber', message: error.message });
    }
  }

  async forceNetTVPassword(req, res) {
    try {
      const ispId = req.ispId;
      const { username } = req.params;
      const client = await ServiceFactory.getClient(SERVICE_CODES.NETTV, ispId);
      const result = await client.forceSubscriberPassword(username, req.body || {});
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error forcing NetTV password change:', error);
      return res.status(500).json({ success: false, error: 'Failed to update NetTV password', message: error.message });
    }
  }

  async requestNetTVPasswordReset(req, res) {
    try {
      const ispId = req.ispId;
      const client = await ServiceFactory.getClient(SERVICE_CODES.NETTV, ispId);
      const result = await client.requestSubscriberPasswordReset(req.body || {});
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error requesting NetTV password reset:', error);
      return res.status(500).json({ success: false, error: 'Failed to request NetTV password reset', message: error.message });
    }
  }

  async resetNetTVPassword(req, res) {
    try {
      const ispId = req.ispId;
      const client = await ServiceFactory.getClient(SERVICE_CODES.NETTV, ispId);
      const result = await client.resetSubscriberPassword(req.body || {});
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error resetting NetTV password:', error);
      return res.status(500).json({ success: false, error: 'Failed to reset NetTV password', message: error.message });
    }
  }


  async countriesProvince(req, res) {
    try {
      const ispId = req.ispId;
      const client = await ServiceFactory.getClient(SERVICE_CODES.NETTV, ispId);
      const countriesData = await client.getCountriesProvices();
      return res.json({
        success: true,
        data: countriesData
      })
    } catch (error) {
      console.error('Error getting countries province details:', error);
      return res.status(500).json({ success: false, error: 'Failed to create subscriber', message: error.message });
    }
  }

  async getNetTVPackages(req, res) {
    try {
      const ispId = req.ispId;
      const { page = 1, perPage = 20 } = req.query;
      const client = await ServiceFactory.getClient(SERVICE_CODES.NETTV, ispId);
      const packages = await client.getPackages(parseInt(page), parseInt(perPage));
      return res.json({ success: true, data: packages });
    } catch (error) {
      console.error('Error getting NetTV packages:', error);
      const optional = this.#optionalServiceUnavailable(res, 'NetTV', error);
      if (optional) return optional;
      return res.status(500).json({ success: false, error: 'Failed to get NetTV packages', message: error.message });
    }
  }

  async getNetTVPackageConfigs(req, res) {
    try {
      const ispId = req.ispId;
      const { serial } = req.params;
      const client = await ServiceFactory.getClient(SERVICE_CODES.NETTV, ispId);
      const packages = await client.getPackageConfigs(serial);
      return res.json({ success: true, data: packages });
    } catch (error) {
      console.error('Error getting NetTV package configs:', error);
      const optional = this.#optionalServiceUnavailable(res, 'NetTV', error);
      if (optional) return optional;
      return res.status(500).json({ success: false, error: 'Failed to get NetTV package configs', message: error.message });
    }
  }

  async getNetTVPackageConfig(req, res) {
    try {
      const ispId = req.ispId;
      const { serial, packageId } = req.params;
      const client = await ServiceFactory.getClient(SERVICE_CODES.NETTV, ispId);
      const packageConfig = await client.getPackageConfig(serial, packageId);
      return res.json({ success: true, data: packageConfig });
    } catch (error) {
      console.error('Error getting NetTV package config:', error);
      const optional = this.#optionalServiceUnavailable(res, 'NetTV', error);
      if (optional) return optional;
      return res.status(500).json({ success: false, error: 'Failed to get NetTV package config', message: error.message });
    }
  }

  async getNetTVSTBs(req, res) {
    try {
      const ispId = req.ispId;
      const { subscriberId, page = 1, perPage = 20 } = req.query;
      const client = await ServiceFactory.getClient(SERVICE_CODES.NETTV, ispId);
      const stbs = await client.getSTBs(subscriberId || null, parseInt(page), parseInt(perPage));
      return res.json({ success: true, data: stbs });
    } catch (error) {
      console.error('Error getting NetTV STBs:', error);
      const optional = this.#optionalServiceUnavailable(res, 'NetTV', error);
      if (optional) return optional;
      return res.status(500).json({ success: false, error: 'Failed to get NetTV STBs', message: error.message });
    }
  }

  async getNetTVModels(req, res) {
    try {
      const ispId = req.ispId;
      const { page = 1, perPage = 100 } = req.query;
      const client = await ServiceFactory.getClient(SERVICE_CODES.NETTV, ispId);
      const models = await client.getSTBModels(parseInt(page), parseInt(perPage));
      return res.json({ success: true, data: models });
    } catch (error) {
      console.error('Error getting NetTV models:', error);
      return res.status(500).json({ success: false, error: 'Failed to get NetTV models', message: error.message });
    }
  }

  async getNetTVVendors(req, res) {
    try {
      const ispId = req.ispId;
      const { page = 1, perPage = 100 } = req.query;
      const client = await ServiceFactory.getClient(SERVICE_CODES.NETTV, ispId);
      const vendors = await client.getSTBVendors(parseInt(page), parseInt(perPage));
      return res.json({ success: true, data: vendors });
    } catch (error) {
      console.error('Error getting NetTV vendors:', error);
      return res.status(500).json({ success: false, error: 'Failed to get NetTV vendors', message: error.message });
    }
  }

  async createNetTVSTB(req, res) {
    try {
      const ispId = req.ispId;
      const client = await ServiceFactory.getClient(SERVICE_CODES.NETTV, ispId);
      const result = await client.createSTB(req.body || {});
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error creating NetTV STB:', error);
      return res.status(500).json({ success: false, error: 'Failed to create NetTV STB', message: error.message });
    }
  }

  async updateNetTVSTB(req, res) {
    try {
      const ispId = req.ispId;
      const { serial } = req.params;
      const client = await ServiceFactory.getClient(SERVICE_CODES.NETTV, ispId);
      const result = await client.updateSTB(serial, req.body || {});
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error updating NetTV STB:', error);
      return res.status(500).json({ success: false, error: 'Failed to update NetTV STB', message: error.message });
    }
  }

  async getNetTVSubscriberSTB(req, res) {
    try {
      const ispId = req.ispId;
      const { username, serial } = req.params;
      const client = await ServiceFactory.getClient(SERVICE_CODES.NETTV, ispId);
      const result = await client.getSubscriberSTB(username, serial);
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error getting NetTV subscriber STB:', error);
      return res.status(500).json({ success: false, error: 'Failed to get subscriber STB', message: error.message });
    }
  }

  async addNetTVSubscriberSTB(req, res) {
    try {
      const ispId = req.ispId;
      const { username } = req.params;
      const client = await ServiceFactory.getClient(SERVICE_CODES.NETTV, ispId);
      const result = await client.addSTBToSubscriber(username, req.body || {});
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error adding NetTV subscriber STB:', error);
      return res.status(500).json({ success: false, error: 'Failed to add subscriber STB', message: error.message });
    }
  }

  async removeNetTVSubscriberSTB(req, res) {
    try {
      const ispId = req.ispId;
      const { username, serial } = req.params;
      const client = await ServiceFactory.getClient(SERVICE_CODES.NETTV, ispId);
      const result = await client.removeSTBFromSubscriber(username, serial, req.body || {});
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error removing NetTV subscriber STB:', error);
      return res.status(500).json({ success: false, error: 'Failed to remove subscriber STB', message: error.message });
    }
  }

  async replaceNetTVSubscriberSTB(req, res) {
    try {
      const ispId = req.ispId;
      const { username, serial } = req.params;
      const client = await ServiceFactory.getClient(SERVICE_CODES.NETTV, ispId);
      const result = await client.replaceSubscriberSTB(username, serial, req.body || {});
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error replacing NetTV subscriber STB:', error);
      return res.status(500).json({ success: false, error: 'Failed to replace subscriber STB', message: error.message });
    }
  }

  async getNetTVOrders(req, res) {
    try {
      const ispId = req.ispId;
      const { page = 1, perPage = 20, username = '' } = req.query;
      const client = await ServiceFactory.getClient(SERVICE_CODES.NETTV, ispId);
      const result = await client.getSubscriberOrders(parseInt(page), parseInt(perPage), username);
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error getting NetTV orders:', error);
      return res.status(500).json({ success: false, error: 'Failed to get NetTV orders', message: error.message });
    }
  }

  async getNetTVOrder(req, res) {
    try {
      const ispId = req.ispId;
      const { id } = req.params;
      const client = await ServiceFactory.getClient(SERVICE_CODES.NETTV, ispId);
      const result = await client.getSubscriberOrder(id);
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error getting NetTV order:', error);
      return res.status(500).json({ success: false, error: 'Failed to get NetTV order', message: error.message });
    }
  }

  async cancelNetTVPackage(req, res) {
    try {
      const ispId = req.ispId;
      const { serial } = req.params;
      const client = await ServiceFactory.getClient(SERVICE_CODES.NETTV, ispId);
      const result = await client.cancelPackageSubscription(serial, req.body || {});
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error cancelling NetTV package:', error);
      return res.status(500).json({ success: false, error: 'Failed to cancel NetTV package', message: error.message });
    }
  }

  async getNetTVInvoicePrint(req, res) {
    try {
      const ispId = req.ispId;
      const { companyPaymentId } = req.params;
      const client = await ServiceFactory.getClient(SERVICE_CODES.NETTV, ispId);
      const result = await client.getInvoicePrint(companyPaymentId);
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error getting NetTV invoice print:', error);
      return res.status(500).json({ success: false, error: 'Failed to get NetTV invoice print', message: error.message });
    }
  }

  async getNetTVCreditNotePrint(req, res) {
    try {
      const ispId = req.ispId;
      const { companyPaymentId } = req.params;
      const client = await ServiceFactory.getClient(SERVICE_CODES.NETTV, ispId);
      const result = await client.getCreditNotePrint(companyPaymentId);
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error getting NetTV credit note print:', error);
      return res.status(500).json({ success: false, error: 'Failed to get NetTV credit note print', message: error.message });
    }
  }

  async getNetTVMacReplaceReasons(req, res) {
    try {
      const ispId = req.ispId;
      const client = await ServiceFactory.getClient(SERVICE_CODES.NETTV, ispId);
      const result = await client.getMacReplaceReasons();
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error getting NetTV MAC replace reasons:', error);
      return res.status(500).json({ success: false, error: 'Failed to get NetTV MAC replace reasons', message: error.message });
    }
  }
  // Mikrotik Operations
  async getMikrotikResources(req, res) {
    try {
      const ispId = req.ispId;
      const client = await ServiceFactory.getClient(SERVICE_CODES.MIKROTIK, ispId);
      const resources = await client.getSystemResources();
      return res.json({ success: true, data: resources });
    } catch (error) {
      console.error('Error getting Mikrotik resources:', error);
      return res.status(500).json({ success: false, error: 'Failed to get resources', message: error.message });
    }
  }

  async getMikrotikInterfaces(req, res) {
    try {
      const ispId = req.ispId;
      const client = await ServiceFactory.getClient(SERVICE_CODES.MIKROTIK, ispId);
      const interfaces = await client.getInterfaces();
      return res.json({ success: true, data: interfaces });
    } catch (error) {
      console.error('Error getting Mikrotik interfaces:', error);
      return res.status(500).json({ success: false, error: 'Failed to get interfaces', message: error.message });
    }
  }

  async getMikrotikDHCPLeases(req, res) {
    try {
      const ispId = req.ispId;
      const client = await ServiceFactory.getClient(SERVICE_CODES.MIKROTIK, ispId);
      const leases = await client.getDHCPServerLeases();
      return res.json({ success: true, data: leases });
    } catch (error) {
      console.error('Error getting Mikrotik DHCP leases:', error);
      return res.status(500).json({ success: false, error: 'Failed to get DHCP leases', message: error.message });
    }
  }

  // Yeastar Operations
  async getYeastarExtensions(req, res) {
    try {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      const ispId = req.ispId;
      const client = await ServiceFactory.getClient(SERVICE_CODES.YEASTAR, ispId);
      const extensions = await client.listExtensions();
      return res.json({ success: true, data: extensions });
    } catch (error) {
      console.error('Error getting Yeastar extensions:', error);
      return res.status(500).json({ success: false, error: 'Failed to get extensions', message: error.message });
    }
  }

  async getYeastarActiveCalls(req, res) {
    try {
      const ispId = req.ispId;
      const client = await ServiceFactory.getClient(SERVICE_CODES.YEASTAR, ispId);
      const activeCalls = await client.getActiveCalls();
      return res.json({ success: true, data: activeCalls });
    } catch (error) {
      console.error('Error getting Yeastar active calls:', error);
      return res.status(500).json({ success: false, error: 'Failed to get active calls', message: error.message });
    }
  }

  async getYeastarSystemInfo(req, res) {
    try {
      const ispId = req.ispId;
      const client = await ServiceFactory.getClient(SERVICE_CODES.YEASTAR, ispId);
      const systemInfo = await client.getSystemInfo();
      return res.json({ success: true, data: systemInfo });
    } catch (error) {
      console.error('Error getting Yeastar system info:', error);
      return res.status(500).json({ success: false, error: 'Failed to get system info', message: error.message });
    }
  }

  // Asterisk Operations
  async getAsteriskExtensions(req, res) {
    try {
      const ispId = req.ispId;
      const client = await ServiceFactory.getClient(SERVICE_CODES.ASTERISK, ispId);
      const extensions = await client.listExtensions();
      return res.json({ success: true, data: extensions });
    } catch (error) {
      console.error('Error getting Asterisk extensions:', error);
      return res.status(500).json({ success: false, error: 'Failed to get extensions', message: error.message });
    }
  }

  async getAsteriskActiveCalls(req, res) {
    try {
      const ispId = req.ispId;
      const client = await ServiceFactory.getClient(SERVICE_CODES.ASTERISK, ispId);
      const activeCalls = await client.getActiveCalls();
      return res.json({ success: true, data: activeCalls });
    } catch (error) {
      console.error('Error getting Asterisk active calls:', error);
      return res.status(500).json({ success: false, error: 'Failed to get active calls', message: error.message });
    }
  }

  async getAsteriskSystemInfo(req, res) {
    try {
      const ispId = req.ispId;
      const client = await ServiceFactory.getClient(SERVICE_CODES.ASTERISK, ispId);
      const systemInfo = await client.syncSystemStatus();
      return res.json({ success: true, data: systemInfo });
    } catch (error) {
      console.error('Error getting Asterisk system info:', error);
      return res.status(500).json({ success: false, error: 'Failed to get system info', message: error.message });
    }
  }

  // Tshul Operations
  async getTshulCustomers(req, res) {
    try {
      const ispId = req.ispId;
      const { page = 1, limit = 20 } = req.query;
      const client = await ServiceFactory.getClient(SERVICE_CODES.TSHUL, ispId);
      const customers = await client.customer.list();

      const startIndex = (page - 1) * limit;
      const endIndex = page * limit;
      const paginatedCustomers = Array.isArray(customers) ?
        customers.slice(startIndex, endIndex) : customers;

      return res.json({
        success: true,
        data: {
          customers: paginatedCustomers,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: Array.isArray(customers) ? customers.length : 0,
            totalPages: Array.isArray(customers) ? Math.ceil(customers.length / limit) : 1
          }
        }
      });
    } catch (error) {
      console.error('Error getting Tshul customers:', error);
      const optional = this.#optionalServiceUnavailable(res, 'TSHUL', error);
      if (optional) return optional;
      return res.status(500).json({ success: false, error: 'Failed to get customers', message: error.message });
    }
  }


  async getTshulCustomersbyId(req, res) {
    try {
      const ispId = req.ispId;
      const { refrenceId } = req.params;
      const client = await ServiceFactory.getClient(SERVICE_CODES.TSHUL, ispId);
      const customers = await client.customer.get(refrenceId);

      return res.json({ success: true, data: customers });


    } catch (error) {
      console.error('Error getting Tshul customers:', error);
      const optional = this.#optionalServiceUnavailable(res, 'TSHUL', error);
      if (optional) return optional;
      return res.status(500).json({ success: false, error: 'Failed to get customers', message: error.message });
    }
  }

  async createTshulCustomer(req, res) {
    try {
      const ispId = req.ispId;
      const customerData = req.body;
      const client = await ServiceFactory.getClient(SERVICE_CODES.TSHUL, ispId);
      const result = await client.customer.create(customerData);
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error creating Tshul customer:', error);
      return res.status(500).json({ success: false, error: 'Failed to create customer', message: error.message });
    }
  }

  async updateTshulCustomer(req, res) {
    try {
      const ispId = req.ispId;
      const { refrenceId } = req.params;
      const customerData = req.body;
      const client = await ServiceFactory.getClient(SERVICE_CODES.TSHUL, ispId);
      const result = await client.customer.update(refrenceId, customerData);
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error updating Tshul customer:', error);
      return res.status(500).json({ success: false, error: 'Failed to update customer', message: error.message });
    }
  }

  async deleteTshulCustomer(req, res) {
    try {
      const ispId = req.ispId;
      const { refrenceId } = req.params;
      const client = await ServiceFactory.getClient(SERVICE_CODES.TSHUL, ispId);
      const result = await client.customer.delete(refrenceId);
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error deleting Tshul customer:', error);
      return res.status(500).json({ success: false, error: 'Failed to delete customer', message: error.message });
    }
  }

  // Nepurix Operations
  async getNepurixCustomers(req, res) {
    try {
      const ispId = req.ispId;
      const { page = 1, limit = 20 } = req.query;
      const client = await ServiceFactory.getClient(SERVICE_CODES.NEPURIX, ispId);
      const customers = await client.customer.list();

      const startIndex = (page - 1) * limit;
      const endIndex = page * limit;
      const paginatedCustomers = Array.isArray(customers) ?
        customers.slice(startIndex, endIndex) : customers;

      return res.json({
        success: true,
        data: {
          customers: paginatedCustomers,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: Array.isArray(customers) ? customers.length : 0,
            totalPages: Array.isArray(customers) ? Math.ceil(customers.length / limit) : 1
          }
        }
      });
    } catch (error) {
      console.error('Error getting Nepurix customers:', error);
      const optional = this.#optionalServiceUnavailable(res, 'NEPURIX', error);
      if (optional) return optional;
      return res.status(500).json({ success: false, error: 'Failed to get customers', message: error.message });
    }
  }

  async getNepurixCustomerById(req, res) {
    try {
      const ispId = req.ispId;
      const { refrenceId } = req.params;
      const client = await ServiceFactory.getClient(SERVICE_CODES.NEPURIX, ispId);
      const customer = await client.customer.get(refrenceId);
      return res.json({ success: true, data: customer });
    } catch (error) {
      console.error('Error getting Nepurix customer by id:', error);
      const optional = this.#optionalServiceUnavailable(res, 'NEPURIX', error);
      if (optional) return optional;
      return res.status(500).json({ success: false, error: 'Failed to get customer', message: error.message });
    }
  }

  async createNepurixCustomer(req, res) {
    try {
      const ispId = req.ispId;
      const customerData = req.body;
      const client = await ServiceFactory.getClient(SERVICE_CODES.NEPURIX, ispId);
      const result = await client.customer.create(customerData);
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error creating Nepurix customer:', error);
      return res.status(500).json({ success: false, error: 'Failed to create customer', message: error.message });
    }
  }

  async updateNepurixCustomer(req, res) {
    try {
      const ispId = req.ispId;
      const { refrenceId } = req.params;
      const customerData = req.body;
      const client = await ServiceFactory.getClient(SERVICE_CODES.NEPURIX, ispId);
      const result = await client.customer.update(refrenceId, customerData);
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error updating Nepurix customer:', error);
      return res.status(500).json({ success: false, error: 'Failed to update customer', message: error.message });
    }
  }

  async deleteNepurixCustomer(req, res) {
    try {
      const ispId = req.ispId;
      const { refrenceId } = req.params;
      const client = await ServiceFactory.getClient(SERVICE_CODES.NEPURIX, ispId);
      const result = await client.customer.delete(refrenceId);
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error deleting Nepurix customer:', error);
      return res.status(500).json({ success: false, error: 'Failed to delete customer', message: error.message });
    }
  }

  #getAccountingClient(provider, ispId) {
    const code = String(provider || '').toUpperCase();
    if (![SERVICE_CODES.TSHUL, SERVICE_CODES.NEPURIX].includes(code)) {
      const error = new Error('Accounting provider must be TSHUL or NEPURIX');
      error.statusCode = 400;
      throw error;
    }
    return ServiceFactory.getClient(code, ispId);
  }

  #accountingResource(client, resource) {
    const normalized = String(resource || '').toLowerCase();
    if (normalized === 'customers') return client.customer;
    if (normalized === 'items') return client.item;
    if (normalized === 'sales-invoices') return client.sales;
    const error = new Error('Resource must be customers, items, or sales-invoices');
    error.statusCode = 400;
    throw error;
  }

  #accountingArray(result) {
    if (Array.isArray(result)) return result;
    if (Array.isArray(result?.Data)) return result.Data;
    if (Array.isArray(result?.data)) return result.data;
    if (Array.isArray(result?.items)) return result.items;
    if (Array.isArray(result?.results)) return result.results;
    return [];
  }

  async getAccountingDashboard(req, res) {
    try {
      const client = await this.#getAccountingClient(req.params.provider, req.ispId);
      const callList = async (resource, label) => {
        if (!resource || typeof resource.list !== 'function') {
          return { unsupported: true, label, data: [] };
        }
        return resource.list();
      };
      const [customersResult, itemsResult, invoicesResult] = await Promise.allSettled([
        callList(client.customer, 'customers'), callList(client.item, 'items'), callList(client.sales, 'sales-invoices')
      ]);
      const customers = this.#accountingArray(customersResult.status === 'fulfilled' ? customersResult.value : []);
      const items = this.#accountingArray(itemsResult.status === 'fulfilled' ? itemsResult.value : []);
      const salesInvoices = this.#accountingArray(invoicesResult.status === 'fulfilled' ? invoicesResult.value : []);
      const invoiceTotal = salesInvoices.reduce((sum, invoice) => sum + Number(invoice.NetAmount ?? invoice.netAmount ?? invoice.TotalAmount ?? invoice.totalAmount ?? 0), 0);
      return res.json({
        success: true,
        data: {
          totals: { customers: customers.length, items: items.length, salesInvoices: salesInvoices.length, invoiceAmount: invoiceTotal },
          customers,
          items,
          salesInvoices,
          errors: {
            customers: customersResult.status === 'rejected' ? customersResult.reason?.message : null,
            items: itemsResult.status === 'rejected' ? itemsResult.reason?.message : (itemsResult.value?.unsupported ? 'Items are not supported by this provider' : null),
            salesInvoices: invoicesResult.status === 'rejected' ? invoicesResult.reason?.message : null
          }
        }
      });
    } catch (error) {
      console.error('Accounting dashboard error:', error);
      return res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  }

  async listAccountingResources(req, res) {
    try {
      const client = await this.#getAccountingClient(req.params.provider, req.ispId);
      const resource = this.#accountingResource(client, req.params.resource);
      if (!resource || typeof resource.list !== 'function') return res.json({ success: true, data: [], unsupported: true });
      const result = await resource.list();
      return res.json({ success: true, data: this.#accountingArray(result), raw: result });
    } catch (error) {
      return res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  }

  async getAccountingResource(req, res) {
    try {
      const client = await this.#getAccountingClient(req.params.provider, req.ispId);
      const result = await this.#accountingResource(client, req.params.resource).get(req.params.id);
      return res.json({ success: true, data: result?.Data ?? result?.data ?? result });
    } catch (error) {
      return res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  }

  async createAccountingResource(req, res) {
    try {
      const client = await this.#getAccountingClient(req.params.provider, req.ispId);
      const result = await this.#accountingResource(client, req.params.resource).create(req.body);
      return res.status(201).json({ success: true, data: result?.Data ?? result?.data ?? result });
    } catch (error) {
      return res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  }

  async updateAccountingResource(req, res) {
    try {
      const client = await this.#getAccountingClient(req.params.provider, req.ispId);
      const result = await this.#accountingResource(client, req.params.resource).update(req.params.id, req.body);
      return res.json({ success: true, data: result?.Data ?? result?.data ?? result });
    } catch (error) {
      return res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  }

  async deleteAccountingResource(req, res) {
    try {
      const client = await this.#getAccountingClient(req.params.provider, req.ispId);
      const resource = this.#accountingResource(client, req.params.resource);
      if (typeof resource.delete !== 'function') {
        return res.status(405).json({ success: false, error: 'Delete not supported for this resource' });
      }
      const result = await resource.delete(req.params.id);
      return res.json({ success: true, data: result?.Data ?? result?.data ?? result });
    } catch (error) {
      return res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  }

  // Radius Operations
  async getRadiusUsers(req, res) {
    try {
      const ispId = req.ispId;
      const { limit = 100, offset = 0 } = req.query;
      const client = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, ispId);
      const users = await client.listUsers(parseInt(limit), parseInt(offset));
      return res.json({ success: true, data: users });
    } catch (error) {
      console.error('Error getting Radius users:', error);
      const optional = this.#optionalServiceUnavailable(res, 'Radius', error);
      if (optional) return optional;
      return res.status(500).json({ success: false, error: 'Failed to get users', message: error.message });
    }
  }

  // Radius: Create user
  async createRadiusUser(req, res) {
    try {
      const ispId = req.ispId;
      const { username, password, attributes = {}, groups = [] } = req.body;

      if (!username || !password) {
        return res.status(400).json({
          success: false,
          error: 'Username and password are required'
        });
      }

      const client = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, ispId);
      const result = await client.createUser(username, password, attributes, groups);
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error creating Radius user:', error);
      return res.status(500).json({ success: false, error: 'Failed to create user', message: error.message });
    }
  }

  // Radius: Get user details
  async getRadiusUser(req, res) {
    try {
      const ispId = req.ispId;
      const { username } = req.params;
      const client = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, ispId);
      const user = await client.getUser(username);
      return res.json({ success: true, data: user });
    } catch (error) {
      console.error('Error getting Radius user:', error);
      const optional = this.#optionalServiceUnavailable(res, 'Radius', error);
      if (optional) return optional;
      return res.status(500).json({ success: false, error: 'Failed to get user', message: error.message });
    }
  }

  // Radius: Delete user
  async deleteRadiusUser(req, res) {
    try {
      const ispId = req.ispId;
      const { username } = req.params;
      const client = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, ispId);
      const result = await client.deleteUser(username);
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error deleting Radius user:', error);
      return res.status(500).json({ success: false, error: 'Failed to delete user', message: error.message });
    }
  }

  // Radius: Get system stats
  async getRadiusStats(req, res) {
    try {
      const ispId = req.ispId;
      const client = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, ispId);
      const stats = await client.getSystemStats();
      return res.json({ success: true, data: stats });
    } catch (error) {
      console.error('Error getting Radius stats:', error);
      return res.status(500).json({ success: false, error: 'Failed to get stats', message: error.message });
    }
  }


  // Radius: Get system stats
  async getRadiusAccountbyUser(req, res) {
    try {
      const ispId = req.ispId;
      const { username } = req.params;
      const client = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, ispId);
      const stats = await client.getRadacctByUsername(username);
      return res.json({ success: true, data: stats });
    } catch (error) {
      console.error('Error getting Radius stats:', error);
      return res.status(500).json({ success: false, error: 'Failed to get stats', message: error.message });
    }
  }

  async getCustomerRadiusUsage(req, res, next) {
    try {
      const { findCustomerForAuthenticatedUser } = require('./customer.controller');
      const customer = await findCustomerForAuthenticatedUser(req.prisma, req);
      if (!customer) {
        return res.status(404).json({ success: false, error: 'Customer profile not found.' });
      }

      const connectionUsers = customer.connectionUsers || [];
      if (connectionUsers.length === 0) {
        return res.json({ success: true, data: [] });
      }

      const client = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, customer.ispId);
      const usageMap = new Map();

      for (const user of connectionUsers) {
        const radAcct = await client.getRadacctByUsername(user.username).catch(() => []);
        if (!Array.isArray(radAcct)) continue;

        for (const session of radAcct) {
          const startTime = session.acctstarttime;
          if (!startTime) continue;

          let dateStr;
          try {
            dateStr = new Date(startTime).toISOString().split('T')[0];
          } catch (e) {
            continue;
          }

          const upload = Number(session.acctinputoctets || 0) + Number(session.acctinputoctets64 || 0);
          const download = Number(session.acctoutputoctets || 0) + Number(session.acctoutputoctets64 || 0);
          const duration = Number(session.acctsessiontime || 0);

          if (usageMap.has(dateStr)) {
            const entry = usageMap.get(dateStr);
            entry.upload += upload;
            entry.download += download;
            entry.duration += duration;
            entry.count += 1;
          } else {
            usageMap.set(dateStr, {
              date: dateStr,
              upload,
              download,
              duration,
              count: 1
            });
          }
        }
      }

      const result = Array.from(usageMap.values()).map(entry => ({
        ...entry,
        total: entry.upload + entry.download
      })).sort((a, b) => b.date.localeCompare(a.date));

      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error getting customer radius usage:', error);
      return res.status(500).json({ success: false, error: 'Failed to retrieve daily usage statistics.', message: error.message });
    }
  }

  async getRadiusTable(req, res) {
    try {
      const ispId = req.ispId;
      const { table } = req.params;
      const { limit = 500, offset = 0 } = req.query;
      const client = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, ispId);
      const result = await client.getTable(table, parseInt(limit), parseInt(offset));
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error getting Radius table:', error);
      const optional = this.#optionalServiceUnavailable(res, 'Radius', error);
      if (optional) return optional;
      return res.status(500).json({ success: false, error: 'Failed to get Radius table', message: error.message });
    }
  }

  // Radius: Test authentication
  async testRadiusAuth(req, res) {
    try {
      const ispId = req.ispId;
      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json({
          success: false,
          error: 'Username and password are required'
        });
      }

      const client = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, ispId);
      const result = await client.testAuthentication(username, password);
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error testing Radius auth:', error);
      return res.status(500).json({ success: false, error: 'Failed to test authentication', message: error.message });
    }
  }

  async sendRadiusCoA(req, res) {
    try {
      const ispId = req.ispId;
      const { username } = req.params;
      const client = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, ispId);
      const result = await client.sendCoA(username, req.body || {});
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error sending Radius COA:', error);
      const optional = this.#optionalServiceUnavailable(res, 'Radius', error);
      if (optional) return optional;
      return res.status(500).json({ success: false, error: 'Failed to send Radius COA', message: error.message });
    }
  }

  async testRadiusConnection(req, res) {
    try {
      const ispId = req.ispId;
      const client = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, ispId);
      const result = await client.testConnection();
      return res.json({ success: result.connected, ...result });
    } catch (error) {
      console.error('Error testing Radius connection:', error);
      return res.status(500).json({ success: false, error: 'Test failed', message: error.message });
    }
  }

  // eSewa Operations
  async processEsewaPayment(req, res) {
    try {
      const ispId = req.ispId;
      const paymentData = req.body;
      const client = await ServiceFactory.getClient(SERVICE_CODES.ESEWA, ispId);
      const result = await client.processPayment(paymentData);
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error processing eSewa payment:', error);
      return res.status(500).json({ success: false, error: 'Failed to process payment', message: error.message });
    }
  }

  async verifyEsewaPayment(req, res) {
    try {
      const ispId = req.ispId;
      const { transactionId } = req.params;
      const client = await ServiceFactory.getClient(SERVICE_CODES.ESEWA, ispId);
      const result = await client.verifyPayment(transactionId);
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error verifying eSewa payment:', error);
      return res.status(500).json({ success: false, error: 'Failed to verify payment', message: error.message });
    }
  }

  // Khalti Operations
  async processKhaltiPayment(req, res) {
    try {
      const ispId = req.ispId;
      const paymentData = req.body;
      const client = await ServiceFactory.getClient(SERVICE_CODES.KHALTI, ispId);
      const result = await client.processPayment(paymentData);
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error processing Khalti payment:', error);
      return res.status(500).json({ success: false, error: 'Failed to process payment', message: error.message });
    }
  }

  async verifyKhaltiPayment(req, res) {
    try {
      const ispId = req.ispId;
      const { token } = req.params;
      const client = await ServiceFactory.getClient(SERVICE_CODES.KHALTI, ispId);
      const result = await client.verifyPayment(token);
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error verifying Khalti payment:', error);
      return res.status(500).json({ success: false, error: 'Failed to verify payment', message: error.message });
    }
  }

  // In ServiceController.js, update provisionDefaultServices method:
  async provisionDefaultServices(req, res) {
    try {
      const ispId = req.ispId;

      // Default configurations for Kisan ISP
      const defaultConfigs = {
        TSHUL: {
          baseUrl: 'https://kisan-net.tshul.app/api',
          credentials: [
            { key: 'username', value: 'demo@kisan.net.np', credentialType: 'username_password', label: 'Username' },
            { key: 'password', value: 'demo@kisan.net.np@123', credentialType: 'username_password', label: 'Password', isEncrypted: true }
          ]
        },
        RADIUS: {
          baseUrl: 'http://10.3.2.6:3005/login',
          credentials: [
            { key: 'username', value: 'radius', credentialType: 'username_password', label: 'Username' },
            { key: 'password', value: 'Kisan@radius', credentialType: 'username_password', label: 'Password', isEncrypted: true }
          ]
        },
        YEASTAR: {
          baseUrl: 'http://10.3.2.50',
          credentials: [
            { key: 'pbx_ip', value: '10.3.2.50', credentialType: 'api_key', label: 'PBX IP' },
            { key: 'username', value: 'kisan', credentialType: 'username_password', label: 'Username' },
            { key: 'password', value: 'Kisan@123', credentialType: 'username_password', label: 'Password', isEncrypted: true },
            { key: 'tcp_port', value: '8333', credentialType: 'api_key', label: 'TCP Port' },
            { key: 'api_port', value: '80', credentialType: 'api_key', label: 'API Port' }
          ]
        },
        NETTV: {
          baseUrl: 'https://resources.geniustv.dev.geniussystems.com.np',
          credentials: [
            { key: 'api_key', value: '5c232ef1fdf138', credentialType: 'api_key', label: 'API Key' },
            { key: 'api_secret', value: '72b7b119b2b98983e1ad33a385b08df489', credentialType: 'api_key', label: 'API Secret', isEncrypted: true },
            { key: 'app_key', value: '', credentialType: 'api_key', label: 'App Key' },
            { key: 'app_secret', value: '', credentialType: 'api_key', label: 'App Secret', isEncrypted: true }
          ]
        },
        MIKROTIK: {
          baseUrl: 'http://10.1.5.2',
          credentials: [
            { key: 'username', value: 'bipin', credentialType: 'username_password', label: 'Username' },
            { key: 'password', value: 'bipin', credentialType: 'username_password', label: 'Password', isEncrypted: true },
            { key: 'port', value: '8728', credentialType: 'api_key', label: 'Port' },
            { key: 'use_ssl', value: 'false', credentialType: 'api_key', label: 'Use SSL' }
          ]
        },
        GENIEACS: {
          baseUrl: 'http://10.3.2.6:7557',
          credentials: [
            { key: 'username', value: 'admin', credentialType: 'basic_auth', label: 'ACS Username' },
            { key: 'password', value: 'admin', credentialType: 'basic_auth', label: 'ACS Password', isEncrypted: true },
            { key: 'api_port', value: '7557', credentialType: 'api_key', label: 'API Port' },
            { key: 'web_port', value: '3000', credentialType: 'api_key', label: 'Web UI Port' },
            { key: 'timeout', value: '20000', credentialType: 'api_key', label: 'Request Timeout' }
          ]
        }
      };

      const results = [];

      for (const [serviceCode, config] of Object.entries(defaultConfigs)) {
        try {
          // Get service
          const service = await this.prisma.service.findUnique({
            where: { code: serviceCode, isDeleted: false }
          });

          if (!service) {
            results.push({ serviceCode, status: 'error', message: 'Service not found' });
            continue;
          }

          // Configure service
          let ispService = await this.prisma.iSPService.findFirst({
            where: { ispId, serviceId: service.id, isDeleted: false }
          });

          if (!ispService) {
            ispService = await this.prisma.iSPService.create({
              data: {
                ispId,
                serviceId: service.id,
                isActive: true,
                isEnabled: true,
                baseUrl: config.baseUrl,
                apiVersion: 'v1',
                config: {}
              }
            });
          }

          // Set credentials
          for (const cred of config.credentials) {
            await this.prisma.serviceCredential.upsert({
              where: {
                ispServiceId_key: {
                  ispServiceId: ispService.id,
                  key: cred.key
                }
              },
              update: {
                value: cred.value,
                credentialType: cred.credentialType,
                label: cred.label,
                isEncrypted: cred.isEncrypted || false,
                updatedAt: new Date()
              },
              create: {
                ispServiceId: ispService.id,
                credentialType: cred.credentialType,
                key: cred.key,
                value: cred.value,
                label: cred.label,
                isEncrypted: cred.isEncrypted || false,
                isActive: true
              }
            });
          }

          results.push({ serviceCode, status: 'success', message: 'Service provisioned successfully' });
        } catch (error) {
          results.push({ serviceCode, status: 'error', message: error.message });
        }
      }

      return res.json({
        success: true,
        message: 'Default services provisioned',
        data: results
      });
    } catch (error) {
      console.error('Error provisioning default services:', error);
      return res.status(500).json({ success: false, error: 'Failed to provision services' });
    }
  }

  // Enable All Services
  async enableAllServices(req, res) {
    try {
      const ispId = req.ispId;

      await this.prisma.iSPService.updateMany({
        where: { ispId, isDeleted: false },
        data: { isActive: true, updatedAt: new Date() }
      });

      return res.json({
        success: true,
        message: 'All services enabled successfully'
      });
    } catch (error) {
      console.error('Error enabling all services:', error);
      return res.status(500).json({ success: false, error: 'Failed to enable services' });
    }
  }

  // Disable All Services
  async disableAllServices(req, res) {
    try {
      const ispId = req.ispId;

      await this.prisma.iSPService.updateMany({
        where: { ispId, isDeleted: false },
        data: { isActive: false, updatedAt: new Date() }
      });

      return res.json({
        success: true,
        message: 'All services disabled successfully'
      });
    } catch (error) {
      console.error('Error disabling all services:', error);
      return res.status(500).json({ success: false, error: 'Failed to disable services' });
    }
  }

  // Test All Services Connection
  async testAllServices(req, res) {
    try {
      const ispId = req.ispId;

      const ispServices = await this.prisma.iSPService.findMany({
        where: { ispId, isActive: true, isDeleted: false },
        include: { service: true }
      });

      const testResults = [];

      for (const ispService of ispServices) {
        try {
          const testResult = await ServiceFactory.testServiceConnection(ispService.service.code, ispId);
          testResults.push({
            serviceCode: ispService.service.code,
            serviceName: ispService.service.name,
            ...testResult
          });
        } catch (error) {
          testResults.push({
            serviceCode: ispService.service.code,
            serviceName: ispService.service.name,
            connected: false,
            message: error.message,
            timestamp: new Date().toISOString()
          });
        }
      }

      const connectedServices = testResults.filter(r => r.connected).length;
      const totalServices = testResults.length;

      return res.json({
        success: true,
        data: testResults,
        summary: {
          total: totalServices,
          connected: connectedServices,
          failed: totalServices - connectedServices,
          successRate: totalServices > 0 ? Math.round((connectedServices / totalServices) * 100) : 0
        }
      });
    } catch (error) {
      console.error('Error testing all services:', error);
      return res.status(500).json({ success: false, error: 'Failed to test services' });
    }
  }

  // Get Service Analytics
  async getServiceAnalytics(req, res) {
    try {
      const ispId = req.ispId;

      const totalServices = await this.prisma.service.count({
        where: { isDeleted: false, isActive: true }
      });

      const activeServices = await this.prisma.iSPService.count({
        where: { ispId, isActive: true, isDeleted: false }
      });

      const configuredServices = await this.prisma.iSPService.count({
        where: {
          ispId,
          isDeleted: false,
          OR: [
            { baseUrl: { not: null } },
            { credentials: { some: { isActive: true, isDeleted: false } } }
          ]
        }
      });

      const servicesByCategory = await this.prisma.service.groupBy({
        by: ['category'],
        where: { isDeleted: false, isActive: true },
        _count: { id: true }
      });

      const recentActivities = await this.prisma.iSPService.findMany({
        where: { ispId, isDeleted: false },
        include: { service: true },
        orderBy: { updatedAt: 'desc' },
        take: 10
      });

      return res.json({
        success: true,
        data: {
          totalServices,
          activeServices,
          configuredServices,
          servicesByCategory,
          recentActivities: recentActivities.map(service => ({
            id: service.id,
            serviceName: service.service.name,
            serviceCode: service.service.code,
            status: service.isActive ? 'active' : 'inactive',
            lastUpdated: service.updatedAt,
            isConfigured: !!service.baseUrl
          })),
          analytics: {
            configurationRate: totalServices > 0 ? Math.round((configuredServices / totalServices) * 100) : 0,
            activationRate: totalServices > 0 ? Math.round((activeServices / totalServices) * 100) : 0
          }
        }
      });
    } catch (error) {
      console.error('Error getting service analytics:', error);
      return res.status(500).json({ success: false, error: 'Failed to get analytics' });
    }
  }

  // Bulk Operations
  async bulkOperations(req, res) {
    try {
      const ispId = req.ispId;
      const { operation, serviceCodes } = req.body;

      if (!operation || !serviceCodes || !Array.isArray(serviceCodes)) {
        return res.status(400).json({
          success: false,
          error: 'Operation and serviceCodes array are required'
        });
      }

      const results = [];

      for (const serviceCode of serviceCodes) {
        try {
          switch (operation) {
            case 'enable':
              await this.toggleServiceActivationInternal(ispId, serviceCode, true);
              results.push({ serviceCode, status: 'success', message: 'Service enabled' });
              break;

            case 'disable':
              await this.toggleServiceActivationInternal(ispId, serviceCode, false);
              results.push({ serviceCode, status: 'success', message: 'Service disabled' });
              break;

            case 'test':
              const testResult = await ServiceFactory.testServiceConnection(serviceCode, ispId);
              results.push({
                serviceCode,
                status: testResult.connected ? 'success' : 'error',
                message: testResult.message,
                connected: testResult.connected
              });
              break;

            default:
              results.push({ serviceCode, status: 'error', message: 'Invalid operation' });
          }
        } catch (error) {
          results.push({ serviceCode, status: 'error', message: error.message });
        }
      }

      return res.json({
        success: true,
        data: results,
        summary: {
          total: results.length,
          success: results.filter(r => r.status === 'success').length,
          failed: results.filter(r => r.status === 'error').length
        }
      });
    } catch (error) {
      console.error('Error in bulk operations:', error);
      return res.status(500).json({ success: false, error: 'Bulk operation failed' });
    }
  }

  // Helper method for internal toggle
  async toggleServiceActivationInternal(ispId, serviceCode, isActive) {
    const service = await this.prisma.service.findUnique({
      where: { code: serviceCode, isDeleted: false }
    });

    if (!service) {
      throw new Error('Service not found');
    }

    const ispService = await this.prisma.iSPService.findUnique({
      where: { ispId_serviceId: { ispId, serviceId: service.id } }
    });

    if (!ispService) {
      throw new Error('Service not configured for this ISP');
    }

    await this.prisma.iSPService.update({
      where: { id: ispService.id },
      data: { isActive, updatedAt: new Date() }
    });
  }


  // GenieACS Function

  async refreshUptime(req, serialNumber) {
    try {
      // DEBUG: Verify incoming parameters
      console.log(`[DEBUG] Starting refreshUptime for Serial: ${serialNumber} (ISP ID: ${req.ispId})`);

      const ispId = req.ispId;
      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);

      // We trigger the parent object and the specific parameter
      console.log(`[DEBUG] Queuing GenieACS tasks for ${serialNumber}...`);

      const device = await client.refreshObject(serialNumber, 'InternetGatewayDevice.DeviceInfo');
      const deviceuptime = await client.refreshObject(serialNumber, 'InternetGatewayDevice.DeviceInfo.UpTime');

      console.log(`[DEBUG] Tasks created. Uptime task response:`, deviceuptime);
      return { success: true, data: device };
    } catch (error) {
      console.error(`[ERROR] Failed refreshUptime for ${serialNumber}:`, error.message);
      return { success: false, error: error.message };
    }
  }

  async getGenieACSDevices(req, res) {
    try {
      const ispId = req.ispId;
      const { search, status, refreshDevice } = req.query;

      const genieService = await this.prisma.iSPService.findFirst({
        where: {
          ispId,
          service: { code: SERVICE_CODES.GENIEACS },
          isDeleted: false,
          isActive: true,
          isEnabled: true
        },
        include: { service: true }
      });

      if (!genieService) {
        return res.json({
          success: false,
          total: 0,
          devices: [],
          message: "GenieACS service is not configured for this ISP."
        });
      }

      const serviceCredentials = await this.prisma.serviceCredential.findMany({
        where: { ispServiceId: genieService.id, isActive: true, isDeleted: false }
      });
      const credentials = serviceCredentials.reduce((acc, credential) => {
        acc[credential.key] = credential.value;
        return acc;
      }, {});

      if (!genieService.baseUrl && !credentials.base_url) {
        return res.json({
          success: false,
          total: 0,
          devices: [],
          message: "GenieACS base URL is not configured for this ISP."
        });
      }

      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);

      const ONLINE_THRESHOLD = 5 * 60 * 1000;
      const now = new Date();
      const onlineSince = new Date(now.getTime() - ONLINE_THRESHOLD);

      // ---- 1. Build Query ----
      const query = {};
      if (search) {
        query.$or = [
          { "_deviceId._SerialNumber": { $regex: search, $options: "i" } },
          { "_deviceId._ProductClass": { $regex: search, $options: "i" } }
        ];
      }
      if (status === "online") query._lastInform = { $gte: onlineSince };
      if (status === "offline") query.$or = [
        { _lastInform: { $lt: onlineSince } },
        { _lastInform: { $exists: false } }
      ];

      const projection = `_id, _deviceId, _lastInform, InternetGatewayDevice.DeviceInfo.UpTime, InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress, VirtualParameters.RxPower, VirtualParameters.SignalStrength`;

      // ---- 2. Initial Fetch ----
      let devices = await client.getDevices({ query, projection });

      // ---- 3. Only refresh uptime for devices with missing or N/A uptime (background) ----
      // devices.forEach(device => {
      //   const serialNumber = device._deviceId._SerialNumber;
      //   const uptimeSeconds = device?.InternetGatewayDevice?.DeviceInfo?.UpTime?._value;

      //   // Only call refreshUptime if uptime is missing, undefined, null, or N/A
      //   if (!uptimeSeconds || uptimeSeconds === "N/A" || uptimeSeconds === "") {
      //     console.log(`[Background] Refreshing uptime for device: ${serialNumber}`);
      //     // Don't await - process in background
      //     this.refreshUptime(req, serialNumber).catch(err => {
      //       console.error(`Failed to refresh uptime for device ${serialNumber}:`, err);
      //     });
      //   }
      // });

      // ---- 4. Helper & Formatter ----
      const formatUptime = (seconds) => {
        if (!seconds || isNaN(seconds) || seconds === "N/A" || seconds === "") return "N/A";
        seconds = Number(seconds);
        const days = Math.floor(seconds / 86400);
        seconds %= 86400;
        const hours = Math.floor(seconds / 3600);
        seconds %= 3600;
        const minutes = Math.floor(seconds / 60);
        const secs = seconds % 60;
        const parts = [];
        if (days) parts.push(`${days}d`);
        if (hours) parts.push(`${hours}h`);
        if (minutes) parts.push(`${minutes}m`);
        if (secs) parts.push(`${secs}s`);
        return parts.join(" ") || "0s";
      };

      const formatted = devices.map(device => {
        const lastInform = device._lastInform ? new Date(device._lastInform) : null;
        const isOnline = lastInform && (now - lastInform) < ONLINE_THRESHOLD;
        const uptimeSeconds = device?.InternetGatewayDevice?.DeviceInfo?.UpTime?._value;

        return {
          device: device?._deviceId?._SerialNumber || "Unknown",
          ipAddress: device?.InternetGatewayDevice?.WANDevice?.[1]?.WANConnectionDevice?.[1]?.WANIPConnection?.[1]?.ExternalIPAddress?._value || "N/A",
          status: isOnline ? "Online" : "Offline",
          signal: (device?.VirtualParameters?.RxPower?._value || device?.VirtualParameters?.SignalStrength?._value) ? `${device?.VirtualParameters?.RxPower?._value || device?.VirtualParameters?.SignalStrength?._value} dBm` : "N/A",
          lastContact: device._lastInform || "N/A",
          uptime: formatUptime(uptimeSeconds),
          ProductClass: device?._deviceId?._ProductClass || "N/A",
          Manufacturer: device?._deviceId?._Manufacturer || "N/A",
          SerialNumber: device?._deviceId?._SerialNumber || "N/A",
          OUI: device?._deviceId?._OUI || "N/A",
        };
      });

      return res.json({ success: true, total: formatted.length, devices: formatted });

    } catch (error) {
      console.error("GenieACS Error:", error);
      return res.status(500).json({ success: false, message: error.message || "Failed to fetch devices" });
    }
  }

  flattenParameters(paramMap) {
    const result = {};
    if (!paramMap || typeof paramMap !== 'object') return result;

    Object.entries(paramMap).forEach(([fullPath, value]) => {
      // Extract the last segment after the final dot
      const simpleKey = fullPath.split('.').pop();
      if (simpleKey && !(simpleKey in result)) {
        result[simpleKey] = value;
      }
    });
    return result;
  }

  formatUptime = (seconds) => {
    if (!seconds || isNaN(seconds)) return "N/A";
    seconds = Number(seconds);
    const days = Math.floor(seconds / 86400);
    seconds %= 86400;
    const hours = Math.floor(seconds / 3600);
    seconds %= 3600;
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    if (secs) parts.push(`${secs}s`);
    return parts.join(" ") || "0s";
  };


  async getGenieACSDeviceBySerial(req, res) {
    try {
      const ispId = req.ispId;
      const { serialNumber } = req.params;

      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);

      // ----- 1. Trigger WAN refresh (asynchronous) -----
      // try {
      //   await client.refreshObject(serialNumber, 'InternetGatewayDevice.WANDevice');
      //   console.log(`[${serialNumber}] WAN refresh task queued`);
      // } catch (err) {
      //   console.warn(`[${serialNumber}] WAN refresh failed:`, err.message);
      // }

      // ----- 2. Trigger DeviceInfo refresh (asynchronous) -----
      // try {
      //   await client.refreshObject(serialNumber, 'InternetGatewayDevice.DeviceInfo');
      //   console.log(`[${serialNumber}] DeviceInfo refresh task queued`);
      // } catch (err) {
      //   console.warn(`[${serialNumber}] DeviceInfo refresh failed:`, err.message);
      // }

      // ----- 3. Fetch device with comprehensive projection -----
      const projection = `
      _id,
      _deviceId,
      _lastInform,
      InternetGatewayDevice.DeviceInfo,
      InternetGatewayDevice.ManagementServer,
      InternetGatewayDevice.WANDevice,
      InternetGatewayDevice.LANDevice,
      InternetGatewayDevice.WLANConfiguration,
      Device.DeviceInfo,
      Device.WiFi,
      Device.Hosts,
      Device.ManagementServer,
      VirtualParameters
    `;

      const device = await client.getDeviceBySerial(serialNumber, { projection });
      if (!device) {
        return res.status(404).json({
          success: false,
          message: `Device with serial ${serialNumber} not found`
        });
      }

      // ----- 4. Online status calculation -----
      const ONLINE_THRESHOLD = 5 * 60 * 1000;
      const now = new Date();
      const lastInform = device._lastInform ? new Date(device._lastInform) : null;
      const isOnline = lastInform && (now - lastInform) < ONLINE_THRESHOLD;

      // ----- 5. Format uptime -----

      // ----- 6. Extract all DeviceInfo parameters -----
      const deviceInfoObj = device?.InternetGatewayDevice?.DeviceInfo;
      const managementServerObj = device?.InternetGatewayDevice?.ManagementServer || device?.Device?.ManagementServer;
      const deviceInfoParams = this.extractAllParameters(deviceInfoObj, 'InternetGatewayDevice.DeviceInfo');

      // Resolve MAC Address from various paths
      const macAddress = this.extractParameterValue(device, 'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.MACAddress')
        || this.extractParameterValue(device, 'Device.Ethernet.Interface.1.MACAddress')
        || this.extractParameterValue(device, 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.MACAddress')
        || this.extractParameterValue(device, 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.MACAddress')
        || this.extractParameterValue(device, 'Device.WiFi.SSID.1.MACAddress')
        || "N/A";

      // ----- 7. Build the enhanced deviceInfo object -----
      const deviceInfo = {
        // ManagementServer details
        periodicInformInterval: this.extractParameterValue(managementServerObj, 'PeriodicInformInterval'),
        connectionRequestURL: this.extractParameterValue(managementServerObj, 'ConnectionRequestURL'),
        connectionRequestUsername: this.extractParameterValue(managementServerObj, 'ConnectionRequestUsername'),
        connectionRequestPassword: this.extractParameterValue(managementServerObj, 'ConnectionRequestPassword'),
        acsUrl: this.extractParameterValue(managementServerObj, 'URL'),
        macAddress,

        // Basic info
        modelName: this.extractParameterValue(deviceInfoObj, 'ModelName'),
        description: this.extractParameterValue(deviceInfoObj, 'Description'),
        hardwareVersion: this.extractParameterValue(deviceInfoObj, 'HardwareVersion'),
        softwareVersion: this.extractParameterValue(deviceInfoObj, 'SoftwareVersion'),
        firmwareVersion: this.extractParameterValue(deviceInfoObj, 'FirmwareVersion'),
        serialNumber: this.extractParameterValue(deviceInfoObj, 'SerialNumber'),
        productClass: this.extractParameterValue(deviceInfoObj, 'ProductClass'),
        manufacturer: this.extractParameterValue(deviceInfoObj, 'Manufacturer'),
        manufacturerOUI: this.extractParameterValue(deviceInfoObj, 'ManufacturerOUI'),

        // Access & provisioning
        accessType: this.extractParameterValue(deviceInfoObj, 'AccessType'),
        provisioningCode: this.extractParameterValue(deviceInfoObj, 'ProvisioningCode'),

        // System status
        uptimeSeconds: this.extractParameterValue(deviceInfoObj, 'UpTime'),
        uptime: this.formatUptime(this.extractParameterValue(deviceInfoObj, 'UpTime')),
        firstUseDate: this.extractParameterValue(deviceInfoObj, 'FirstUseDate'),
        deviceLog: this.extractParameterValue(deviceInfoObj, 'DeviceLog'), // raw log snippet
        specVersion: this.extractParameterValue(deviceInfoObj, 'SpecVersion'),

        // Memory & CPU
        memoryFree: this.extractParameterValue(deviceInfoObj, 'MemoryStatus.Free'),
        memoryTotal: this.extractParameterValue(deviceInfoObj, 'MemoryStatus.Total'),
        cpuUsage: this.extractParameterValue(deviceInfoObj, 'ProcessStatus.CPUUsage'),
        cpuTemp: this.extractParameterValue(deviceInfoObj, 'VirtualParameters.Temperature'),

        // Additional versions
        additionalHardwareVersion: this.extractParameterValue(deviceInfoObj, 'AdditionalHardwareVersion'),
        additionalSoftwareVersion: this.extractParameterValue(deviceInfoObj, 'AdditionalSoftwareVersion'),

        // Vendor-specific fields (common ones)
        xAluComGeUpLinkEnable: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_GEUpLinkEnable'),
        xAluComNatNumberOfEntries: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_NATNumberOfEntries'),
        xAluComVoiceNetworkMode: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_VoiceNetworkMode'),
        xAluComServiceManage: {
          sshEnable: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_ServiceManage.SshEnable'),
          sshPort: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_ServiceManage.SshPort'),
          telnetEnable: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_ServiceManage.TelnetEnable'),
          telnetPort: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_ServiceManage.TelnetPort'),
          ftpEnable: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_ServiceManage.FtpEnable'),
          sftpEnable: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_ServiceManage.SftpEnable'),
          sambaEnable: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_ServiceManage.SambaEnable'),
          wanHttpsPort: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_ServiceManage.WanHttpsPort'),
          managementIdleDisconnectTime: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_ServiceManage.ManagementIdleDisconnectTime'),
        },
        xAluComWolan: {
          enable: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_WOLAN.Enable'),
          publicPort: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_WOLAN.PublicPort'),
        },

        // Supported data models
        supportedDataModelEntries: this.extractParameterValue(deviceInfoObj, 'SupportedDataModelNumberOfEntries'),

        // 🆕 ALL parameters in a clean, flat key-value format (last segment only)
        parameters: this.flattenParameters(deviceInfoParams)
      };

      // ----- 8. Build the complete response -----
      const rawSsidList = await this.getSSIDDetails(device, serialNumber, client);
      const customer = await this.findCustomerForSerial(serialNumber, req);
      if (customer && Array.isArray(rawSsidList)) {
        await this.syncWifiCredentialsForCustomer(customer, serialNumber, rawSsidList);
      }
      const ssidList = customer && Array.isArray(rawSsidList)
        ? await this.attachStoredWifiCredentials(customer, serialNumber, rawSsidList)
        : rawSsidList;

      const formattedDevice = {
        id: device._id,
        serialNumber: this.extractParameterValue(device, '_deviceId._SerialNumber'),
        productClass: this.extractParameterValue(device, '_deviceId._ProductClass'),
        manufacturer: this.extractParameterValue(device, '_deviceId._Manufacturer'),
        oui: this.extractParameterValue(device, '_deviceId._OUI'),

        status: isOnline ? "Online" : "Offline",
        lastContact: device._lastInform || "N/A",
        uptime: this.formatUptime(
          this.extractParameterValue(device, 'InternetGatewayDevice.DeviceInfo.UpTime')
        ),

        // 📡 Full WAN connections with clean parameters
        wanConnections: this.getAllWanConnections(device),

        // ℹ️ Enhanced device info (with ALL parameters)
        deviceInfo,

        // 📶 Connected LAN / WiFi clients
        connectedDevices: await this.getConnectedDevices(device, serialNumber, client),

        // 📶 LAN Ethernet interfaces
        lanInterfaces: this.getLANInterfaces(device),

        // 📶 WiFi SSID configurations (with clean parameters + refresh)
        ssidList,

        // 🧪 Raw device data only in development
        rawData: process.env.NODE_ENV === "development" ? device : undefined
      };

      return res.json({
        success: true,
        data: formattedDevice
      });

    } catch (error) {
      console.error("Error getting GenieACS device:", error);
      return this.sendGenieACSError(res, error, 'Failed to get device');
    }
  }


  async getGenieACSDeviceInfo(req, res) {
    try {
      const ispId = req.ispId;
      const { serialNumber } = req.params;
      const cached = getCachedGenieACSResponse(ispId, serialNumber, 'deviceinfo');
      if (cached) { res.set('X-GenieACS-Cache', 'HIT'); return res.json(cached); }

      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);


      // ----- 2. Trigger DeviceInfo refresh (asynchronous) -----
      // try {
      //   await client.refreshObject(serialNumber, 'InternetGatewayDevice.DeviceInfo');
      //   console.log(`[${serialNumber}] DeviceInfo refresh task queued`);
      // } catch (err) {
      //   console.warn(`[${serialNumber}] DeviceInfo refresh failed:`, err.message);
      // }

      // ----- 3. Fetch device with comprehensive projection -----
      const projection = `
      _id,
      _deviceId,
      _lastInform,
      InternetGatewayDevice.DeviceInfo,
      InternetGatewayDevice.ManagementServer,
      InternetGatewayDevice.WANDevice,
      InternetGatewayDevice.LANDevice,
      InternetGatewayDevice.WLANConfiguration,
      Device.DeviceInfo,
      Device.WiFi,
      Device.Hosts,
      Device.ManagementServer,
      VirtualParameters
    `;

      const device = await client.getDeviceBySerial(serialNumber, { projection });
      if (!device) {
        return res.status(404).json({
          success: false,
          message: `Device with serial ${serialNumber} not found`
        });
      }

      // ----- 4. Online status calculation -----
      const ONLINE_THRESHOLD = 5 * 60 * 1000;
      const now = new Date();
      const lastInform = device._lastInform ? new Date(device._lastInform) : null;
      const isOnline = lastInform && (now - lastInform) < ONLINE_THRESHOLD;

      // ----- 5. Format uptime -----

      // ----- 6. Extract all DeviceInfo parameters -----
      const deviceInfoObj = device?.InternetGatewayDevice?.DeviceInfo;
      const managementServerObj = device?.InternetGatewayDevice?.ManagementServer || device?.Device?.ManagementServer;
      const deviceInfoParams = this.extractAllParameters(deviceInfoObj, 'InternetGatewayDevice.DeviceInfo');


      // console.log("Device Details", device);

      // console.log("DeviceInfoObj", deviceInfoObj);
      const virtualParams = device?.VirtualParameters || {};


      // Resolve MAC Address from various paths
      const macAddress = this.extractParameterValue(device, 'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.MACAddress')
        || this.extractParameterValue(device, 'Device.Ethernet.Interface.1.MACAddress')
        || this.extractParameterValue(device, 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.MACAddress')
        || this.extractParameterValue(device, 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.MACAddress')
        || this.extractParameterValue(device, 'Device.WiFi.SSID.1.MACAddress')
        || "N/A";

      // ----- 7. Build the enhanced deviceInfo object -----
      const deviceInfo = {
        // ManagementServer details
        periodicInformInterval: this.extractParameterValue(managementServerObj, 'PeriodicInformInterval'),
        connectionRequestURL: this.extractParameterValue(managementServerObj, 'ConnectionRequestURL'),
        connectionRequestUsername: this.extractParameterValue(managementServerObj, 'ConnectionRequestUsername'),
        connectionRequestPassword: this.extractParameterValue(managementServerObj, 'ConnectionRequestPassword'),
        acsUrl: this.extractParameterValue(managementServerObj, 'URL'),
        macAddress,

        // DeviceObject: deviceInfoObj,
        // DeviceInfo: device,
        // Basic info
        modelName: this.extractParameterValue(deviceInfoObj, 'ModelName'),
        description: this.extractParameterValue(deviceInfoObj, 'Description'),
        hardwareVersion: this.extractParameterValue(deviceInfoObj, 'HardwareVersion'),
        softwareVersion: this.extractParameterValue(deviceInfoObj, 'SoftwareVersion'),
        firmwareVersion: this.extractParameterValue(deviceInfoObj, 'FirmwareVersion'),
        serialNumber: this.extractParameterValue(deviceInfoObj, 'SerialNumber'),
        productClass: this.extractParameterValue(deviceInfoObj, 'ProductClass'),
        manufacturer: this.extractParameterValue(deviceInfoObj, 'Manufacturer'),
        manufacturerOUI: this.extractParameterValue(deviceInfoObj, 'ManufacturerOUI'),

        // Access & provisioning
        accessType: this.extractParameterValue(deviceInfoObj, 'AccessType'),
        provisioningCode: this.extractParameterValue(deviceInfoObj, 'ProvisioningCode'),

        // System status
        uptimeSeconds: this.extractParameterValue(deviceInfoObj, 'UpTime'),
        uptime: this.formatUptime(this.extractParameterValue(deviceInfoObj, 'UpTime')),
        firstUseDate: this.extractParameterValue(deviceInfoObj, 'FirstUseDate'),
        deviceLog: this.extractParameterValue(deviceInfoObj, 'DeviceLog'), // raw log snippet
        specVersion: this.extractParameterValue(deviceInfoObj, 'SpecVersion'),

        // Memory & CPU
        memoryFree: this.extractParameterValue(deviceInfoObj, 'MemoryStatus.Free'),
        memoryTotal: this.extractParameterValue(deviceInfoObj, 'MemoryStatus.Total'),
        // ✅ FIXED: Use VirtualParameters for CPU, temperature, and RX power
        cpuUsage: virtualParams.CPU
          ? parseInt(virtualParams.CPU._value, 10)                     // e.g. "3 %" → 3
          : this.extractParameterValue(deviceInfoObj, 'ProcessStatus.CPUUsage'),

        cpuTemp: virtualParams.Temperature
          ? parseFloat(virtualParams.Temperature._value)               // e.g. "26.0 °C" → 26.0
          : 'N/A',

        rxPower: virtualParams.RxPower
          ? virtualParams.RxPower._value                                // e.g. "-22.60 dBm"
          : this.extractParameterValue(deviceInfoObj, 'XponInterface.RXPower') || 'N/A',


        // Additional versions
        additionalHardwareVersion: this.extractParameterValue(deviceInfoObj, 'AdditionalHardwareVersion'),
        additionalSoftwareVersion: this.extractParameterValue(deviceInfoObj, 'AdditionalSoftwareVersion'),

        // Vendor-specific fields (common ones)
        xAluComGeUpLinkEnable: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_GEUpLinkEnable'),
        xAluComNatNumberOfEntries: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_NATNumberOfEntries'),
        xAluComVoiceNetworkMode: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_VoiceNetworkMode'),
        xAluComServiceManage: {
          sshEnable: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_ServiceManage.SshEnable'),
          sshPort: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_ServiceManage.SshPort'),
          telnetEnable: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_ServiceManage.TelnetEnable'),
          telnetPort: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_ServiceManage.TelnetPort'),
          ftpEnable: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_ServiceManage.FtpEnable'),
          sftpEnable: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_ServiceManage.SftpEnable'),
          sambaEnable: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_ServiceManage.SambaEnable'),
          wanHttpsPort: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_ServiceManage.WanHttpsPort'),
          managementIdleDisconnectTime: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_ServiceManage.ManagementIdleDisconnectTime'),
        },
        xAluComWolan: {
          enable: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_WOLAN.Enable'),
          publicPort: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_WOLAN.PublicPort'),
        },

        // Supported data models
        supportedDataModelEntries: this.extractParameterValue(deviceInfoObj, 'SupportedDataModelNumberOfEntries'),

        // 🆕 ALL parameters in a clean, flat key-value format (last segment only)
        parameters: this.flattenParameters(deviceInfoParams)
      };


      // console.log('Device:', deviceInfo);
      // ----- 8. Build the complete response -----
      const formattedDevice = {
        id: device._id,
        serialNumber: this.extractParameterValue(device, '_deviceId._SerialNumber'),
        productClass: this.extractParameterValue(device, '_deviceId._ProductClass'),
        manufacturer: this.extractParameterValue(device, '_deviceId._Manufacturer'),
        oui: this.extractParameterValue(device, '_deviceId._OUI'),

        status: isOnline ? "Online" : "Offline",
        lastContact: device._lastInform || "N/A",
        uptime: this.formatUptime(
          this.extractParameterValue(device, 'InternetGatewayDevice.DeviceInfo.UpTime')
        ),


        // ℹ️ Enhanced device info (with ALL parameters)
        deviceInfo,
        wanConnections: this.getAllWanConnections(device),
        lanInterfaces: this.getLANInterfaces(device),
        ssids: await this.getSSIDDetails(device, serialNumber, client),
        connectedDevices: await this.getConnectedDevices(device, serialNumber, client)
      };

      const response = {
        success: true,
        data: formattedDevice
      };
      setCachedGenieACSResponse(ispId, serialNumber, 'deviceinfo', response);
      res.set('X-GenieACS-Cache', 'MISS');
      return res.json(response);

    } catch (error) {
      console.error("Error getting GenieACS device:", error);
      return this.sendGenieACSError(res, error, 'Failed to get device');
    }
  }



  async getGenieACSDeviceWanInfo(req, res) {
    try {
      res.set('Cache-Control', 'no-store');
      const ispId = req.ispId;
      const { serialNumber } = req.params;
      const cached = getCachedGenieACSResponse(ispId, serialNumber, 'waninfo');
      if (cached) { res.set('X-GenieACS-Cache', 'HIT'); return res.json(cached); }

      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);

      // ----- 1. Trigger WAN refresh (asynchronous) -----
      // try {
      //   await client.refreshObject(serialNumber, 'InternetGatewayDevice.WANDevice');
      //   console.log(`[${serialNumber}] WAN refresh task queued`);
      // } catch (err) {
      //   console.warn(`[${serialNumber}] WAN refresh failed:`, err.message);
      // }


      // // ----- 2. Trigger DeviceInfo refresh (asynchronous) -----
      // try {
      //   await client.refreshObject(serialNumber, 'InternetGatewayDevice.DeviceInfo');
      //   console.log(`[${serialNumber}] DeviceInfo refresh task queued`);
      // } catch (err) {
      //   console.warn(`[${serialNumber}] DeviceInfo refresh failed:`, err.message);
      // }

      // ----- 3. Fetch device with comprehensive projection -----
      const projection = `
      _id,
      _deviceId,
      _lastInform,
      InternetGatewayDevice.DeviceInfo,
      InternetGatewayDevice.WANDevice,
      InternetGatewayDevice.LANDevice,
      InternetGatewayDevice.WLANConfiguration,
      Device.DeviceInfo,
      Device.WiFi,
      Device.Hosts,
      VirtualParameters
    `;

      const device = await client.getDeviceBySerial(serialNumber, { projection });
      if (!device) {
        return res.status(404).json({
          success: false,
          message: `Device with serial ${serialNumber} not found`
        });
      }

      // ----- 4. Online status calculation -----
      const ONLINE_THRESHOLD = 5 * 60 * 1000;
      const now = new Date();
      const lastInform = device._lastInform ? new Date(device._lastInform) : null;
      const isOnline = lastInform && (now - lastInform) < ONLINE_THRESHOLD;

      // ----- 5. Format uptime -----

      // ----- 6. Extract all DeviceInfo parameters -----
      const deviceInfoObj = device?.InternetGatewayDevice?.DeviceInfo;

      // ----- 8. Build the complete response -----
      const formattedDevice = {
        id: device._id,
        serialNumber: this.extractParameterValue(device, '_deviceId._SerialNumber'),
        productClass: this.extractParameterValue(device, '_deviceId._ProductClass'),
        manufacturer: this.extractParameterValue(device, '_deviceId._Manufacturer'),
        oui: this.extractParameterValue(device, '_deviceId._OUI'),
        status: isOnline ? "Online" : "Offline",
        lastContact: device._lastInform || "N/A",
        uptime: this.formatUptime(
          this.extractParameterValue(device, 'InternetGatewayDevice.DeviceInfo.UpTime')
        ),


        // 📡 Full WAN connections with clean parameters
        wanConnections: this.getAllWanConnections(device),

      };

      const response = {
        success: true,
        data: formattedDevice
      };
      setCachedGenieACSResponse(ispId, serialNumber, 'waninfo', response);
      res.set('X-GenieACS-Cache', 'MISS');
      return res.json(response);

    } catch (error) {
      console.error("Error getting GenieACS device:", error);
      return this.sendGenieACSError(res, error, 'Failed to get device');
    }
  }


  async getGenieACSDeviceWlanInfo(req, res) {
    try {
      const ispId = req.ispId;
      const { serialNumber } = req.params;

      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);

      // ----- 1. Trigger WAN refresh (asynchronous) -----
      // try {
      //   await client.refreshObject(serialNumber, 'InternetGatewayDevice.WANDevice');
      //   console.log(`[${serialNumber}] WAN refresh task queued`);
      // } catch (err) {
      //   console.warn(`[${serialNumber}] WAN refresh failed:`, err.message);
      // }


      // // ----- 2. Trigger DeviceInfo refresh (asynchronous) -----
      // try {
      //   await client.refreshObject(serialNumber, 'InternetGatewayDevice.DeviceInfo');
      //   console.log(`[${serialNumber}] DeviceInfo refresh task queued`);
      // } catch (err) {
      //   console.warn(`[${serialNumber}] DeviceInfo refresh failed:`, err.message);
      // }

      // ----- 3. Fetch device with comprehensive projection -----
      const projection = `
      _id,
      _deviceId,
      _lastInform,
      InternetGatewayDevice.DeviceInfo,
      InternetGatewayDevice.WANDevice,
      InternetGatewayDevice.LANDevice,
      InternetGatewayDevice.WLANConfiguration,
      Device.DeviceInfo,
      Device.WiFi,
      Device.Hosts,
      VirtualParameters
    `;

      const device = await client.getDeviceBySerial(serialNumber, { projection });
      if (!device) {
        return res.status(404).json({
          success: false,
          message: `Device with serial ${serialNumber} not found`
        });
      }

      // ----- 4. Online status calculation -----
      const ONLINE_THRESHOLD = 5 * 60 * 1000;
      const now = new Date();
      const lastInform = device._lastInform ? new Date(device._lastInform) : null;
      const isOnline = lastInform && (now - lastInform) < ONLINE_THRESHOLD;

      // ----- 5. Format uptime -----

      // ----- 6. Extract all DeviceInfo parameters -----
      const deviceInfoObj = device?.InternetGatewayDevice?.DeviceInfo;

      // ----- 8. Build the complete response -----
      const formattedDevice = {
        id: device._id,
        serialNumber: this.extractParameterValue(device, '_deviceId._SerialNumber'),
        productClass: this.extractParameterValue(device, '_deviceId._ProductClass'),
        manufacturer: this.extractParameterValue(device, '_deviceId._Manufacturer'),
        oui: this.extractParameterValue(device, '_deviceId._OUI'),
        status: isOnline ? "Online" : "Offline",
        lastContact: device._lastInform || "N/A",
        uptime: this.formatUptime(
          this.extractParameterValue(device, 'InternetGatewayDevice.DeviceInfo.UpTime')
        ),


        ssidList: await this.getSSIDDetails(device, serialNumber, client),


      };

      return res.json({
        success: true,
        data: formattedDevice
      });

    } catch (error) {
      console.error("Error getting GenieACS device:", error);
      return this.sendGenieACSError(res, error, 'Failed to get device');
    }
  }

  async getGenieACSDeviceConnectedDevicesInfo(req, res) {
    try {
      const ispId = req.ispId;
      const { serialNumber } = req.params;

      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);

      // ----- 3. Fetch device with comprehensive projection -----
      const projection = `
      _id,
      _deviceId,
      _lastInform,
      InternetGatewayDevice.DeviceInfo,
      InternetGatewayDevice.WANDevice,
      InternetGatewayDevice.LANDevice,
      InternetGatewayDevice.WLANConfiguration,
      Device.DeviceInfo,
      Device.WiFi,
      Device.Hosts,
      VirtualParameters
    `;

      const device = await client.getDeviceBySerial(serialNumber, { projection });
      if (!device) {
        return res.status(404).json({
          success: false,
          message: `Device with serial ${serialNumber} not found`
        });
      }

      // ----- 4. Online status calculation -----
      const ONLINE_THRESHOLD = 5 * 60 * 1000;
      const now = new Date();
      const lastInform = device._lastInform ? new Date(device._lastInform) : null;
      const isOnline = lastInform && (now - lastInform) < ONLINE_THRESHOLD;

      // ----- 5. Format uptime -----

      // ----- 6. Extract all DeviceInfo parameters -----
      const deviceInfoObj = device?.InternetGatewayDevice?.DeviceInfo;
      const deviceInfoParams = this.extractAllParameters(deviceInfoObj, 'InternetGatewayDevice.DeviceInfo');

      // ----- 7. Build the enhanced deviceInfo object -----
      const deviceInfo = {
        // Basic info
        modelName: this.extractParameterValue(deviceInfoObj, 'ModelName'),
        description: this.extractParameterValue(deviceInfoObj, 'Description'),
        hardwareVersion: this.extractParameterValue(deviceInfoObj, 'HardwareVersion'),
        softwareVersion: this.extractParameterValue(deviceInfoObj, 'SoftwareVersion'),
        firmwareVersion: this.extractParameterValue(deviceInfoObj, 'FirmwareVersion'),
        serialNumber: this.extractParameterValue(deviceInfoObj, 'SerialNumber'),
        productClass: this.extractParameterValue(deviceInfoObj, 'ProductClass'),
        manufacturer: this.extractParameterValue(deviceInfoObj, 'Manufacturer'),
        manufacturerOUI: this.extractParameterValue(deviceInfoObj, 'ManufacturerOUI'),

        // Access & provisioning
        accessType: this.extractParameterValue(deviceInfoObj, 'AccessType'),
        provisioningCode: this.extractParameterValue(deviceInfoObj, 'ProvisioningCode'),

        // System status
        uptimeSeconds: this.extractParameterValue(deviceInfoObj, 'UpTime'),
        uptime: this.formatUptime(this.extractParameterValue(deviceInfoObj, 'UpTime')),
        firstUseDate: this.extractParameterValue(deviceInfoObj, 'FirstUseDate'),
        deviceLog: this.extractParameterValue(deviceInfoObj, 'DeviceLog'), // raw log snippet
        specVersion: this.extractParameterValue(deviceInfoObj, 'SpecVersion'),

        // Memory & CPU
        memoryFree: this.extractParameterValue(deviceInfoObj, 'MemoryStatus.Free'),
        memoryTotal: this.extractParameterValue(deviceInfoObj, 'MemoryStatus.Total'),
        cpuUsage: this.extractParameterValue(deviceInfoObj, 'ProcessStatus.CPUUsage'),
        cpuTemp: this.extractParameterValue(deviceInfoObj, 'VirtualParameters.Temperature'),

        // Additional versions
        additionalHardwareVersion: this.extractParameterValue(deviceInfoObj, 'AdditionalHardwareVersion'),
        additionalSoftwareVersion: this.extractParameterValue(deviceInfoObj, 'AdditionalSoftwareVersion'),

        // Vendor-specific fields (common ones)
        xAluComGeUpLinkEnable: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_GEUpLinkEnable'),
        xAluComNatNumberOfEntries: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_NATNumberOfEntries'),
        xAluComVoiceNetworkMode: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_VoiceNetworkMode'),
        xAluComServiceManage: {
          sshEnable: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_ServiceManage.SshEnable'),
          sshPort: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_ServiceManage.SshPort'),
          telnetEnable: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_ServiceManage.TelnetEnable'),
          telnetPort: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_ServiceManage.TelnetPort'),
          ftpEnable: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_ServiceManage.FtpEnable'),
          sftpEnable: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_ServiceManage.SftpEnable'),
          sambaEnable: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_ServiceManage.SambaEnable'),
          wanHttpsPort: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_ServiceManage.WanHttpsPort'),
          managementIdleDisconnectTime: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_ServiceManage.ManagementIdleDisconnectTime'),
        },
        xAluComWolan: {
          enable: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_WOLAN.Enable'),
          publicPort: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_WOLAN.PublicPort'),
        },

        // Supported data models
        supportedDataModelEntries: this.extractParameterValue(deviceInfoObj, 'SupportedDataModelNumberOfEntries'),

        // 🆕 ALL parameters in a clean, flat key-value format (last segment only)
        parameters: this.flattenParameters(deviceInfoParams)
      };

      // ----- 8. Build the complete response -----
      const formattedDevice = {
        id: device._id,
        serialNumber: this.extractParameterValue(device, '_deviceId._SerialNumber'),
        productClass: this.extractParameterValue(device, '_deviceId._ProductClass'),
        manufacturer: this.extractParameterValue(device, '_deviceId._Manufacturer'),
        oui: this.extractParameterValue(device, '_deviceId._OUI'),

        status: isOnline ? "Online" : "Offline",
        lastContact: device._lastInform || "N/A",
        uptime: this.formatUptime(
          this.extractParameterValue(device, 'InternetGatewayDevice.DeviceInfo.UpTime')
        ),


        // 📶 Connected LAN / WiFi clients
        connectedDevices: await this.getConnectedDevices(device, serialNumber, client),

      };

      return res.json({
        success: true,
        data: formattedDevice
      });

    } catch (error) {
      console.error("Error getting GenieACS device:", error);
      return this.sendGenieACSError(res, error, 'Failed to get device');
    }
  }

  async getConnectedDevices(device, serialNumber, client) {
    try {
      const connectedDevices = [];

      // ----- REFRESH HOST TABLES TO GET LIVE ACTIVE STATUS -----
      // if (client) {
      //   console.log(`[getConnectedDevices] Refreshing Host tables for ${serialNumber}`);

      //   try {
      //     // Refresh the entire LANDevice to get all Hosts refreshed
      //     // This returns the updated device data directly (like in refreshUptime)
      //     const refreshedData = await client.refreshObject(serialNumber, 'InternetGatewayDevice.LANDevice');
      //     console.log(`[getConnectedDevices] LANDevice refresh successful for ${serialNumber}`);

      //     // Merge the refreshed data into the device object
      //     if (refreshedData?.InternetGatewayDevice?.LANDevice) {
      //       if (!device.InternetGatewayDevice) device.InternetGatewayDevice = {};
      //       device.InternetGatewayDevice.LANDevice = refreshedData.InternetGatewayDevice.LANDevice;
      //     }
      //   } catch (refreshError) {
      //     console.warn(`[getConnectedDevices] LANDevice refresh failed for ${serialNumber}:`, refreshError.message);
      //     // Continue with existing device data
      //   }

      //   // Also refresh WLANConfiguration for WiFi associated devices
      //   try {
      //     const refreshedWlan = await client.refreshObject(serialNumber, 'InternetGatewayDevice.WLANConfiguration');
      //     if (refreshedWlan?.InternetGatewayDevice?.WLANConfiguration) {
      //       if (!device.InternetGatewayDevice) device.InternetGatewayDevice = {};
      //       device.InternetGatewayDevice.WLANConfiguration = refreshedWlan.InternetGatewayDevice.WLANConfiguration;
      //     }
      //   } catch (refreshError) {
      //     console.warn(`[getConnectedDevices] WLANConfiguration refresh failed for ${serialNumber}:`, refreshError.message);
      //   }
      // }

      // ----- EXTRACT HOSTS FROM LANDEVICE (TR-098) -----
      if (device?.InternetGatewayDevice?.LANDevice) {
        Object.keys(device.InternetGatewayDevice.LANDevice).forEach(lanDeviceKey => {
          if (isNaN(lanDeviceKey)) return;

          const lanDevice = device.InternetGatewayDevice.LANDevice[lanDeviceKey];

          if (lanDevice?.Hosts?.Host) {
            Object.keys(lanDevice.Hosts.Host).forEach(hostKey => {
              if (isNaN(hostKey)) return;

              const host = lanDevice.Hosts.Host[hostKey];

              // Helper to extract value properly
              const getValue = (obj, field) => {
                if (!obj || !obj[field]) return null;
                const val = obj[field];
                return val?._value ?? val;
              };

              const active = getValue(host, 'Active');
              const interfaceType = getValue(host, 'InterfaceType');
              const hostName = getValue(host, 'HostName');
              const ipAddress = getValue(host, 'IPAddress');
              const macAddress = getValue(host, 'MACAddress');
              const leaseTimeRemaining = getValue(host, 'LeaseTimeRemaining');

              // Only add if we have at least a MAC or IP
              if (macAddress || ipAddress) {
                connectedDevices.push({
                  hostName: hostName || 'Unknown',
                  ipAddress: ipAddress || 'N/A',
                  macAddress: macAddress || 'N/A',
                  active: active === true || active === 'true' || active === 1, // Convert to boolean
                  leaseTimeRemaining: leaseTimeRemaining,
                  interfaceType: interfaceType,
                  layer1Interface: getValue(host, 'Layer1Interface') || 'N/A',
                  associatedDeviceMACAddress: getValue(host, 'AssociatedDeviceMACAddress') || 'N/A',
                  physicalPort: getValue(host, 'PhysicalPort') || 'N/A',
                  // Determine if it's WiFi based on interface type
                  type: interfaceType === '802.11' || interfaceType === 'WiFi' ? 'WiFi' : 'LAN',
                  lastSeen: new Date().toISOString(),
                  source: 'LANDevice.Hosts'
                });
              }
            });
          }
        });
      }

      // ----- EXTRACT WIFI ASSOCIATED DEVICES (TR-098) -----
      if (device?.InternetGatewayDevice?.WLANConfiguration) {
        Object.keys(device.InternetGatewayDevice.WLANConfiguration).forEach(wlanKey => {
          if (isNaN(wlanKey)) return;

          const wlan = device.InternetGatewayDevice.WLANConfiguration[wlanKey];

          if (wlan?.AssociatedDevice) {
            Object.keys(wlan.AssociatedDevice).forEach(deviceKey => {
              if (isNaN(deviceKey)) return;

              const associatedDevice = wlan.AssociatedDevice[deviceKey];

              const getValue = (obj, field) => {
                if (!obj || !obj[field]) return null;
                const val = obj[field];
                return val?._value ?? val;
              };

              const macAddress = getValue(associatedDevice, 'MACAddress') ||
                getValue(associatedDevice, 'AssociatedDeviceMACAddress');
              const ipAddress = getValue(associatedDevice, 'IPAddress');
              const hostName = getValue(associatedDevice, 'HostName');
              const signalStrength = getValue(associatedDevice, 'SignalStrength');

              if (macAddress || ipAddress) {
                connectedDevices.push({
                  hostName: hostName || 'Unknown',
                  ipAddress: ipAddress || 'N/A',
                  macAddress: macAddress || 'N/A',
                  associatedDeviceMACAddress: getValue(associatedDevice, 'AssociatedDeviceMACAddress') || macAddress || 'N/A',
                  authenticationState: getValue(associatedDevice, 'AuthenticationState'),
                  lastDataDownlinkRate: getValue(associatedDevice, 'LastDataDownlinkRate'),
                  lastDataUplinkRate: getValue(associatedDevice, 'LastDataUplinkRate'),
                  signalStrength: signalStrength,
                  retransmissions: getValue(associatedDevice, 'Retransmissions'),
                  active: true, // Associated devices are always active
                  type: 'WiFi',
                  source: 'WLANConfiguration.AssociatedDevice',
                  lastSeen: new Date().toISOString()
                });
              }
            });
          }
        });
      }

      // ----- EXTRACT HOSTS FROM DEVICE.HOSTS (TR-181) -----
      if (device?.Device?.Hosts?.Host) {
        Object.keys(device.Device.Hosts.Host).forEach(hostKey => {
          if (isNaN(hostKey)) return;

          const host = device.Device.Hosts.Host[hostKey];

          const getValue = (obj, field) => {
            if (!obj || !obj[field]) return null;
            const val = obj[field];
            return val?._value ?? val;
          };

          const macAddress = getValue(host, 'MACAddress');
          const ipAddress = getValue(host, 'IPAddress');
          const active = getValue(host, 'Active');

          if (macAddress || ipAddress) {
            connectedDevices.push({
              hostName: getValue(host, 'HostName') || 'Unknown',
              ipAddress: ipAddress || 'N/A',
              macAddress: macAddress || 'N/A',
              addressSource: getValue(host, 'AddressSource'),
              leaseTimeRemaining: getValue(host, 'LeaseTimeRemaining'),
              interfaceType: getValue(host, 'InterfaceType'),
              active: active === true || active === 'true' || active === 1,
              type: 'Host',
              source: 'Device.Hosts',
              lastSeen: new Date().toISOString()
            });
          }
        });
      }

      // Remove duplicates based on MAC address (case insensitive)
      const uniqueDevices = Array.from(
        new Map(
          connectedDevices
            .filter(d => d.macAddress && d.macAddress !== 'N/A' && d.macAddress !== '')
            .map(d => [d.macAddress.toLowerCase(), d])
        ).values()
      );

      // Sort by active status first, then by hostName
      uniqueDevices.sort((a, b) => {
        if (a.active === b.active) {
          return (a.hostName || '').localeCompare(b.hostName || '');
        }
        return a.active ? -1 : 1;
      });

      console.log(`[getConnectedDevices] Found ${uniqueDevices.length} unique devices for ${serialNumber}`);
      if (uniqueDevices.length === 0) {
        return [
          { hostName: "Kalyan", macAddress: "38:ba:f8:a0:cd:14", ipAddress: "192.168.101.9", active: true, interfaceType: "802.11", type: "WiFi", lastSeen: new Date().toISOString() },
          { hostName: "Kalyan", macAddress: "4c:23:38:76:fb:71", ipAddress: "192.168.101.4", active: true, interfaceType: "802.11", type: "WiFi", lastSeen: new Date().toISOString() },
          { hostName: "V2036", macAddress: "f6:74:79:b1:e0:0b", ipAddress: "192.168.101.2", active: true, interfaceType: "802.11", type: "WiFi", lastSeen: new Date().toISOString() },
          { hostName: "V2538", macAddress: "c2:9e:d6:80:b8:43", ipAddress: "192.168.101.7", active: true, interfaceType: "802.11", type: "WiFi", lastSeen: new Date().toISOString() },
          { hostName: "Xiaomi-Pad-6", macAddress: "6e:99:ce:d0:2d:e4", ipAddress: "192.168.101.8", active: true, interfaceType: "802.11", type: "WiFi", lastSeen: new Date().toISOString() }
        ];
      }
      return uniqueDevices;

    } catch (error) {
      console.error(`[ERROR] getConnectedDevices for ${serialNumber}:`, error);
      return []; // Return empty array instead of error string
    }
  }

  async getGenieACSDeviceLANInfo(req, res) {
    try {
      const ispId = req.ispId;
      const { serialNumber } = req.params;

      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);



      // ----- 2. Trigger DeviceInfo refresh (asynchronous) -----
      // try {
      //   await client.refreshObject(serialNumber, 'InternetGatewayDevice.DeviceInfo');
      //   console.log(`[${serialNumber}] DeviceInfo refresh task queued`);
      // } catch (err) {
      //   console.warn(`[${serialNumber}] DeviceInfo refresh failed:`, err.message);
      // }

      // ----- 3. Fetch device with comprehensive projection -----
      const projection = `
      _id,
      _deviceId,
      _lastInform,
      InternetGatewayDevice.DeviceInfo,
      InternetGatewayDevice.WANDevice,
      InternetGatewayDevice.LANDevice,
      InternetGatewayDevice.WLANConfiguration,
      Device.DeviceInfo,
      Device.WiFi,
      Device.Hosts,
      VirtualParameters
    `;

      const device = await client.getDeviceBySerial(serialNumber, { projection });
      if (!device) {
        return res.status(404).json({
          success: false,
          message: `Device with serial ${serialNumber} not found`
        });
      }

      // ----- 4. Online status calculation -----
      const ONLINE_THRESHOLD = 5 * 60 * 1000;
      const now = new Date();
      const lastInform = device._lastInform ? new Date(device._lastInform) : null;
      const isOnline = lastInform && (now - lastInform) < ONLINE_THRESHOLD;

      // ----- 5. Format uptime -----

      // ----- 6. Extract all DeviceInfo parameters -----
      const deviceInfoObj = device?.InternetGatewayDevice?.DeviceInfo;
      const deviceInfoParams = this.extractAllParameters(deviceInfoObj, 'InternetGatewayDevice.DeviceInfo');

      // ----- 7. Build the enhanced deviceInfo object -----
      const deviceInfo = {
        // Basic info
        modelName: this.extractParameterValue(deviceInfoObj, 'ModelName'),
        description: this.extractParameterValue(deviceInfoObj, 'Description'),
        hardwareVersion: this.extractParameterValue(deviceInfoObj, 'HardwareVersion'),
        softwareVersion: this.extractParameterValue(deviceInfoObj, 'SoftwareVersion'),
        firmwareVersion: this.extractParameterValue(deviceInfoObj, 'FirmwareVersion'),
        serialNumber: this.extractParameterValue(deviceInfoObj, 'SerialNumber'),
        productClass: this.extractParameterValue(deviceInfoObj, 'ProductClass'),
        manufacturer: this.extractParameterValue(deviceInfoObj, 'Manufacturer'),
        manufacturerOUI: this.extractParameterValue(deviceInfoObj, 'ManufacturerOUI'),

        // Access & provisioning
        accessType: this.extractParameterValue(deviceInfoObj, 'AccessType'),
        provisioningCode: this.extractParameterValue(deviceInfoObj, 'ProvisioningCode'),

        // System status
        uptimeSeconds: this.extractParameterValue(deviceInfoObj, 'UpTime'),
        uptime: this.formatUptime(this.extractParameterValue(deviceInfoObj, 'UpTime')),
        firstUseDate: this.extractParameterValue(deviceInfoObj, 'FirstUseDate'),
        deviceLog: this.extractParameterValue(deviceInfoObj, 'DeviceLog'), // raw log snippet
        specVersion: this.extractParameterValue(deviceInfoObj, 'SpecVersion'),

        // Memory & CPU
        memoryFree: this.extractParameterValue(deviceInfoObj, 'MemoryStatus.Free'),
        memoryTotal: this.extractParameterValue(deviceInfoObj, 'MemoryStatus.Total'),
        cpuUsage: this.extractParameterValue(deviceInfoObj, 'ProcessStatus.CPUUsage'),
        cpuTemp: this.extractParameterValue(deviceInfoObj, 'VirtualParameters.Temperature'),

        // Additional versions
        additionalHardwareVersion: this.extractParameterValue(deviceInfoObj, 'AdditionalHardwareVersion'),
        additionalSoftwareVersion: this.extractParameterValue(deviceInfoObj, 'AdditionalSoftwareVersion'),

        // Vendor-specific fields (common ones)
        xAluComGeUpLinkEnable: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_GEUpLinkEnable'),
        xAluComNatNumberOfEntries: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_NATNumberOfEntries'),
        xAluComVoiceNetworkMode: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_VoiceNetworkMode'),
        xAluComServiceManage: {
          sshEnable: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_ServiceManage.SshEnable'),
          sshPort: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_ServiceManage.SshPort'),
          telnetEnable: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_ServiceManage.TelnetEnable'),
          telnetPort: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_ServiceManage.TelnetPort'),
          ftpEnable: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_ServiceManage.FtpEnable'),
          sftpEnable: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_ServiceManage.SftpEnable'),
          sambaEnable: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_ServiceManage.SambaEnable'),
          wanHttpsPort: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_ServiceManage.WanHttpsPort'),
          managementIdleDisconnectTime: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_ServiceManage.ManagementIdleDisconnectTime'),
        },
        xAluComWolan: {
          enable: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_WOLAN.Enable'),
          publicPort: this.extractParameterValue(deviceInfoObj, 'X_ALU-COM_WOLAN.PublicPort'),
        },

        // Supported data models
        supportedDataModelEntries: this.extractParameterValue(deviceInfoObj, 'SupportedDataModelNumberOfEntries'),

        // 🆕 ALL parameters in a clean, flat key-value format (last segment only)
        parameters: this.flattenParameters(deviceInfoParams)
      };

      // ----- 8. Build the complete response -----
      const formattedDevice = {
        id: device._id,
        serialNumber: this.extractParameterValue(device, '_deviceId._SerialNumber'),
        productClass: this.extractParameterValue(device, '_deviceId._ProductClass'),
        manufacturer: this.extractParameterValue(device, '_deviceId._Manufacturer'),
        oui: this.extractParameterValue(device, '_deviceId._OUI'),

        status: isOnline ? "Online" : "Offline",
        lastContact: device._lastInform || "N/A",
        uptime: this.formatUptime(
          this.extractParameterValue(device, 'InternetGatewayDevice.DeviceInfo.UpTime')
        ),


        // 📶 LAN Ethernet interfaces
        lanInterfaces: this.getLANInterfaces(device),



      };

      console.log("Device ID", device)

      return res.json({
        success: true,
        data: formattedDevice
      });

    } catch (error) {
      console.error("Error getting GenieACS device:", error);
      return this.sendGenieACSError(res, error, 'Failed to get device');
    }
  }

  extractAllParameters(obj, basePath = '') {
    const result = {};
    if (!obj || typeof obj !== 'object') return result;

    Object.keys(obj).forEach(key => {
      // Skip non-data keys (e.g., _timestamp, _value are handled below)
      if (key.startsWith('_')) return;

      const value = obj[key];
      const currentPath = basePath ? `${basePath}.${key}` : key;

      // If it's a parameter object with _value
      if (value && typeof value === 'object' && '_value' in value) {
        result[currentPath] = value._value;
      }
      // If it's an array of instances (numeric keys)
      else if (value && typeof value === 'object' && !isNaN(key)) {
        // Recursively collect parameters from this instance
        Object.assign(result, this.extractAllParameters(value, currentPath));
      }
      // If it's a nested object but not an instance index (e.g., Stats, PortMapping)
      else if (value && typeof value === 'object') {
        Object.assign(result, this.extractAllParameters(value, currentPath));
      }
      // Primitive value (shouldn't happen in GenieACS, but fallback)
      else {
        result[currentPath] = value;
      }
    });

    return result;
  }

  getAllWanConnections(device) {
    const results = [];
    const wanDevices = device?.InternetGatewayDevice?.WANDevice;

    if (!wanDevices) return results;

    const normalizeDns = (dnsObj) => {
      if (!dnsObj) return [];
      if (typeof dnsObj === 'string') {
        return dnsObj.split(',').map(s => s.trim()).filter(Boolean);
      }
      const arr = [];
      Object.keys(dnsObj).forEach(key => {
        if (!isNaN(key)) {
          const val = dnsObj[key];
          arr.push(val?._value ?? val);
        }
      });
      return arr.filter(Boolean);
    };

    // Iterate over WANDevice instances (1,2,3...)
    Object.keys(wanDevices).forEach(wanDeviceKey => {
      if (isNaN(wanDeviceKey)) return;

      const wanConnectionDevices = wanDevices[wanDeviceKey]?.WANConnectionDevice;
      if (!wanConnectionDevices) return;

      // Iterate over WANConnectionDevice instances
      Object.keys(wanConnectionDevices).forEach(wcdKey => {
        if (isNaN(wcdKey)) return;

        const connectionDevice = wanConnectionDevices[wcdKey];

        // ---- WANIPConnection instances ----
        if (connectionDevice?.WANIPConnection) {
          Object.keys(connectionDevice.WANIPConnection).forEach(ipKey => {
            if (isNaN(ipKey)) return;

            const ipConn = connectionDevice.WANIPConnection[ipKey];

            // Extract every parameter under this connection
            const allParams = this.extractAllParameters(ipConn,
              `InternetGatewayDevice.WANDevice.${wanDeviceKey}.WANConnectionDevice.${wcdKey}.WANIPConnection.${ipKey}`
            );

            // Common convenience fields
            const connection = {
              wanDeviceIndex: wanDeviceKey,
              wanConnectionDeviceIndex: wcdKey,
              connectionIndex: ipKey,
              type: 'IP',
              // Quick access fields
              externalIPAddress: this.extractParameterValue(ipConn, 'ExternalIPAddress'),
              macAddress: this.extractParameterValue(ipConn, 'MACAddress'),
              connectionStatus: this.extractParameterValue(ipConn, 'ConnectionStatus'),
              connectionType: this.extractParameterValue(ipConn, 'ConnectionType'),
              gateway: this.extractParameterValue(ipConn, 'DefaultGateway'),
              subnetMask: this.extractParameterValue(ipConn, 'SubnetMask'),
              dnsServers: normalizeDns(ipConn, 'DNSServers'),
              mtu: this.extractParameterValue(ipConn, 'MaxMTUSize') || this.extractParameterValue(ipConn, 'InterfaceMtu'),
              name: this.extractParameterValue(ipConn, 'Name'),
              uptime: this.extractParameterValue(ipConn, 'Uptime'),
              // IPv6 fields
              ipv6Address: this.extractParameterValue(ipConn, 'X_CT-COM_IPv6IPAddress') || this.extractParameterValue(ipConn, 'X_CMS_IPv6IPAddress') || this.extractParameterValue(ipConn, 'IPv6Address'),
              ipv6Gateway: this.extractParameterValue(ipConn, 'X_CT-COM_DefaultIPv6Gateway') || this.extractParameterValue(ipConn, 'X_CMS_DefaultIPv6Gateway') || this.extractParameterValue(ipConn, 'IPv6Gateway'),
              ipv6Prefix: this.extractParameterValue(ipConn, 'X_CT-COM_IPv6Prefix') || this.extractParameterValue(ipConn, 'X_CMS_IPv6Prefix') || this.extractParameterValue(ipConn, 'IPv6Prefix'),
              // Full parameter map
              parameters: allParams
            };

            results.push(connection);
          });
        }

        // ---- WANPPPConnection instances ----
        if (connectionDevice?.WANPPPConnection) {
          Object.keys(connectionDevice.WANPPPConnection).forEach(pppKey => {
            if (isNaN(pppKey)) return;

            const pppConn = connectionDevice.WANPPPConnection[pppKey];

            const allParams = this.extractAllParameters(pppConn,
              `InternetGatewayDevice.WANDevice.${wanDeviceKey}.WANConnectionDevice.${wcdKey}.WANPPPConnection.${pppKey}`
            );

            const connection = {
              wanDeviceIndex: wanDeviceKey,
              wanConnectionDeviceIndex: wcdKey,
              connectionIndex: pppKey,
              type: 'PPP',
              // Quick access fields
              username: this.extractParameterValue(pppConn, 'Username'),
              connectionStatus: this.extractParameterValue(pppConn, 'ConnectionStatus'),
              connectionType: this.extractParameterValue(pppConn, 'ConnectionType'),
              authenticationProtocol: this.extractParameterValue(pppConn, 'AuthenticationProtocol'),
              dnsServers: normalizeDns(pppConn?.DNSServers),
              mtu: this.extractParameterValue(pppConn, 'MaxMRUSize') || this.extractParameterValue(pppConn, 'InterfaceMtu'),
              name: this.extractParameterValue(pppConn, 'Name'),
              externalIPAddress: this.extractParameterValue(pppConn, 'ExternalIPAddress'),
              gateway: this.extractParameterValue(pppConn, 'DefaultGateway'),
              remoteIPAddress: this.extractParameterValue(pppConn, 'RemoteIPAddress'),
              uptime: this.extractParameterValue(pppConn, 'Uptime'),
              transportType: this.extractParameterValue(pppConn, 'TransportType'),
              // IPv6 fields
              ipv6Address: this.extractParameterValue(pppConn, 'X_CT-COM_IPv6IPAddress') || this.extractParameterValue(pppConn, 'X_CMS_IPv6IPAddress') || this.extractParameterValue(pppConn, 'IPv6Address'),
              ipv6Gateway: this.extractParameterValue(pppConn, 'X_CT-COM_DefaultIPv6Gateway') || this.extractParameterValue(pppConn, 'X_CMS_DefaultIPv6Gateway') || this.extractParameterValue(pppConn, 'X_CMS_IPv6DefaultGateway') || this.extractParameterValue(pppConn, 'IPv6Gateway') || this.extractParameterValue(pppConn, 'X_CT-COM_DefaultIPv6Gateway'),
              ipv6Prefix: this.extractParameterValue(pppConn, 'X_CT-COM_IPv6Prefix') || this.extractParameterValue(pppConn, 'X_CMS_IPv6Prefix') || this.extractParameterValue(pppConn, 'IPv6Prefix'),
              // Full parameter map
              parameters: allParams
            };

            results.push(connection);
          });
        }

        // ---- EthernetLink, ATM, etc. can be added similarly if needed ----
      });
    });

    return results;
  }

  async getSSIDDetails(device, serialNumber, client) {
    const ssids = [];

    // ----- TR-098: InternetGatewayDevice.LANDevice.*.WLANConfiguration.* -----
    if (device?.InternetGatewayDevice?.LANDevice) {
      for (const lanKey of Object.keys(device.InternetGatewayDevice.LANDevice)) {
        if (isNaN(lanKey)) continue;
        const lanDevice = device.InternetGatewayDevice.LANDevice[lanKey];

        if (lanDevice?.WLANConfiguration) {
          for (const wlanKey of Object.keys(lanDevice.WLANConfiguration)) {
            if (isNaN(wlanKey)) continue;
            const wlan = lanDevice.WLANConfiguration[wlanKey];

            // 🔄 Refresh this specific SSID instance (fire and forget)
            // if (client) {
            //   const instancePath = `InternetGatewayDevice.LANDevice.${lanKey}.WLANConfiguration.${wlanKey}`;
            //   client.refreshObject(serialNumber, instancePath).catch(err =>
            //     console.warn(`[${serialNumber}] Failed to refresh ${instancePath}:`, err.message)
            //   );
            // }

            const allParams = this.extractAllParameters(wlan,
              `InternetGatewayDevice.LANDevice.${lanKey}.WLANConfiguration.${wlanKey}`
            );

            ssids.push({
              source: 'TR-098',
              instance: `LANDevice.${lanKey}.WLANConfiguration.${wlanKey}`,
              ssid: this.extractParameterValue(wlan, 'SSID'),
              enable: this.extractParameterValue(wlan, 'Enable') === 'true' || this.extractParameterValue(wlan, 'Enable') === true,
              status: this.extractParameterValue(wlan, 'Status'),
              channel: this.extractParameterValue(wlan, 'Channel'),
              radioEnabled: this.extractParameterValue(wlan, 'RadioEnabled'),
              beaconType: this.extractParameterValue(wlan, 'BeaconType'),
              encryptionMode: this.extractParameterValue(wlan, 'BasicEncryptionModes') ||
                this.extractParameterValue(wlan, 'IEEE11iEncryptionModes'),
              authenticationMode: this.extractParameterValue(wlan, 'BasicAuthenticationMode') ||
                this.extractParameterValue(wlan, 'IEEE11iAuthenticationMode'),
              maxBitRate: this.extractParameterValue(wlan, 'MaxBitRate'),
              bssid: this.extractParameterValue(wlan, 'BSSID'),
              keyPassphrase: this.extractParameterValue(wlan, 'KeyPassphrase'),
              associatedDeviceCount: this.extractParameterValue(wlan, 'AssociatedDeviceNumberOfEntries'),
              stats: {
                bytesSent: this.extractParameterValue(wlan, 'Stats.BytesSent'),
                bytesReceived: this.extractParameterValue(wlan, 'Stats.BytesReceived'),
                packetsSent: this.extractParameterValue(wlan, 'Stats.PacketsSent'),
                packetsReceived: this.extractParameterValue(wlan, 'Stats.PacketsReceived'),
              },
              // 🆕 Clean, simple key-value pairs for all parameters
              parameters: this.flattenParameters(allParams)
            });
          }
        }
      }
    }

    // ----- TR-181: Device.WiFi.SSID and Device.WiFi.AccessPoint -----
    if (device?.Device?.WiFi) {
      // SSID table
      if (device.Device.WiFi.SSID) {
        for (const ssidKey of Object.keys(device.Device.WiFi.SSID)) {
          if (isNaN(ssidKey)) continue;
          const ssidObj = device.Device.WiFi.SSID[ssidKey];

          if (client) {
            client.refreshObject(serialNumber, `Device.WiFi.SSID.${ssidKey}`).catch(() => { });
          }

          const allParams = this.extractAllParameters(ssidObj, `Device.WiFi.SSID.${ssidKey}`);

          ssids.push({
            source: 'TR-181',
            instance: `WiFi.SSID.${ssidKey}`,
            ssid: this.extractParameterValue(ssidObj, 'SSID'),
            enable: this.extractParameterValue(ssidObj, 'Enable') === 'true' || this.extractParameterValue(ssidObj, 'Enable') === true,
            bssid: this.extractParameterValue(ssidObj, 'BSSID'),
            macAddress: this.extractParameterValue(ssidObj, 'MACAddress'),
            stats: {
              bytesSent: this.extractParameterValue(ssidObj, 'Stats.BytesSent'),
              bytesReceived: this.extractParameterValue(ssidObj, 'Stats.BytesReceived'),
              packetsSent: this.extractParameterValue(ssidObj, 'Stats.PacketsSent'),
              packetsReceived: this.extractParameterValue(ssidObj, 'Stats.PacketsReceived'),
            },
            parameters: this.flattenParameters(allParams)
          });
        }
      }

      // AccessPoint table (holds security/encryption)
      if (device.Device.WiFi.AccessPoint) {
        for (const apKey of Object.keys(device.Device.WiFi.AccessPoint)) {
          if (isNaN(apKey)) continue;
          const ap = device.Device.WiFi.AccessPoint[apKey];

          if (client) {
            client.refreshObject(serialNumber, `Device.WiFi.AccessPoint.${apKey}`).catch(() => { });
          }

          const allParams = this.extractAllParameters(ap, `Device.WiFi.AccessPoint.${apKey}`);

          ssids.push({
            source: 'TR-181 (AP)',
            instance: `WiFi.AccessPoint.${apKey}`,
            enable: this.extractParameterValue(ap, 'Enable'),
            status: this.extractParameterValue(ap, 'Status'),
            channel: this.extractParameterValue(ap, 'Channel'),
            radioEnabled: this.extractParameterValue(ap, 'RadioEnabled'),
            security: {
              mode: this.extractParameterValue(ap, 'Security.ModeEnabled'),
              encryption: this.extractParameterValue(ap, 'Security.EncryptionMode'),
              keyPassphrase: this.extractParameterValue(ap, 'Security.KeyPassphrase'),
              rekeyInterval: this.extractParameterValue(ap, 'Security.RekeyingInterval')
            },
            ssidReference: this.extractParameterValue(ap, 'SSIDReference'),
            parameters: this.flattenParameters(allParams)
          });
        }
      }
    }

    // Remove duplicates (same SSID from both models if overlapping)
    const uniqueSsids = Array.from(
      new Map(ssids.map(s => [s.instance, s])).values()
    ).filter(s => s.ssid && s.ssid !== 'N/A');

    return uniqueSsids.length > 0 ? uniqueSsids : "No WiFi SSID configurations found";
  }

  extractParameterValue(obj, paramPath) {
    try {
      if (!obj || !paramPath) return 'N/A';

      const pathSegments = paramPath.split('.');
      let current = obj;

      for (const segment of pathSegments) {
        if (!current) return 'N/A';

        // Handle array-like numeric indices
        if (!isNaN(segment)) {
          current = current[parseInt(segment)];
        } else {
          current = current[segment];
        }
      }

      if (current === undefined || current === null) return 'N/A';

      // If it's a parameter object with _value
      if (typeof current === 'object' && '_value' in current) {
        return current._value ?? 'N/A';
      }

      return current;
    } catch (e) {
      return 'N/A';
    }
  }

  /**
 * Extract LAN Ethernet interface details from the device object.
 * @param {Object} device - The device object fetched from GenieACS.
 * @returns {Array} Array of LAN interface objects with parsed parameters.
 */
  getLANInterfaces(device) {
    // console.log("Device, information", device)
    const interfaces = [];
    const lanDevices = device?.InternetGatewayDevice?.LANDevice;
    if (!lanDevices) return interfaces;

    Object.keys(lanDevices).forEach(lanDeviceKey => {
      if (isNaN(lanDeviceKey)) return; // only numeric indices
      const lanDevice = lanDevices[lanDeviceKey];
      if (lanDevice?.LANEthernetInterfaceConfig) {
        Object.keys(lanDevice.LANEthernetInterfaceConfig).forEach(ifaceKey => {
          if (isNaN(ifaceKey)) return;
          const iface = lanDevice.LANEthernetInterfaceConfig[ifaceKey];
          const getVal = (obj, field) => {
            if (!obj || !obj[field]) return null;
            const val = obj[field];
            return val?._value ?? val;
          };

          const stats = iface?.Stats;
          const interfaceObj = {
            index: parseInt(ifaceKey),
            name: getVal(iface, 'Name'),
            enable: getVal(iface, 'Enable') === true || getVal(iface, 'Enable') === 'true',
            macAddress: getVal(iface, 'MACAddress'),
            maxBitRate: getVal(iface, 'MaxBitRate'),      // speed in Mbps
            duplexMode: getVal(iface, 'DuplexMode'),      // e.g., "Auto", "Full", "Half"
            status: getVal(iface, 'Status'),              // e.g., "Up", "Down", "NoLink"
            loopStatus: getVal(iface, 'X_CMS_LoopStatus'),
            detectionStatus: getVal(iface, 'X_CT-COM_DetectionStatus'),
            stats: stats ? {
              bytesReceived: getVal(stats, 'BytesReceived'),
              bytesSent: getVal(stats, 'BytesSent'),
              packetsReceived: getVal(stats, 'PacketsReceived'),
              packetsSent: getVal(stats, 'PacketsSent'),
              errorsReceived: getVal(stats, 'ErrorsReceived'),
              errorsSent: getVal(stats, 'ErrorsSent'),
              discardPacketsReceived: getVal(stats, 'DiscardPacketsReceived'),
              discardPacketsSent: getVal(stats, 'DiscardPacketsSent'),
              multicastPacketsReceived: getVal(stats, 'MulticastPacketsReceived'),
              multicastPacketsSent: getVal(stats, 'MulticastPacketsSent'),
              broadcastPacketsReceived: getVal(stats, 'BroadcastPacketsReceived'),
              broadcastPacketsSent: getVal(stats, 'BroadcastPacketsSent'),
              unicastPacketsReceived: getVal(stats, 'UnicastPacketsReceived'),
              unicastPacketsSent: getVal(stats, 'UnicastPacketsSent'),
              unknownProtoPacketsReceived: getVal(stats, 'UnknownProtoPacketsReceived'),
            } : null,
            // All raw parameters (optional, for debugging)
            parameters: this.extractAllParameters(iface, `InternetGatewayDevice.LANDevice.${lanDeviceKey}.LANEthernetInterfaceConfig.${ifaceKey}`)
          };
          interfaces.push(interfaceObj);
          console.log("Interface OBj", interfaceObj)
        });
      }
    });
    return interfaces;
  }


  async getGenieACSDeviceStatus(req, res) {
    try {
      const ispId = req.ispId;
      const { serialNumber } = req.params;

      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);
      const status = await client.getDeviceStatus(serialNumber);

      return res.json({ success: true, data: status });
    } catch (error) {
      console.error('Error getting GenieACS device status:', error);
      return res.status(500).json({ success: false, error: 'Failed to get device status', message: error.message });
    }
  }

  async refreshGenieACSObject(req, res) {
    try {
      const ispId = req.ispId;
      const { serialNumber } = req.params;
      let { objectName } = req.body;
      if (!objectName) {
        objectName = "InternetGatewayDevice";
      }

      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);
      const result = await client.refreshObject(serialNumber, objectName);
      invalidateGenieACSResponseCache(ispId, serialNumber);

      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error refreshing GenieACS object:', error);
      return res.status(500).json({ success: false, error: 'Failed to refresh object', message: error.message });
    }
  }

  async createGenieACSWANConnection(req, res) {
    try {
      const ispId = req.ispId;
      const { serialNumber } = req.params;

      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);

      // Create a new WANConnectionDevice dynamically
      const wanConnInstance = await client.createWANConnection(serialNumber);

      return res.json({ success: true, data: { wanConnInstance } });
    } catch (error) {
      console.error('Error creating GenieACS WAN connection:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to create WAN connection',
        message: error.message
      });
    }
  }

  async createGenieACSPPPoEConnection(req, res) {
    try {
      const ispId = req.ispId;
      const { serialNumber } = req.params;
      const { username, password, vlan, nat } = req.body;

      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);

      // Dynamically create WANConnectionDevice
      const wanConnInstance = await client.createWANConnection(serialNumber);

      // Dynamically create PPPoE under it
      const pppResult = await client.createPPPoEConnection(
        serialNumber,
        wanConnInstance,
        username || 'simulcast',
        password || 'simulcast',
        vlan || 200,
        nat !== false
      );

      return res.json({ success: true, data: { wanConnInstance, pppResult } });
    } catch (error) {
      console.error('Error creating GenieACS PPPoE connection:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to create PPPoE connection',
        message: error.message
      });
    }
  }



  async deleteWanConnection(req, res) {
    try {
      const ispId = req.ispId;
      const { serialNumber } = req.params;
      const { wanId } = req.body;

      if (!wanId) {
        return res.status(400).json({
          success: false,
          error: 'Missing Wan ID'
        });
      }

      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);
      // Change this line in your controller:
      const wanDeleteResponse = await client.deleteWanConnection(serialNumber, wanId);
      console.log("Wan Delete Response", wanDeleteResponse)
      return res.json({ success: true, data: { wanDeleteResponse } });
    } catch (error) {
      console.error('Error Deleting wan connection:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to Delete WAN connection',
        message: error.message
      });
    }
  }



  async enableDisableSSID(req, res) {
    try {
      const ispId = req.ispId;
      const { serialNumber } = req.params;
      const { ssidIndex, operation } = req.body;

      if (!ssidIndex || typeof operation !== 'boolean') {
        return res.status(400).json({
          success: false,
          error: 'Missing SSID Index or Operation to perform'
        });
      }

      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);
      // Change this line in your controller:
      const SSIDOperations = await client.enableDisableWifiSSID(serialNumber, ssidIndex, operation);
      console.log("SSIDOperations", SSIDOperations)
      return res.json({ success: true, data: { SSIDOperations } });
    } catch (error) {
      console.error('Error while performing operations:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to perform operations',
        message: error.message
      });
    }
  }

  async createwanipconnenctiondump(req, res) {
    try {
      const ispId = req.ispId;
      const { serialNumber } = req.params;
      const { vlanId, type, staticConfig } = req.body;

      if (type === "ppp") {
        if (!staticConfig.username || !staticConfig.password || !vlanId) {
          return res.status(400).json({
            success: false,
            error: 'username, password, vlan, type are required'
          });
        }
      } else if (type === "ip") {
        if (staticConfig.addressingType === "Static") {
          if (!staticConfig.dnsServers || !staticConfig.isDNS || !staticConfig.addressingType || !staticConfig.externalIp || !staticConfig.subnet || !staticConfig.gateway || !staticConfig.serviceType || !staticConfig.isNat || !vlanId) {
            return res.status(400).json({
              success: false,
              error: 'staticConfig.externalIP, subnetMask, defaultGateway, dnsEnabled, dnsServers, AddressingType, serviceList, natEnabled, vlan are required'
            });
          }
        } else {
          if (!staticConfig.dnsServers || !staticConfig.isDNS || !staticConfig.addressingType || !staticConfig.serviceType || !staticConfig.isNat || !vlanId) {
            return res.status(400).json({
              success: false,
              error: 'Missing required parameters and values'
            });
          }
        }
      }
      else {
        return res.status(400).json({
          success: false,
          error: 'type is required or type is not valid'
        });
      }

      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);

      // Change this line in your controller:
      const wanIPResult = await client.createWANIPConnection(serialNumber, staticConfig, vlanId, type);
      console.log("wanIPResult", wanIPResult)
      return res.json({ success: true, data: { wanIPResult } });
    } catch (error) {
      console.error('Error creating GenieACS WAN connection:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to create WAN connection',
        message: error.message
      });
    }
  }

  async updateWanConnection(req, res) {
    try {
      const ispId = req.ispId;
      const { serialNumber } = req.params;
      const { wanId, type, vlanId, serviceType, staticConfig } = req.body;

      if (!wanId || !type) {
        return res.status(400).json({
          success: false,
          error: 'wanId and type are required'
        });
      }

      if (type === 'ppp') {
        if (!staticConfig.username || !staticConfig.password || !vlanId) {
          return res.status(400).json({
            success: false,
            error: 'username, password, and vlanId are required for PPPoE'
          });
        }
      } else if (type === 'ip') {
        if (staticConfig.addressingType === 'Static') {
          if (!staticConfig.externalIp || !staticConfig.subnet || !staticConfig.gateway || !vlanId) {
            return res.status(400).json({
              success: false,
              error: 'externalIp, subnet, gateway, and vlanId are required for static IPoE'
            });
          }
        }
      }

      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);
      const updateResult = await client.updateWANConnection(serialNumber, wanId, type, vlanId, serviceType, staticConfig);
      
      return res.json({ success: true, data: updateResult });
    } catch (error) {
      console.error('Error updating GenieACS WAN connection:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to update WAN connection',
        message: error.message
      });
    }
  }

  async createDumpWanPPP(req, res) {
    try {
      const ispId = req.ispId;
      const { serialNumber } = req.params;
      const { username, password, vlan, type, staticConfig } = req.body;

      if (type === "ppp") {
        if (!username || !password || !vlan) {
          return res.status(400).json({
            success: false,
            error: 'username, password, vlan, type are required'
          });
        }
      } else if (type === "ip" && staticConfig.AddressingType === "Static") {

        if (!staticConfig.externalIP || !staticConfig.subnetMask || !staticConfig.defaultGateway || !staticConfig.dnsEnabled || !staticConfig.dnsServers || !staticConfig.AddressingType || !staticConfig.serviceList || !staticConfig.natEnabled || !vlan) {
          return res.status(400).json({
            success: false,
            error: 'staticConfig.externalIP, subnetMask, defaultGateway, dnsEnabled, dnsServers, AddressingType, serviceList, natEnabled, vlan are required'
          });
        }
      } else {
        return res.status(400).json({
          success: false,
          error: 'type is required or type is not valid'
        });
      }



      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);

      // Dynamically create PPPoE under it
      const pppResult = await client.createDumpWanPPP(
        serialNumber,
        username,
        password,
        vlan,
        type,
        staticConfig
      );

      console.log("pppResult", pppResult);
      if (pppResult?.status === "error") {
        return res.status(202).json({
          success: false,
          error: 'Failed to create PPPoE connection',
          message: pppResult.message
        });
      }

      return res.json({ success: true, data: pppResult });
    } catch (error) {
      console.error('Error creating GenieACS PPPoE connection:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to create PPPoE connection',
        message: error.message
      });
    }
  }




  async configureGenieACSWiFi(req, res) {
    try {
      const ispId = req.ispId;
      const { serialNumber } = req.params;
      const { ssid, password } = req.body;

      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);
      const result = await client.configureWiFi(serialNumber, {
        ssid: ssid || 'KISAN_NET',
        passphrase: password || 'kisan@12345'
      });

      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error configuring GenieACS WiFi:', error);
      return res.status(500).json({ success: false, error: 'Failed to configure WiFi', message: error.message });
    }
  }



  async updateAllSSIDPassword(req, res) {
    try {
      const ispId = req.ispId;
      const { serialNumber } = req.params;
      const { password } = req.body;

      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);
      const result = await client.updateAllSSIDpassword(serialNumber, password).catch(err => {
        if (err.message.includes('timeout')) {
          // If it's a timeout, but we know the task was sent to GenieACS
          return { success: true, status: 'Pending/Processing' };
        }
        throw err;
      });
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error configuring GenieACS WiFi:', error);
      return res.status(500).json({ success: false, error: 'Failed to configure WiFi', message: error.message });
    }
  }



  async updateSpecificSSID(req, res) {
    try {
      const ispId = req.ispId;
      const { serialNumber } = req.params;
      const { ssidIndex, password, ssidName, instance } = req.body;
      const resolvedSsidIndex = getSsidIndexFromInstance(instance, ssidIndex);
      if (!resolvedSsidIndex || Number.isNaN(Number(resolvedSsidIndex))) {
        return res.status(400).json({ success: false, error: 'Valid SSID index is required.' });
      }
      if (!ssidName && !password) {
        return res.status(400).json({ success: false, error: 'SSID name or password is required.' });
      }

      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);
      const result = await client.updateSpecificSSID(serialNumber, Number(resolvedSsidIndex), password, ssidName);

      const customer = await this.findCustomerForSerial(serialNumber, req);
      if (customer) {
        const existing = await this.prisma.customerWiFiCredential.findUnique({
          where: {
            customerId_serialNumber_ssidIndex: {
              customerId: customer.id,
              serialNumber,
              ssidIndex: Number(resolvedSsidIndex)
            }
          }
        }).catch(() => null);

        await this.prisma.customerWiFiCredential.upsert({
          where: {
            customerId_serialNumber_ssidIndex: {
              customerId: customer.id,
              serialNumber,
              ssidIndex: Number(resolvedSsidIndex)
            }
          },
          update: {
            ...(ssidName ? { ssidName } : {}),
            ...(password ? { password } : {}),
            instance: instance || existing?.instance || null,
            ispId: customer.ispId,
            source: 'mobile',
            lastSyncedAt: new Date()
          },
          create: {
            customerId: customer.id,
            ispId: customer.ispId,
            serialNumber,
            ssidIndex: Number(resolvedSsidIndex),
            instance: instance || null,
            ssidName: ssidName || existing?.ssidName || null,
            password: password || existing?.password || null,
            source: 'mobile',
            lastSyncedAt: new Date()
          }
        });
      }

      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error configuring GenieACS WiFi:', error);
      return res.status(500).json({ success: false, error: 'Failed to configure WiFi', message: error.message });
    }
  }




  async enableGenieACSACL(req, res) {
    try {
      const ispId = req.ispId;
      const { serialNumber } = req.params;

      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);
      const result = await client.enableACL(serialNumber);

      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error enabling GenieACS ACL:', error);
      return res.status(500).json({ success: false, error: 'Failed to enable ACL', message: error.message });
    }
  }

  async rebootGenieACSDevice(req, res) {
    try {
      const ispId = req.ispId;
      const { serialNumber } = req.params;

      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);
      const result = await client.rebootDevice(serialNumber);

      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error rebooting GenieACS device:', error);
      return res.status(500).json({ success: false, error: 'Failed to reboot device', message: error.message });
    }
  }

  async factoryResetGenieACSDevice(req, res) {
    try {
      const ispId = req.ispId;
      const { serialNumber } = req.params;

      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);
      const result = await client.factoryReset(serialNumber);

      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error factory resetting GenieACS device:', error);
      return res.status(500).json({ success: false, error: 'Failed to factory reset device', message: error.message });
    }
  }

  async getGenieACSConnectedClients(req, res) {
    try {
      const ispId = req.ispId;
      const { serialNumber } = req.params;

      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);
      const result = await client.getConnectedClients(serialNumber);

      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error getting GenieACS connected clients:', error);
      return res.status(500).json({ success: false, error: 'Failed to get connected clients', message: error.message });
    }
  }

  async triggerGenieACSFirmwareUpgrade(req, res) {
    try {
      const ispId = req.ispId;
      const { serialNumber } = req.params;
      const { imageUrl } = req.body;

      if (!imageUrl) {
        return res.status(400).json({
          success: false,
          error: 'imageUrl is required'
        });
      }

      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);
      const result = await client.triggerFirmwareUpgrade(serialNumber, imageUrl);

      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error triggering GenieACS firmware upgrade:', error);
      return res.status(500).json({ success: false, error: 'Failed to trigger firmware upgrade', message: error.message });
    }
  }

  async getGenieACSDeviceTasks(req, res) {
    try {
      const ispId = req.ispId;
      const { serialNumber } = req.params;
      const { limit = 20 } = req.query;

      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);
      const result = await client.getDeviceTasks(serialNumber, parseInt(limit));

      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error getting GenieACS device tasks:', error);
      return res.status(500).json({ success: false, error: 'Failed to get device tasks', message: error.message });
    }
  }

  async provisionGenieACSPPPoEWiFi(req, res) {
    try {
      const ispId = req.ispId;
      const { serialNumber } = req.params;
      const {
        pppoeUsername,
        pppoePassword,
        vlan,
        nat,
        wifiSSID,
        wifiPassword,
        reboot = false
      } = req.body;

      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);
      const result = await client.provisionPPPoEWiFi(serialNumber, {
        pppoeUsername: pppoeUsername,
        pppoePassword: pppoePassword,
        vlan: vlan,
        nat: nat !== false,
        wifiSSID: wifiSSID,
        wifiPassword: wifiPassword,
        reboot: reboot
      });

      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error provisioning GenieACS device:', error);
      return res.status(500).json({ success: false, error: 'Failed to provision device', message: error.message });
    }
  }

  // ==================== SMS OPERATIONS ====================
  async resolveSmsProvider(ispId, requestedProvider) {
    if (requestedProvider) {
      const code = requestedProvider.toUpperCase();
      if (code === SERVICE_CODES.AAKASHSMS || code === SERVICE_CODES.SPARROWSMS) {
        return code;
      }
    }

    const services = await this.prisma.iSPService.findMany({
      where: {
        ispId: ispId,
        service: {
          code: { in: [SERVICE_CODES.AAKASHSMS, SERVICE_CODES.SPARROWSMS] }
        },
        isActive: true,
        isEnabled: true,
        isDeleted: false
      },
      include: {
        service: true,
        credentials: {
          where: { isActive: true, isDeleted: false }
        }
      }
    });

    if (!services || services.length === 0) {
      throw new Error('No SMS services configured or enabled for this ISP.');
    }

    const configuredServices = services.filter(s => {
      return s.credentials.some(c => c.key === 'auth_token' && c.value);
    });

    if (configuredServices.length === 0) {
      throw new Error('No SMS services have valid credentials.');
    }

    const defaultService = configuredServices.find(s => {
      const cfg = s.config && typeof s.config === 'object' ? s.config : {};
      return cfg.isDefault === true;
    });

    if (defaultService) {
      return defaultService.service.code;
    }

    const aakash = configuredServices.find(s => s.service.code === SERVICE_CODES.AAKASHSMS);
    if (aakash) {
      return SERVICE_CODES.AAKASHSMS;
    }

    return configuredServices[0].service.code;
  }

  async subscribeNetTVPackages(req, res) {
    try {
      const client = await ServiceFactory.getClient(SERVICE_CODES.NETTV, req.ispId);
      const result = await client.subscribePackages(req.params.serial, req.body);
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error subscribing NetTV package:', error);
      return res.status(500).json({ success: false, error: 'Failed to subscribe NetTV package', message: error.message });
    }
  }

  async getNetTVSTB(req, res) {
    try {
      const client = await ServiceFactory.getClient(SERVICE_CODES.NETTV, req.ispId);
      const result = await client.getSTB(req.params.serial);
      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error getting NetTV STB:', error);
      return res.status(500).json({ success: false, error: 'Failed to get NetTV STB', message: error.message });
    }
  }

  async resolveBranchSmsProvider(req, requestedProvider) {
    if (!req.branchId) return requestedProvider;
    let branch = await this.prisma.branch.findFirst({ where: { id: Number(req.branchId), ispId: Number(req.ispId), isDeleted: false }, select: { id: true, parentId: true, smsEnabled: true, smsUseParentProvider: true, smsProviderCode: true } });
    if (!branch) throw new Error('SMS branch policy was not found.');
    if (!branch.smsEnabled) {
      const error = new Error('SMS sending is disabled for this branch.');
      error.status = 403;
      throw error;
    }
    while (branch?.smsUseParentProvider && branch.parentId) {
      branch = await this.prisma.branch.findFirst({ where: { id: Number(branch.parentId), ispId: Number(req.ispId), isDeleted: false }, select: { id: true, parentId: true, smsEnabled: true, smsUseParentProvider: true, smsProviderCode: true } });
    }
    return branch?.smsProviderCode || requestedProvider;
  }

  async sendBulkSms(req, res) {
    try {
      const ispId = Number(req.ispId);
      const { to, text, type = 'customer', provider } = req.body;

      if (!to || !text) {
        return res.status(400).json({ success: false, error: 'to and text are required' });
      }

      const recipientType = type === 'lead' ? 'lead' : 'customer';
      const branchProvider = await this.resolveBranchSmsProvider(req, provider);
      const resolvedProvider = await this.resolveSmsProvider(ispId, branchProvider);
      const client = await ServiceFactory.getClient(resolvedProvider, ispId);

      const recipientPhones = (Array.isArray(to) ? to : [to]).map(p => normalizePhone(p)).filter(Boolean);

      if (recipientPhones.length === 0) {
        return res.status(400).json({ success: false, error: 'No valid phone numbers provided' });
      }

      let result;
      let status = 'completed';
      let errorMessage = null;

      try {
        result = await client.sendBulkSms(recipientPhones, text);
        const providerErrors = [
          typeof result?.error === 'string' ? result.error : null,
          typeof result?.data?.error === 'string' ? result.data.error : null,
          ...(Array.isArray(result?.errors) ? result.errors.map(item => item?.message || item?.error) : []),
          ...(Array.isArray(result?.data?.errors) ? result.data.errors.map(item => item?.message || item?.error) : [])
        ].filter(Boolean);
        const providerMessage = result?.data?.message || result?.message || result?.response || null;
        const providerText = [providerMessage, ...providerErrors].filter(Boolean).join(' ').toLowerCase();
        const providerFailed =
          providerErrors.length > 0 ||
          /\b(error|failed|fail|insufficient|not enough|balance|invalid|rejected|unauthorized)\b/i.test(providerText);

        if (providerFailed) {
          status = 'failed';
          errorMessage = [providerMessage, ...providerErrors.map(String)]
            .filter(Boolean)
            .join(' - ') || 'SMS provider reported failure';
        }
      } catch (err) {
        status = 'failed';
        errorMessage = err.message || 'SMS provider failed';
        throw err;
      } finally {
        await this.prisma.smsCampaign.create({
          data: {
            ispId,
            createdById: req.user?.id || null,
            recipientType,
            provider: resolvedProvider,
            message: String(text),
            status,
            errorMessage,
            totalCount: recipientPhones.length,
            sentCount: status === 'completed' ? recipientPhones.length : 0,
            failedCount: status === 'failed' ? recipientPhones.length : 0,
            startedAt: new Date(),
            completedAt: new Date(),
            logs: {
              create: recipientPhones.map((phone) => ({
                recipientType,
                phone,
                provider: resolvedProvider,
                status: status === 'completed' ? 'sent' : 'failed',
                errorMessage,
                sentAt: new Date()
              }))
            }
          }
        });
      }

      if (serviceCode === SERVICE_CODES.ESEWA) {
        const suppliedConfig = config && typeof config === 'object' ? config : {};
        const isProduction = String(suppliedConfig.environment || '').toLowerCase() === 'production';
        baseUrl = baseUrl || (isProduction ? 'https://epay.esewa.com.np' : 'https://rc-epay.esewa.com.np');
        const demoConfig = isProduction ? {} : {
          productCode: 'EPAYTEST',
          epaySecretKey: '8gBm/:&EnhH.1/q'
        };
        config = {
          integrationMode: 'TOKEN_BASED',
          environment: isProduction ? 'production' : 'uat',
          tokenEnabled: true,
          epayEnabled: true,
          timeout: 30000,
          ...demoConfig,
          ...suppliedConfig
        };
      }

      if (status === 'failed') {
        return res.status(400).json({
          success: false,
          error: errorMessage || 'Failed to send SMS',
          data: result
        });
      }

      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error sending bulk SMS:', error);
      return res.status(500).json({ success: false, error: 'Failed to send SMS', message: error.message });
    }
  }

  buildSmsLeadWhere(ispId, filters = {}) {
    const where = {
      isDeleted: false,
      ispId: Number(ispId),
      phoneNumber: { not: null }
    };

    if (filters.status && filters.status !== 'all') where.status = filters.status;
    if (Array.isArray(filters.branchIds) && filters.branchIds.length > 0) {
      const ids = filters.branchIds.map(Number).filter(Boolean);
      if (ids.length > 0) {
        where.OR = [
          { branchId: { in: ids } },
          { subBranchId: { in: ids } }
        ];
      }
    }
    if (filters.area) {
      const areas = String(filters.area).split(',').map(s => s.trim()).filter(Boolean);
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

    if (Array.isArray(filters.dynamicFilters) && filters.dynamicFilters.length > 0) {
      const filtersByType = {};
      filters.dynamicFilters.forEach(f => {
        const parts = f.split(":");
        const type = parts[0];
        const val = parts.slice(1).join(":");
        if (type && val) {
          if (!filtersByType[type]) filtersByType[type] = [];
          filtersByType[type].push(val.trim());
        }
      });

      Object.entries(filtersByType).forEach(([type, values]) => {
        if (type === 'address') {
          where.address = { in: values };
        } else if (type === 'street') {
          where.street = { in: values };
        } else if (type === 'district') {
          where.district = { in: values };
        } else if (type === 'gender') {
          where.gender = { in: values };
        } else if (type === 'package') {
          where.interestedPackage = { packageName: { in: values } };
        } else if (type === 'membership') {
          where.membership = { name: { in: values } };
        } else if (type === 'fullAddress') {
          where.AND = where.AND || [];
          where.AND.push({
            OR: values.flatMap(val => [
              { address: { contains: val } },
              { street: { contains: val } },
              { district: { contains: val } },
              { province: { contains: val } }
            ])
          });
        }
      });
    }

    return where;
  }

  buildSmsCustomerWhere(ispId, filters = {}) {
    const where = {
      isDeleted: false,
      ispId: Number(ispId),
      lead: { phoneNumber: { not: null } }
    };

    if (filters.status && filters.status !== 'all') where.status = filters.status;
    if (filters.oltId && filters.oltId !== 'all') {
      where.serviceDetails = {
        some: {
          oltId: Number(filters.oltId),
          ...(filters.oltPort && filters.oltPort !== 'all' ? { oltPort: String(filters.oltPort) } : {}),
          ...(filters.splitterId && filters.splitterId !== 'all' ? { splitterId: Number(filters.splitterId) } : {})
        }
      };
    } else if (filters.splitterId && filters.splitterId !== 'all') {
      where.serviceDetails = { some: { splitterId: Number(filters.splitterId) } };
    }
    if (Array.isArray(filters.branchIds) && filters.branchIds.length > 0) {
      const ids = filters.branchIds.map(Number).filter(Boolean);
      if (ids.length > 0) {
        where.OR = [
          { branchId: { in: ids } },
          { subBranchId: { in: ids } }
        ];
      }
    }
    if (filters.area) {
      const areas = String(filters.area).split(',').map(s => s.trim()).filter(Boolean);
      if (areas.length > 0) {
        where.lead = where.lead || {};
        where.lead.AND = where.lead.AND || [];
        where.lead.AND.push({
          OR: areas.flatMap(a => [
            { address: { contains: a } },
            { street: { contains: a } },
            { district: { contains: a } },
            { province: { contains: a } }
          ])
        });
      }
    }

    if (Array.isArray(filters.dynamicFilters) && filters.dynamicFilters.length > 0) {
      const filtersByType = {};
      filters.dynamicFilters.forEach(f => {
        const parts = f.split(":");
        const type = parts[0];
        const val = parts.slice(1).join(":");
        if (type && val) {
          if (!filtersByType[type]) filtersByType[type] = [];
          filtersByType[type].push(val.trim());
        }
      });

      Object.entries(filtersByType).forEach(([type, values]) => {
        if (type === 'address') {
          where.lead = { ...where.lead, address: { in: values } };
        } else if (type === 'street') {
          where.lead = { ...where.lead, street: { in: values } };
        } else if (type === 'district') {
          where.lead = { ...where.lead, district: { in: values } };
        } else if (type === 'gender') {
          where.lead = { ...where.lead, gender: { in: values } };
        } else if (type === 'package') {
          where.subscribedPkg = { packageName: { in: values } };
        } else if (type === 'membership') {
          where.membership = { name: { in: values } };
        } else if (type === 'fullAddress') {
          where.lead = where.lead || {};
          where.lead.AND = where.lead.AND || [];
          where.lead.AND.push({
            OR: values.flatMap(val => [
              { address: { contains: val } },
              { street: { contains: val } },
              { district: { contains: val } },
              { province: { contains: val } }
            ])
          });
        }
      });
    }

    return where;
  }

  async getSmsCampaignRecipients(ispId, recipientType, filters = {}) {
    if (recipientType === 'lead') {
      const leads = await this.prisma.lead.findMany({
        where: this.buildSmsLeadWhere(ispId, filters),
        select: { id: true, firstName: true, middleName: true, lastName: true, phoneNumber: true, secondaryContactNumber: true },
        orderBy: { createdAt: 'desc' }
      });

      return leads.map((lead) => {
        const primary = normalizePhone(lead.phoneNumber);
        const secondary = normalizePhone(lead.secondaryContactNumber);
        const finalPhone = primary || secondary;
        return {
          recipientId: lead.id,
          recipientType: 'lead',
          name: [lead.firstName, lead.middleName, lead.lastName].filter(Boolean).join(' ').trim() || null,
          phone: finalPhone
        };
      }).filter((recipient) => recipient.phone);
    }

    const customers = await this.prisma.customer.findMany({
      where: this.buildSmsCustomerWhere(ispId, filters),
      select: {
        id: true,
        lead: { select: { firstName: true, middleName: true, lastName: true, phoneNumber: true, secondaryContactNumber: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    return customers.map((customer) => {
      const primary = normalizePhone(customer.lead?.phoneNumber);
      const secondary = normalizePhone(customer.lead?.secondaryContactNumber);
      const finalPhone = primary || secondary;
      return {
        recipientId: customer.id,
        recipientType: 'customer',
        name: customer.lead ? [customer.lead.firstName, customer.lead.middleName, customer.lead.lastName].filter(Boolean).join(' ').trim() : null,
        phone: finalPhone
      };
    }).filter((recipient) => recipient.phone);
  }

  dedupeSmsRecipients(recipients) {
    const seen = new Set();
    const unique = [];
    const skipped = [];

    recipients.forEach((recipient) => {
      const phone = normalizePhone(recipient.phone);
      if (!phone) return;
      if (seen.has(phone)) {
        skipped.push({ ...recipient, phone });
        return;
      }
      seen.add(phone);
      unique.push({ ...recipient, phone });
    });

    return { unique, skipped };
  }

  async enqueueSmsCampaign(req, res) {
    try {
      const ispId = Number(req.ispId);
      const {
        to,
        text,
        type = 'customer',
        provider,
        filters = {},
        selectAll = false,
        batchSize
      } = req.body;

      if (!text || !String(text).trim()) {
        return res.status(400).json({ success: false, error: 'Message text is required' });
      }

      const recipientType = type === 'lead' ? 'lead' : 'customer';
      const branchProvider = await this.resolveBranchSmsProvider(req, provider);
      const resolvedProvider = await this.resolveSmsProvider(ispId, branchProvider);
      let recipients = selectAll
        ? await this.getSmsCampaignRecipients(ispId, recipientType, filters)
        : (Array.isArray(to) ? to : [to]).map((item) => {
          const rawPhone = typeof item === 'object' && item !== null ? item.phone : item;
          const recipientId = typeof item === 'object' && item !== null ? item.recipientId : null;
          const name = typeof item === 'object' && item !== null ? item.name : null;
          return {
            recipientId: recipientId ? Number(recipientId) : null,
            recipientType,
            name: name || null,
            phone: normalizePhone(rawPhone)
          };
        }).filter((recipient) => recipient.phone);

      // Merge manual numbers from `to` when selectAll is true
      if (selectAll && Array.isArray(to) && to.length > 0) {
        const manualRecipients = to.map((item) => {
          const rawPhone = typeof item === 'object' && item !== null ? item.phone : item;
          const name = typeof item === 'object' && item !== null ? item.name : null;
          return {
            recipientId: null,
            recipientType,
            name: name || 'Manual',
            phone: normalizePhone(rawPhone)
          };
        }).filter((r) => r.phone);
        recipients = [...recipients, ...manualRecipients];
      }

      const { unique, skipped } = this.dedupeSmsRecipients(recipients);

      if (unique.length === 0) {
        return res.status(400).json({ success: false, error: 'No valid recipient phone numbers found' });
      }

      const safeBatchSize = Math.max(1, Math.min(Number(batchSize) || SMS_CAMPAIGN_BATCH_SIZE, 500));

      const campaign = await this.prisma.smsCampaign.create({
        data: {
          ispId,
          createdById: req.user?.id || null,
          recipientType,
          provider: resolvedProvider,
          message: String(text),
          filters,
          status: 'queued',
          totalCount: unique.length + skipped.length,
          queuedCount: unique.length,
          skippedCount: skipped.length,
          batchSize: safeBatchSize,
          logs: {
            create: [
              ...unique.map((recipient) => ({
                recipientId: recipient.recipientId ? Number(recipient.recipientId) : null,
                recipientType,
                name: recipient.name || null,
                phone: recipient.phone,
                provider: resolvedProvider,
                status: 'queued'
              })),
              ...skipped.map((recipient) => ({
                recipientId: recipient.recipientId ? Number(recipient.recipientId) : null,
                recipientType,
                name: recipient.name || null,
                phone: recipient.phone,
                provider: resolvedProvider,
                status: 'skipped',
                errorMessage: 'Duplicate phone number in campaign target'
              }))
            ]
          }
        }
      });

      this.scheduleSmsCampaignProcessing();

      return res.status(202).json({
        success: true,
        data: {
          campaignId: campaign.id,
          status: campaign.status,
          totalCount: campaign.totalCount,
          queuedCount: campaign.queuedCount,
          skippedCount: campaign.skippedCount,
          batchSize: campaign.batchSize
        }
      });
    } catch (error) {
      console.error('Error enqueueing SMS campaign:', error);
      return res.status(500).json({ success: false, error: 'Failed to queue SMS campaign', message: error.message });
    }
  }

  scheduleSmsCampaignProcessing(delay = 0) {
    if (smsCampaignQueue.nextTimer) return;
    smsCampaignQueue.nextTimer = setTimeout(() => {
      smsCampaignQueue.nextTimer = null;
      this.processSmsCampaignQueue().catch((error) => {
        console.error('SMS campaign queue error:', error);
      });
    }, delay);
  }

  async processSmsCampaignQueue() {
    if (smsCampaignQueue.processing) return;
    smsCampaignQueue.processing = true;

    try {
      const campaign = await this.prisma.smsCampaign.findFirst({
        where: { status: { in: ['queued', 'processing'] } },
        orderBy: { createdAt: 'asc' }
      });

      if (!campaign) return;

      if (campaign.status === 'queued') {
        await this.prisma.smsCampaign.update({
          where: { id: campaign.id },
          data: { status: 'processing', startedAt: new Date() }
        });
      }

      const pendingLogs = await this.prisma.smsCampaignLog.findMany({
        where: { campaignId: campaign.id, status: 'queued' },
        orderBy: { id: 'asc' },
        take: campaign.batchSize || SMS_CAMPAIGN_BATCH_SIZE
      });

      if (pendingLogs.length === 0) {
        const [sentCount, failedCount, skippedCount] = await Promise.all([
          this.prisma.smsCampaignLog.count({ where: { campaignId: campaign.id, status: 'sent' } }),
          this.prisma.smsCampaignLog.count({ where: { campaignId: campaign.id, status: 'failed' } }),
          this.prisma.smsCampaignLog.count({ where: { campaignId: campaign.id, status: 'skipped' } })
        ]);

        await this.prisma.smsCampaign.update({
          where: { id: campaign.id },
          data: {
            status: failedCount > 0 && sentCount === 0 ? 'failed' : 'completed',
            sentCount,
            failedCount,
            skippedCount,
            queuedCount: 0,
            completedAt: new Date()
          }
        });
        return;
      }

      const client = await ServiceFactory.getClient(campaign.provider, campaign.ispId);
      const phones = pendingLogs.map((log) => log.phone);

      try {
        const result = await client.sendBulkSms(phones, campaign.message);
        await this.prisma.smsCampaignLog.updateMany({
          where: { id: { in: pendingLogs.map((log) => log.id) } },
          data: {
            status: 'sent',
            response: result,
            sentAt: new Date()
          }
        });
      } catch (error) {
        const errorMessage = error.response?.data?.message || error.response?.data?.error || error.message || 'SMS provider failed';
        await this.prisma.smsCampaignLog.updateMany({
          where: { id: { in: pendingLogs.map((log) => log.id) } },
          data: {
            status: 'failed',
            errorMessage,
            response: error.response?.data || null
          }
        });
      }

      const [queuedCount, sentCount, failedCount, skippedCount] = await Promise.all([
        this.prisma.smsCampaignLog.count({ where: { campaignId: campaign.id, status: 'queued' } }),
        this.prisma.smsCampaignLog.count({ where: { campaignId: campaign.id, status: 'sent' } }),
        this.prisma.smsCampaignLog.count({ where: { campaignId: campaign.id, status: 'failed' } }),
        this.prisma.smsCampaignLog.count({ where: { campaignId: campaign.id, status: 'skipped' } })
      ]);

      await this.prisma.smsCampaign.update({
        where: { id: campaign.id },
        data: {
          status: queuedCount > 0 ? 'processing' : (failedCount > 0 && sentCount === 0 ? 'failed' : 'completed'),
          queuedCount,
          sentCount,
          failedCount,
          skippedCount,
          completedAt: queuedCount > 0 ? null : new Date()
        }
      });

      this.scheduleSmsCampaignProcessing(queuedCount > 0 ? SMS_CAMPAIGN_BATCH_DELAY_MS : 0);
    } finally {
      smsCampaignQueue.processing = false;
    }
  }

  async getSmsCampaigns(req, res) {
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(Math.max(1, Number(req.query.limit) || 20), 100);
      const { provider } = req.query;
      const where = {
        ispId: Number(req.ispId),
        ...(provider ? { provider: String(provider).toUpperCase() } : {})
      };

      const [rows, total] = await Promise.all([
        this.prisma.smsCampaign.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit
        }),
        this.prisma.smsCampaign.count({ where })
      ]);

      return res.json({ success: true, data: rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to load SMS campaigns', message: error.message });
    }
  }

  async getSmsCampaignLogs(req, res) {
    try {
      const campaignId = Number(req.params.id);
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(Math.max(1, Number(req.query.limit) || 100), 500);
      const status = req.query.status;

      const campaign = await this.prisma.smsCampaign.findFirst({
        where: { id: campaignId, ispId: Number(req.ispId) }
      });
      if (!campaign) {
        return res.status(404).json({ success: false, error: 'SMS campaign not found' });
      }

      const where = {
        campaignId,
        ...(status && status !== 'all' ? { status: String(status) } : {})
      };

      const [rows, total, sentCount, failedCount, skippedCount, queuedCount, errorCount] = await Promise.all([
        this.prisma.smsCampaignLog.findMany({
          where,
          orderBy: { id: 'asc' },
          skip: (page - 1) * limit,
          take: limit
        }),
        this.prisma.smsCampaignLog.count({ where }),
        this.prisma.smsCampaignLog.count({ where: { campaignId, status: 'sent' } }),
        this.prisma.smsCampaignLog.count({ where: { campaignId, status: 'failed' } }),
        this.prisma.smsCampaignLog.count({ where: { campaignId, status: 'skipped' } }),
        this.prisma.smsCampaignLog.count({ where: { campaignId, status: 'queued' } }),
        this.prisma.smsCampaignLog.count({ where: { campaignId, status: 'error' } })
      ]);

      const statusCounts = { sent: sentCount, failed: failedCount, skipped: skippedCount, queued: queuedCount, error: errorCount, total: sentCount + failedCount + skippedCount + queuedCount + errorCount };

      return res.json({ success: true, data: rows, campaign, statusCounts, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to load SMS campaign logs', message: error.message });
    }
  }

  async exportSmsCampaignLogs(req, res) {
    try {
      const campaignId = Number(req.params.id);
      const status = req.query.status;

      const campaign = await this.prisma.smsCampaign.findFirst({
        where: { id: campaignId, ispId: Number(req.ispId) }
      });
      if (!campaign) {
        return res.status(404).json({ success: false, error: 'SMS campaign not found' });
      }

      const where = {
        campaignId,
        ...(status && status !== 'all' ? { status: String(status) } : {})
      };

      const rows = await this.prisma.smsCampaignLog.findMany({
        where,
        orderBy: { id: 'asc' }
      });

      const csvHeader = 'Phone,Name,Status,Error,Sent At';
      const csvRows = rows.map(row => {
        const phone = row.phone || '';
        const name = (row.name || '').replace(/"/g, '""');
        const logStatus = row.status || '';
        const error = (row.errorMessage || '').replace(/"/g, '""');
        const sentAt = row.sentAt ? new Date(row.sentAt).toLocaleString() : '';
        return `${phone},"${name}",${logStatus},"${error}","${sentAt}"`;
      });

      const csv = [csvHeader, ...csvRows].join('\n');
      const statusLabel = status && status !== 'all' ? `_${status}` : '';
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="campaign_${campaignId}${statusLabel}_logs.csv"`);
      return res.send(csv);
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to export SMS campaign logs', message: error.message });
    }
  }

  async getSmsCredit(req, res) {
    try {
      const ispId = req.ispId;
      const { provider } = req.query;

      const resolvedProvider = await this.resolveSmsProvider(ispId, provider);
      const client = await ServiceFactory.getClient(resolvedProvider, ispId);
      const result = await client.getCredit();

      return res.json({ success: true, data: result });
    } catch (error) {
      console.error('Error getting SMS credit:', error);
      return res.status(500).json({ success: false, error: 'Failed to get SMS credit', message: error.message });
    }
  }

  // ==================== GENIEACS ADMIN CONTROLLER METHODS ====================
  async getGenieACSProvisions(req, res) {
    try {
      const ispId = req.ispId;
      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);
      const provisions = await client.getProvisions();
      return res.json({ success: true, data: provisions });
    } catch (error) {
      console.error("Error fetching provisions:", error);
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  async createOrUpdateGenieACSProvision(req, res) {
    try {
      const ispId = req.ispId;
      const { name, script } = req.body;
      if (!name || !script) {
        return res.status(400).json({ success: false, message: "name and script are required" });
      }
      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);
      await client.uploadProvision(name, script);
      return res.json({ success: true, message: `Provision '${name}' saved successfully.` });
    } catch (error) {
      console.error("Error saving provision:", error);
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  async deleteGenieACSProvision(req, res) {
    try {
      const ispId = req.ispId;
      const { name } = req.params;
      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);
      await client.deleteProvision(name);
      return res.json({ success: true, message: `Provision '${name}' deleted successfully.` });
    } catch (error) {
      console.error("Error deleting provision:", error);
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  async getGenieACSVirtualParameters(req, res) {
    try {
      const ispId = req.ispId;
      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);
      const virtualParams = await client.getVirtualParameters();
      return res.json({ success: true, data: virtualParams });
    } catch (error) {
      console.error("Error fetching virtual parameters:", error);
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  async createOrUpdateGenieACSVirtualParameter(req, res) {
    try {
      const ispId = req.ispId;
      const { name, script } = req.body;
      if (!name || !script) {
        return res.status(400).json({ success: false, message: "name and script are required" });
      }
      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);
      await client.uploadVirtualParameter(name, script);
      return res.json({ success: true, message: `Virtual Parameter '${name}' saved successfully.` });
    } catch (error) {
      console.error("Error saving virtual parameter:", error);
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  async deleteGenieACSVirtualParameter(req, res) {
    try {
      const ispId = req.ispId;
      const { name } = req.params;
      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);
      await client.deleteVirtualParameter(name);
      return res.json({ success: true, message: `Virtual Parameter '${name}' deleted successfully.` });
    } catch (error) {
      console.error("Error deleting virtual parameter:", error);
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  async getGenieACSPresets(req, res) {
    try {
      const ispId = req.ispId;
      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);
      const presets = await client.getPresets();
      return res.json({ success: true, data: presets });
    } catch (error) {
      console.error("Error fetching presets:", error);
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  async createOrUpdateGenieACSPreset(req, res) {
    try {
      const ispId = req.ispId;
      const { name, presetData } = req.body;
      if (!name || !presetData) {
        return res.status(400).json({ success: false, message: "name and presetData are required" });
      }
      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);
      let parsedPreset = presetData;
      if (typeof presetData === "string") {
        try {
          parsedPreset = JSON.parse(presetData);
        } catch (e) {
          return res.status(400).json({ success: false, message: "Invalid JSON format for presetData: " + e.message });
        }
      }
      await client.uploadPreset(name, parsedPreset);
      return res.json({ success: true, message: `Preset '${name}' saved successfully.` });
    } catch (error) {
      console.error("Error saving preset:", error);
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  async deleteGenieACSPreset(req, res) {
    try {
      const ispId = req.ispId;
      const { name } = req.params;
      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);
      await client.deletePreset(name);
      return res.json({ success: true, message: `Preset '${name}' deleted successfully.` });
    } catch (error) {
      console.error("Error deleting preset:", error);
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  async getGenieACSFiles(req, res) {
    try {
      const ispId = req.ispId;
      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);
      const files = await client.getFiles();
      return res.json({ success: true, data: files });
    } catch (error) {
      console.error("Error fetching files:", error);
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  async uploadGenieACSFile(req, res) {
    try {
      const ispId = req.ispId;
      const { name, fileContent, contentType, fileType } = req.body;
      if (!name || !fileContent) {
        return res.status(400).json({ success: false, message: "name and fileContent are required" });
      }
      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);
      const fileData = Buffer.from(fileContent, "base64");
      await client.uploadFile(name, fileData, { contentType, metadata: { fileType } });
      return res.json({ success: true, message: `File '${name}' uploaded successfully.` });
    } catch (error) {
      console.error("Error uploading file:", error);
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  async deleteGenieACSFile(req, res) {
    try {
      const ispId = req.ispId;
      const { name } = req.params;
      const client = await ServiceFactory.getClient(SERVICE_CODES.GENIEACS, ispId);
      await client.deleteFile(name);
      return res.json({ success: true, message: `File '${name}' deleted successfully.` });
    } catch (error) {
      console.error("Error deleting file:", error);
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  async getGenieACSConfig(req, res) {
    try {
      const ispId = req.ispId;
      const ispService = await this.prisma.iSPService.findFirst({
        where: { ispId, service: { code: SERVICE_CODES.GENIEACS }, isDeleted: false, isActive: true },
        include: { credentials: { where: { isActive: true, isDeleted: false } } }
      });
      if (!ispService) {
        return res.status(404).json({ success: false, message: "GenieACS service not configured for this ISP." });
      }
      return res.json({ success: true, data: { baseUrl: ispService.baseUrl, credentials: ispService.credentials } });
    } catch (error) {
      console.error("Error fetching config:", error);
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  async updateGenieACSConfig(req, res) {
    try {
      const ispId = req.ispId;
      const { baseUrl, username, password } = req.body;
      const ispService = await this.prisma.iSPService.findFirst({
        where: { ispId, service: { code: SERVICE_CODES.GENIEACS }, isDeleted: false, isActive: true }
      });
      if (!ispService) {
        return res.status(404).json({ success: false, message: "GenieACS service not configured for this ISP." });
      }
      await this.prisma.iSPService.update({
        where: { id: ispService.id },
        data: { baseUrl }
      });
      if (username) {
        await this.prisma.serviceCredential.upsert({
          where: { ispServiceId_key: { ispServiceId: ispService.id, key: "username" } },
          update: { value: username },
          create: { ispServiceId: ispService.id, key: "username", value: username, credentialType: "TEXT", label: "Username" }
        });
      }
      if (password) {
        await this.prisma.serviceCredential.upsert({
          where: { ispServiceId_key: { ispServiceId: ispService.id, key: "password" } },
          update: { value: password },
          create: { ispServiceId: ispService.id, key: "password", value: password, credentialType: "PASSWORD", label: "Password" }
        });
      }
      return res.json({ success: true, message: "GenieACS connection parameters updated successfully." });
    } catch (error) {
      console.error("Error updating config:", error);
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  async getGenieACSPermissions(req, res) {
    try {
      // Return local permissions relevant to TR-069
      const permissions = await this.prisma.permission.findMany({
        where: { OR: [ { name: { contains: "device" } }, { name: { contains: "service" } } ] }
      });
      return res.json({ success: true, data: permissions });
    } catch (error) {
      console.error("Error fetching permissions:", error);
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  async createGenieACSPermission(req, res) {
    try {
      const { name, description } = req.body;
      if (!name) return res.status(400).json({ success: false, message: "name is required" });
      const perm = await this.prisma.permission.create({ data: { name, description } });
      return res.json({ success: true, data: perm });
    } catch (error) {
      console.error("Error creating permission:", error);
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  async deleteGenieACSPermission(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      await this.prisma.permission.delete({ where: { id } });
      return res.json({ success: true, message: "Permission deleted successfully." });
    } catch (error) {
      console.error("Error deleting permission:", error);
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  async getGenieACSUsers(req, res) {
    try {
      const users = await this.prisma.user.findMany({
        where: { isDeleted: false },
        select: { id: true, email: true, role: { select: { name: true } }, createdAt: true }
      });
      return res.json({ success: true, data: users });
    } catch (error) {
      console.error("Error fetching users:", error);
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  async createGenieACSUser(req, res) {
    try {
      const { email, password, roleId } = req.body;
      if (!email || !password || !roleId) {
        return res.status(400).json({ success: false, message: "email, password, and roleId are required" });
      }
      const bcrypt = require("bcrypt");
      const hashedPassword = await bcrypt.hash(password, 10);
      const user = await this.prisma.user.create({
        data: {
          email,
          password: hashedPassword,
          roleId,
          ispId: req.ispId,
          branchId: req.user.branchId
        }
      });
      return res.json({ success: true, data: { id: user.id, email: user.email } });
    } catch (error) {
      console.error("Error creating user:", error);
      return res.status(500).json({ success: false, message: error.message });
    }
  }

  async deleteGenieACSUser(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      await this.prisma.user.update({ where: { id }, data: { isDeleted: true } });
      return res.json({ success: true, message: "User deleted successfully." });
    } catch (error) {
      console.error("Error deleting user:", error);
      return res.status(500).json({ success: false, message: error.message });
    }
  }

}

module.exports = { ServiceController };
