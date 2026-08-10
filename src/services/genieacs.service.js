const axios = require('axios');
const { SERVICE_CODES } = require('../lib/serviceConstants');
const { flattenParameters } = require('./tr069-wan-adapter.service');

const DIAGNOSTIC_DEFINITIONS = {
    'TR-181': {
        ping: { root: 'Device.IP.Diagnostics.IPPing', host: 'Host', count: 'NumberOfRepetitions', timeout: 'Timeout', interface: 'Interface' },
        traceroute: { root: 'Device.IP.Diagnostics.TraceRoute', host: 'Host', count: 'NumberOfTries', timeout: 'Timeout', interface: 'Interface' },
        dns: {
            root: 'Device.DNS.Diagnostics.NSLookupDiagnostics',
            host: 'HostName',
            count: 'NumberOfRepetitions',
            timeout: 'Timeout'
        }
    },
    'TR-098': {
        ping: { root: 'InternetGatewayDevice.IPPingDiagnostics', host: 'Host', count: 'NumberOfRepetitions', timeout: 'Timeout', interface: 'Interface' },
        traceroute: { root: 'InternetGatewayDevice.TraceRouteDiagnostics', host: 'Host', count: 'NumberOfTries', timeout: 'Timeout', interface: 'Interface' },
        dns: {
            root: 'InternetGatewayDevice.NSLookupDiagnostics',
            host: 'HostName',
            count: 'NumberOfRepetitions',
            timeout: 'Timeout'
        }
    }
};

class GenieACSClient {
    constructor(config) {
        if (!config.baseUrl) {
            throw new Error('GenieACS baseUrl is required');
        }

        this.config = config;
        this.baseURL = config.baseUrl;
        this.username = config.username;
        this.password = config.password;
        this.diagnosticRefreshAt = new Map();

        // Create axios instance
        const axiosConfig = {
            baseURL: this.baseURL,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            timeout: 60000
        };

        // Only add auth if username and password are provided
        if (this.username && this.password) {
            axiosConfig.auth = {
                username: this.username,
                password: this.password
            };
        }

        this.client = axios.create(axiosConfig);
    }

    /**
     * Create a GenieACS client instance for an ISP
     */
    static async create(reqOrIspId, prisma) {
        const ispId = typeof reqOrIspId === 'object' ? reqOrIspId.ispId : reqOrIspId;
        try {
            const ispService = await prisma.iSPService.findFirst({
                where: {
                    ispId: ispId,
                    service: { code: SERVICE_CODES.GENIEACS },
                    isDeleted: false,
                    isActive: true
                },
                include: {
                    service: true
                }
            });

            if (!ispService) {
                throw new Error('GenieACS service not configured for this ISP');
            }

            // Extract credentials
            const credentials = {};
            const serviceCredentials = await prisma.serviceCredential.findMany({
                where: { ispServiceId: ispService.id, isActive: true, isDeleted: false }
            });
            serviceCredentials.forEach(cred => {
                credentials[cred.key] = cred.value;
            });

            // Get base URL
            const baseUrl = ispService.baseUrl || credentials.base_url;

            if (!baseUrl) {
                throw new Error('GenieACS base URL is required');
            }

            const config = {
                baseUrl: baseUrl,
                username: credentials.username,
                password: credentials.password
            };

            return new GenieACSClient(config);
        } catch (error) {
            console.error('Error creating GenieACS client:', error);
            throw new Error(`Failed to create GenieACS client: ${error.message}`);
        }
    }

    /**
     * SIMPLE TEST CONNECTION - Only basic info
     */
    async testConnection() {
        try {
            console.log(`🔍 Testing connection to: ${this.baseURL}`);

            // Get ONLY basic device info with projection
            const response = await this.client.get('/devices', {
                params: {
                    limit: 1, // Only 1 device
                    projection: '_id,_deviceId._SerialNumber,_deviceId._ProductClass,Online,_lastInform' // Basic fields only
                },
                timeout: 5000
            });

            if (!response.data || !Array.isArray(response.data)) {
                throw new Error('Invalid response from GenieACS');
            }

            // Format device info
            const device = response.data[0] || null;
            const deviceInfo = device ? {
                id: device._id,
                serial: device._deviceId?._SerialNumber,
                productClass: device._deviceId?._ProductClass,
                online: device.Online,
                lastInform: device._lastInform
            } : null;

            return {
                connected: true,
                message: 'Successfully connected to GenieACS server',
                data: {
                    serverInfo: 'GenieACS API is responding',
                    deviceCount: response.data.length,
                    sampleDevice: deviceInfo,
                    timestamp: new Date().toISOString()
                }
            };
        } catch (error) {
            console.error('❌ GenieACS test connection error:', error.message);

            if (error.code === 'ECONNREFUSED') {
                return {
                    connected: false,
                    message: `Cannot connect to GenieACS server at ${this.baseURL}`,
                    timestamp: new Date().toISOString()
                };
            } else if (error.code === 'ETIMEDOUT') {
                return {
                    connected: false,
                    message: 'Connection timeout',
                    timestamp: new Date().toISOString()
                };
            } else if (error.response?.status === 401) {
                return {
                    connected: false,
                    message: 'Authentication failed',
                    timestamp: new Date().toISOString()
                };
            }

            return {
                connected: false,
                message: error.message || 'Failed to connect',
                timestamp: new Date().toISOString()
            };
        }
    }

    /**
     * Get service status
     */
    static async getServiceStatus(ispId, prisma) {
        try {
            const ispService = await prisma.iSPService.findFirst({
                where: {
                    ispId: ispId,
                    service: { code: SERVICE_CODES.GENIEACS },
                    isDeleted: false
                }
            });

            if (!ispService) {
                return {
                    enabled: false,
                    configured: false,
                    message: 'GenieACS service not configured'
                };
            }

            // Check credentials
            const baseUrl = ispService.baseUrl;
            const credentials = await prisma.serviceCredential.findMany({
                where: { ispServiceId: ispService.id, isActive: true, isDeleted: false }
            });
            const usernameCred = credentials.find(c => c.key === 'username');
            const passwordCred = credentials.find(c => c.key === 'password');

            const hasBaseUrl = !!baseUrl;
            const hasUsername = !!usernameCred?.value;
            const hasPassword = !!passwordCred?.value;

            // Build config
            const config = {
                baseUrl: baseUrl,
                username: usernameCred?.value,
                password: passwordCred?.value
            };

            if (!config.baseUrl) {
                return {
                    enabled: ispService.isActive,
                    configured: false,
                    message: 'Base URL is required',
                    lastChecked: new Date().toISOString()
                };
            }

            const client = new GenieACSClient(config);
            const connectionTest = await client.testConnection();

            return {
                enabled: ispService.isActive,
                configured: hasBaseUrl,
                connected: connectionTest.connected,
                message: connectionTest.message,
                credentialsConfigured: hasUsername && hasPassword,
                lastChecked: new Date().toISOString()
            };
        } catch (error) {
            return {
                enabled: false,
                configured: false,
                error: error.message,
                lastChecked: new Date().toISOString()
            };
        }
    }

    /**
     * Get all devices - ONLY BASIC INFO
     */
    async getDevices({ query = {}, projection = "" } = {}) {
        try {
            const params = {};

            // GenieACS expects query as JSON string
            if (query && Object.keys(query).length > 0) {
                params.query = JSON.stringify(query);
            }

            if (projection) {
                params.projection = projection;
            }

            const response = await this.client.get("/devices", { params });

            if (!Array.isArray(response.data)) {
                throw new Error("Invalid response from GenieACS");
            }

            return response.data; // IMPORTANT: return ARRAY only

        } catch (error) {
            console.error("❌ GenieACS error:", error.response?.data || error.message);
            throw new Error(error.message || "Failed to fetch devices");
        }
    }


    /**
     * Get device by serial number - BASIC INFO ONLY
     */
    async getDeviceBySerial(serialNumber, options = {}) {
        try {
            const { projection, full = false, requestTimeoutMs } = options;

            // Default projection if none provided
            const defaultProjection = `
            _id,
            _deviceId,
            _lastInform,
            InternetGatewayDevice.DeviceInfo,
            InternetGatewayDevice.WANDevice,
            InternetGatewayDevice.LANDevice,
            InternetGatewayDevice.Services,
            InternetGatewayDevice.ManagementServer,
            InternetGatewayDevice.Time,
            InternetGatewayDevice.UserInterface,
            Device.DeviceInfo,
            Device.WiFi,
            Device.Ethernet,
            Device.Services,
            VirtualParameters
        `;

            const query = {
                "_deviceId._SerialNumber": serialNumber
            };

            const params = {
                query: JSON.stringify(query),
                limit: 1
            };
            if (!full) {
                params.projection = String(projection || defaultProjection).replace(/\s+/g, '');
            }

            const requestConfig = { params };
            if (Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0) {
                requestConfig.timeout = requestTimeoutMs;
            }
            const response = await this.client.get('/devices', requestConfig);

            if (!response.data || response.data.length === 0) {
                throw new Error(`Device with serial ${serialNumber} not found`);
            }

            const device = response.data[0];

            // If this is a simple request (no projection parameter or specific flag), return essential info
            if (!projection && !full) {
                return {
                    id: device._id,
                    serial: device._deviceId?._SerialNumber,
                    productClass: device._deviceId?._ProductClass,
                    oui: device._deviceId?._OUI,
                    online: device.Online,
                    lastInform: device._lastInform,
                    manufacturer: device._deviceId?._Manufacturer,
                    modelName: device._deviceId?._ModelName
                };
            }

            // Otherwise return full device data
            return device;

        } catch (error) {
            throw new Error(`Failed to get device: ${error.message}`);
        }
    }

    /**
     * Get device status - Only essential parameters
     */
    async getDeviceStatus(serialNumber) {
        try {
            const device = await this.getDeviceBySerial(serialNumber);

            const deviceId = device.id;

            // Get only critical parameters
            const paramsResponse = await this.client.get(`/devices/${deviceId}/parameters`, {
                params: {
                    parameterNames: [
                        'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
                        'InternetGatewayDevice.DeviceInfo.HardwareVersion',
                        'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress',
                        'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.MACAddress',
                        'VirtualParameters.SignalStrength',
                        'VirtualParameters.Temperature'
                    ]
                }
            });

            const parameters = paramsResponse.data || {};

            return {
                serial: serialNumber,
                deviceId: deviceId,
                online: device.online,
                lastInform: device.lastInform,
                firmware: parameters['InternetGatewayDevice.DeviceInfo.SoftwareVersion'] || 'Unknown',
                hardware: parameters['InternetGatewayDevice.DeviceInfo.HardwareVersion'] || 'Unknown',
                ipAddress: parameters['InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress'] || 'N/A',
                macAddress: parameters['InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.MACAddress'] || 'N/A',
                signalStrength: parameters['VirtualParameters.SignalStrength'] || 'N/A',
                temperature: parameters['VirtualParameters.Temperature'] || 'N/A'
            };
        } catch (error) {
            throw new Error(`Failed to get device status: ${error.message}`);
        }
    }

    /**
     * Get device full details (when needed)
     */
    async getDeviceDetails(serialNumber) {
        try {
            const query = {
                "_deviceId._SerialNumber": serialNumber
            };

            const response = await this.client.get('/devices', {
                params: {
                    query: JSON.stringify(query),
                    limit: 1
                }
            });

            if (!response.data || response.data.length === 0) {
                throw new Error(`Device not found: ${serialNumber}`);
            }

            return response.data[0];
        } catch (error) {
            throw new Error(`Failed to get device details: ${error.message}`);
        }
    }

    /**
     * Create task on device
     */
    async createTask(serialNumber, task, options = {}) {
        try {
            const requestTimeoutMs = Number(options.requestTimeoutMs);
            const connectionRequestTimeoutMs = Number(options.connectionRequestTimeoutMs);
            const hasRequestTimeout = Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0;
            const connectionRequestTimeout = Number.isFinite(connectionRequestTimeoutMs) && connectionRequestTimeoutMs > 0
                ? Math.floor(connectionRequestTimeoutMs)
                : 3000;
            const device = await this.getDeviceBySerial(serialNumber, {
                ...(hasRequestTimeout ? { requestTimeoutMs } : {})
            });

            // DEBUG: Check what device data is actually returning
            // console.log("DEBUG: Found Device Object:", device);

            if (!device || !device.id) {
                throw new Error(`Device with serial ${serialNumber} not found in GenieACS`);
            }

            // IMPORTANT: Ensure deviceId is URL encoded
            const deviceId = encodeURIComponent(device.id);
            // Try the standard tasks endpoint
            const response = await this.client.post(
                `/devices/${deviceId}/tasks?timeout=${connectionRequestTimeout}&connection_request=true`,
                task,
                hasRequestTimeout ? { timeout: requestTimeoutMs } : undefined
            );
            return {
                status: response.status === 202 ? "queued" : "completed",
                taskId: response.data?._id || null,
                message: response.status === 202 ? "Task queued successfully" : "Task completed successfully",
                timestamp: new Date().toISOString()
            };


            // return {
            //     taskId: response.data._id,
            //     message: "Task created successfully",
            //     timestamp: new Date().toISOString()
            // };
        } catch (error) {
            // Log the full error to see if it's an Axios error with a response
            if (error.response) {
                console.error("GenieACS API Error Response:", error.response.data);
            }
            throw new Error(`Failed to create task: ${error.message}`);
        }
    }


    async getDeviceURIId(serialNumber) {
        try {
            const device = await this.getDeviceBySerial(serialNumber);
            if (!device || !device.id) {
                throw new Error(`Device with serial ${serialNumber} not found in GenieACS`);
            }

            const deviceId = encodeURIComponent(device.id);
            const responseURI = `/devices/${deviceId}/tasks?timeout=3000&connection_request=true`;
            console.log("Response", responseURI);
            return {
                deviceId: responseURI,
                device: deviceId,
                message: "Task URI created successfully",
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            if (error.response) {
                console.error("GenieACS API Error Response:", error.response.data);
            }
            throw new Error(`Failed to create task: ${error.message}`);
        }
    }

    // Task methods
    async refreshObject(serialNumber, objectName, options = {}) {
        const task = {
            name: "refreshObject",
            objectName: objectName
        };
        return this.createTask(serialNumber, task, options);
    }

    // Create a new WANConnectionDevice (dynamic)
    async createWANConnection(serialNumber) {
        const task = {
            name: "addObject",
            objectName: "InternetGatewayDevice.WANDevice.1.WANConnectionDevice"
        };
        // Returns the new instance path, e.g., WANConnectionDevice.3
        const result = await this.createTask(serialNumber, task);
        const instance = result?.instance; // depends on ACS implementation
        if (!instance) throw new Error("Failed to create WANConnectionDevice");
        return instance;
    }

    // Create PPPoE connection dynamically
    async createPPPoEConnection(serialNumber, wanConnInstance, username, password, vlan = 200) {
        // 1. Add PPP instance under the dynamic WANConnectionDevice
        const addPPPTask = {
            name: "addObject",
            objectName: `${wanConnInstance}.WANPPPConnection`
        };
        const pppResult = await this.createTask(serialNumber, addPPPTask);
        const pppInstance = pppResult?.instance;
        if (!pppInstance) throw new Error("Failed to create WANPPPConnection");

        // 2. Set all PPP parameters dynamically
        const task = {
            name: "setParameterValues",
            parameterValues: [
                [`${pppInstance}.Username`, username, "xsd:string"],
                [`${pppInstance}.Password`, password, "xsd:string"],
                [`${pppInstance}.TransportType`, "PPPoE", "xsd:string"],
                [`${pppInstance}.X_HW_VLAN`, String(vlan), "xsd:unsignedInt"],
                [`${pppInstance}.NATEnabled`, "true", "xsd:boolean"],
                [`${pppInstance}.Enable`, "true", "xsd:boolean"],
                [`${pppInstance}.ConnectionTrigger`, "AlwaysOn", "xsd:string"],
                [`${pppInstance}.ConnectionType`, "IP_Routed", "xsd:string"]
            ]
        };
        return this.createTask(serialNumber, task);
    }


    async getWanInfo(serialNumber) {
        try {

            const device = await this.getDeviceBySerial(serialNumber, {
                projection: `
                _id,
                InternetGatewayDevice.WANDevice.1.WANConnectionDevice
            `.replace(/\s+/g, '')
            });

            const wanDevices =
                device?.InternetGatewayDevice?.WANDevice?.["1"]?.WANConnectionDevice;

            if (!wanDevices) {
                return {
                    totalWan: 0,
                    wanInstances: [],
                    wanList: []
                };
            }

            const wanInstances = Object.keys(wanDevices)
                .map(Number)
                .filter(n => !isNaN(n))
                .sort((a, b) => a - b);

            return {
                totalWan: wanInstances.length,
                wanInstances,
                wanList: wanInstances.map(w => ({
                    wanInstance: w
                }))
            };

        } catch (error) {
            throw new Error(`Failed to get WAN info: ${error.message}`);
        }
    }


    // Working wan ppp connection dump test
    // async createDumpWanPPP(serialNumber, username, password, vlan) {

    //     const wanIntance = await this.getWanInfo(serialNumber);

    //     console.log("Wan Intance", wanIntance);

    //     const newwanIntance = wanIntance.totalWan + 1;

    //     console.log("Wan Instance", newwanIntance);

    //     const addPPPTask = {
    //         name: "addObject",
    //         objectName: `InternetGatewayDevice.WANDevice.1.WANConnectionDevice`
    //     };
    //     const pppResult = await this.createTask(serialNumber, addPPPTask);
    //     console.log("PPP Result", pppResult);
    //     console.log("PPP Result Instance", pppResult.instance);
    //     if (!pppResult) throw new Error("Failed to create WANPPPConnection");


    //     console.log(`PPP Instance: ${pppResult}`);


    //     const addWanPPPConnection = {
    //         name: "addObject",
    //         objectName: `InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${newwanIntance}.WANPPPConnection`
    //     }

    //     const wanPPPConnectionResult = await this.createTask(serialNumber, addWanPPPConnection);

    //     console.log(`WAN PPP Connection Instance: ${wanPPPConnectionResult}`);



    //     const refreshTask = {
    //         name: "refreshObject",
    //         objectName: `InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${newwanIntance}.X_CT-COM_WANGponLinkConfig`
    //     }

    //     const refreshResult = await this.createTask(serialNumber, refreshTask);

    //     console.log("Refreshed WANPPPConnection", refreshResult);

    //     // 2. Set all PPP parameters dynamically
    //     const vlanTask = {
    //         name: "setParameterValues",
    //         parameterValues: [
    //             [`InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${newwanIntance}.X_CT-COM_WANGponLinkConfig.Mode`, 2, "xsd:unsignedInt"],
    //             [`InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${newwanIntance}.X_CT-COM_WANGponLinkConfig.VLANIDMark`, vlan, "xsd:unsignedInt"],
    //             [`InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${newwanIntance}.X_CT-COM_WANGponLinkConfig.802-1pMark`, 0, "xsd:unsignedInt"],
    //         ]
    //     };
    //     const vlanTaskResult = await this.createTask(serialNumber, vlanTask);
    //     console.log("VLAN Task Result", vlanTaskResult);




    //     const wanConnectionTask = {
    //         name: "setParameterValues",
    //         parameterValues: [
    //             [`InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${newwanIntance}.WANPPPConnection.1.ConnectionType`, "IP_Routed", "xsd:string"],
    //             [`InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${newwanIntance}.WANPPPConnection.1.Username`, username, "xsd:string"],
    //             [`InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${newwanIntance}.WANPPPConnection.1.Password`, password, "xsd:string"],
    //         ]
    //     };
    //     const wanConnectionTaskResult = await this.createTask(serialNumber, wanConnectionTask);
    //     console.log("WAN Connection Task Result", wanConnectionTaskResult);



    //     const serviceTask = {
    //         name: "setParameterValues",
    //         parameterValues: [
    //             [`InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${newwanIntance}.WANPPPConnection.1.X_D0542D_ServiceList`, "INTERNET", "xsd:string"],
    //             [`InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${newwanIntance}.WANPPPConnection.1.X_ALU-COM_IPv6PrefixDelegationEnabled`, 0, "xsd:unsignedInt"],
    //         ]
    //     };
    //     const serviceTaskResult = await this.createTask(serialNumber, serviceTask);
    //     console.log("Service Task Result", serviceTaskResult);


    //     const enablewanTask = {
    //         name: "setParameterValues",
    //         parameterValues: [
    //             [`InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${newwanIntance}.WANPPPConnection.1.Enable`, "true", "xsd:boolean"],
    //         ]
    //     };
    //     const enablewanTaskResult = await this.createTask(serialNumber, enablewanTask);
    //     console.log("Enable WAN Task Result", enablewanTaskResult);

    //     return {
    //         pppResult,
    //         wanPPPConnectionResult,
    //         refreshResult,
    //         vlanTaskResult,
    //         wanConnectionTaskResult,
    //         serviceTaskResult,
    //         enablewanTaskResult,
    //     }

    // }



    async createWANIPConnection(serialNumber, staticConfig, vlanId, type) {
        const taskResponse = {
            success: true,
            errors: []
        };

        try {
            // 1. Add the WANConnectionDevice
            const addDeviceTask = {
                name: "addObject",
                objectName: `InternetGatewayDevice.WANDevice.1.WANConnectionDevice`
            };

            const addDeviceResult = await this.createTask(serialNumber, addDeviceTask);

            if (addDeviceResult.status !== 'success') {
                throw new Error(`Step addWanDevice failed: ${addDeviceResult.message}`);
            }

            // Get the instance ID
            const deviceInstance = addDeviceResult.instance || (await this.getWanInfo(serialNumber)).totalWan;

            // 2. ROUTE TO CORRECT FUNCTION (Fixed Comparison and Added Await)
            let finalStatus;
            if (type === 'ppp') {
                console.log("Type", type)
                finalStatus = await this.createwanPPP(serialNumber, vlanId, deviceInstance, staticConfig);
            } else {
                console.log("Type 2", type)
                finalStatus = await this.createwanip(serialNumber, vlanId, deviceInstance, staticConfig);
            }

            taskResponse.message = finalStatus;

        } catch (err) {
            taskResponse.success = false;
            taskResponse.errors.push({
                step: 'exception',
                message: err.message
            });
        }

        return taskResponse;
    }



    async createwanip(serialNumber, vlanId, deviceInstance, staticConfig) {

        const { dnsServers, addressingType, externalIp, subnet, gateway, serviceType, isNat, isDNS } = staticConfig;

        const addIPTask = {
            name: "addObject",
            objectName: `InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${deviceInstance}.WANIPConnection`
        };

        const ipResult = await this.createTask(serialNumber, addIPTask);

        if (ipResult.status !== 'success') {
            taskResponse.success = false;
            taskResponse.errors.push({
                step: 'addWanIPConnection',
                message: ipResult.message
            });
        }

        const basicParam = {
            name: "setParameterValues",
            parameterValues: [
                [`InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${deviceInstance}.WANIPConnection.1.ConnectionType`, "IP_Routed", "xsd:string"],
                [`InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${deviceInstance}.WANIPConnection.1.DNSServers`, dnsServers, "xsd:string"],
                [`InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${deviceInstance}.WANIPConnection.1.AddressingType`, addressingType, "xsd:string"],
                [`InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${deviceInstance}.WANIPConnection.1.ExternalIPAddress`, externalIp, "xsd:string"],
                [`InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${deviceInstance}.WANIPConnection.1.SubnetMask`, subnet, "xsd:string"],
                [`InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${deviceInstance}.WANIPConnection.1.DefaultGateway`, gateway, "xsd:string"],
                [`InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${deviceInstance}.WANIPConnection.1.DNSEnabled`, isDNS, "xsd:boolean"],
                [`InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${deviceInstance}.WANIPConnection.1.NATEnabled`, isNat, "xsd:boolean"],
            ]
        };

        const mandatoryResult = await this.createTask(serialNumber, basicParam);

        const vlanPayload = `${deviceInstance}|${vlanId}|0|${serviceType}|ip`;
        const vlanParams = {
            name: "setParameterValues",
            parameterValues: [
                [`VirtualParameters.Wan_provision`, vlanPayload, "xsd:string"],
            ]
        };

        const vlanResults = await this.createTask(serialNumber, vlanParams);
        const enableWAN = {
            name: "setParameterValues",
            parameterValues: [
                [`InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${deviceInstance}.WANIPConnection.1.Enable`, true, "xsd:boolean"]
            ]
        };

        const enableWanResult = await this.createTask(serialNumber, enableWAN);

        if (ipResult.status !== 'success') {
            return 'failed to create New WAN IP Connection'
        } else {
            return `Successfully Create WAN IP Connection for Vlan - ${vlanId}`
        }

    }



    async createwanPPP(serialNumber, vlanId, deviceInstance, staticConfig) {
        const { username, password, serviceType, isNat } = staticConfig;

        // 1. Add the PPP Object
        const addPPPTask = {
            name: "addObject",
            objectName: `InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${deviceInstance}.WANPPPConnection`
        };
        const ipResult = await this.createTask(serialNumber, addPPPTask);

        // 2. Set PPP Specific Params (Removed WANIPConnection.ConnectionType)
        const basicParam = {
            name: "setParameterValues",
            parameterValues: [
                [`InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${deviceInstance}.WANPPPConnection.1.ConnectionType`, "IP_Routed", "xsd:string"],
                [`InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${deviceInstance}.WANPPPConnection.1.Username`, username, "xsd:string"],
                [`InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${deviceInstance}.WANPPPConnection.1.Password`, password, "xsd:string"],
                [`InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${deviceInstance}.WANPPPConnection.1.NATEnabled`, isNat, "xsd:boolean"],
                // Note: ConnectionType for PPP is usually managed by the PPP stack automatically or set to 'PPPoE_Bridged'
            ]
        };
        await this.createTask(serialNumber, basicParam);

        // 3. Set Virtual Parameter (FIXED: removed single quotes from ppp)
        const vlanPayload = `${deviceInstance}|${vlanId}|0|${serviceType}|ppp`;
        const vlanParams = {
            name: "setParameterValues",
            parameterValues: [
                [`VirtualParameters.Wan_provision`, vlanPayload, "xsd:string"],
            ]
        };
        await this.createTask(serialNumber, vlanParams);

        // 4. Enable(This will now work because the VP succeeded)
        const enableWAN = {
            name: "setParameterValues",
            parameterValues: [
                [
                    "InternetGatewayDevice.WANDevice.1.WANConnectionDevice." + deviceInstance + ".WANPPPConnection.1.Enable",
                    'true',
                    "xsd:boolean"
                ]
            ]
        };
        const enableWanResult = await this.createTask(serialNumber, enableWAN);


        return (enableWanResult.status === 'success') ? `Successfully created wan ppp profile of vlan ${vlanId}` : "Failed";
    }


    async updateWANConnection(serialNumber, wanId, type, vlanId, serviceType, staticConfig) {
        const taskResponse = {
            success: true,
            errors: []
        };

        try {
            // Update VLAN ID using virtual parameter Wan_provision
            // format: ${wanId}|${vlanId}|0|${serviceType}|${type}
            const vlanPayload = `${wanId}|${vlanId}|0|${serviceType}|${type}`;
            const vlanParams = {
                name: "setParameterValues",
                parameterValues: [
                    [`VirtualParameters.Wan_provision`, vlanPayload, "xsd:string"],
                ]
            };
            const vlanResult = await this.createTask(serialNumber, vlanParams);
            if (vlanResult.status !== 'success') {
                taskResponse.errors.push({ step: 'vlan_provision', message: vlanResult.message });
            }

            // Update specific connection parameters
            let basicParam;
            if (type === 'ppp') {
                const { username, password, isNat } = staticConfig;
                basicParam = {
                    name: "setParameterValues",
                    parameterValues: [
                        [`InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${wanId}.WANPPPConnection.1.Username`, username, "xsd:string"],
                        [`InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${wanId}.WANPPPConnection.1.Password`, password, "xsd:string"],
                        [`InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${wanId}.WANPPPConnection.1.NATEnabled`, isNat, "xsd:boolean"],
                    ]
                };
            } else {
                const { dnsServers, addressingType, externalIp, subnet, gateway, isNat, isDNS } = staticConfig;
                const pVals = [
                    [`InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${wanId}.WANIPConnection.1.DNSServers`, dnsServers || "", "xsd:string"],
                    [`InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${wanId}.WANIPConnection.1.AddressingType`, addressingType || "DHCP", "xsd:string"],
                    [`InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${wanId}.WANIPConnection.1.DNSEnabled`, isDNS, "xsd:boolean"],
                    [`InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${wanId}.WANIPConnection.1.NATEnabled`, isNat, "xsd:boolean"],
                ];

                if (addressingType === 'Static') {
                    pVals.push([`InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${wanId}.WANIPConnection.1.ExternalIPAddress`, externalIp || "", "xsd:string"]);
                    pVals.push([`InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${wanId}.WANIPConnection.1.SubnetMask`, subnet || "", "xsd:string"]);
                    pVals.push([`InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${wanId}.WANIPConnection.1.DefaultGateway`, gateway || "", "xsd:string"]);
                }

                basicParam = {
                    name: "setParameterValues",
                    parameterValues: pVals
                };
            }

            const configResult = await this.createTask(serialNumber, basicParam);
            if (configResult.status !== 'success') {
                taskResponse.success = false;
                taskResponse.errors.push({ step: 'config_update', message: configResult.message });
                throw new Error(`Failed to configure connection parameters: ${configResult.message}`);
            }

            taskResponse.message = "Successfully updated WAN Connection";
        } catch (err) {
            taskResponse.success = false;
            taskResponse.errors.push({
                step: 'exception',
                message: err.message
            });
        }

        return taskResponse;
    }


    async deleteWanConnection(serialNumber, wanId) {
        const addPPPTask = {
            name: "deleteObject",
            objectName: `InternetGatewayDevice.WANDevice.1.WANConnectionDevice.${wanId}`,
        };
        const wanDeleteResponse = await this.createTask(serialNumber, addPPPTask);

        if (wanDeleteResponse.status !== 'success') {
            return 'failed to Delete Wan Connection'
        } else {
            return `Successfully Deleted WAN Connection`
        }

    }


    async enableDisableWifiSSID(serialNumber, ssidIndex, operation) {

        const task = {
            name: "setParameterValues",
            parameterValues: [
                [`InternetGatewayDevice.LANDevice.1.WLANConfiguration.${ssidIndex}.Enable`, operation, "xsd:string"]
            ]
        };
        const response = await this.createTask(serialNumber, task);


        // console.log("SSID Response", response);


        if (response.status !== 'success') {
            return `Failed to proceed operations`
        } else {
            return `Operation has been successful`
        }

    }

    async configureWiFi(serialNumber, ssid, password) {
        const task = {
            name: "setParameterValues",
            parameterValues: [
                ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase", password, "xsd:string"],
                ["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID", ssid, "xsd:string"]
            ]
        };
        return this.createTask(serialNumber, task);
    }

    async updateAllSSIDpassword(serialNumber, password) {
        const task = {
            name: "setParameterValues",
            parameterValues: [
                ["VirtualParameters.Wifi_Key", password, "xsd:string"]
            ]
        };
        return this.createTask(serialNumber, task);
    }



    async updateSpecificSSID(serialNumber, ssidIndex = null, password = null, ssidName = null) {

        let payload = "";

        payload += ssidIndex ? ssidIndex : "";
        payload += "|";
        payload += password ? password : "";
        payload += "|";
        payload += ssidName ? ssidName : "";

        const task = {
            name: "setParameterValues",
            parameterValues: [
                ["VirtualParameters.Wifi_Key_Dynamic", payload, "xsd:string"]
            ]
        };

        return this.createTask(serialNumber, task);
    }


    async rebootDevice(serialNumber) {
        const task = {
            name: "reboot"
        };
        return this.createTask(serialNumber, task);
    }

    async factoryReset(serialNumber) {
        const task = {
            name: "factoryReset"
        };
        return this.createTask(serialNumber, task);
    }

    async getDeviceParameterSnapshot(serialNumber, { refresh = false } = {}) {
        let device = await this.getDeviceBySerial(serialNumber, { full: true });
        const refreshTasks = [];

        if (refresh) {
            const roots = [
                device?.InternetGatewayDevice ? 'InternetGatewayDevice' : null,
                device?.Device ? 'Device' : null,
                device?.VirtualParameters ? 'VirtualParameters' : null
            ].filter(Boolean);

            for (const objectName of roots) {
                try {
                    const task = await this.refreshObject(serialNumber, objectName);
                    refreshTasks.push({ objectName, ...task });
                } catch (error) {
                    refreshTasks.push({ objectName, status: 'failed', message: error.message });
                }
            }
            device = await this.getDeviceBySerial(serialNumber, { full: true });
        }

        return { device, refreshTasks };
    }

    async runDiagnostic(serialNumber, { type, target, repetitions = 4, timeout = 5000, interfacePath = '' }) {
        const device = await this.getDeviceBySerial(serialNumber, {
            projection: '_id,Device.IP.Diagnostics,Device.DNS.Diagnostics,InternetGatewayDevice.IPPingDiagnostics,InternetGatewayDevice.TraceRouteDiagnostics,InternetGatewayDevice.NSLookupDiagnostics'
        });
        const tr181 = Boolean(device?.Device);
        const dataModel = tr181 ? 'TR-181' : 'TR-098';
        const definition = DIAGNOSTIC_DEFINITIONS[dataModel][type];
        if (!definition) throw new Error(`Unsupported diagnostic type: ${type}`);
        const parameterValues = [
            [`${definition.root}.${definition.host}`, target, 'xsd:string']
        ];
        if (definition.interface && interfacePath) {
            parameterValues.push([`${definition.root}.${definition.interface}`, interfacePath, 'xsd:string']);
        }
        if (definition.count) {
            parameterValues.push([`${definition.root}.${definition.count}`, String(repetitions), 'xsd:unsignedInt']);
        }
        if (definition.timeout) {
            parameterValues.push([`${definition.root}.${definition.timeout}`, String(timeout), 'xsd:unsignedInt']);
        }
        parameterValues.push([`${definition.root}.DiagnosticsState`, 'Requested', 'xsd:string']);
        const task = await this.createTask(serialNumber, { name: 'setParameterValues', parameterValues });
        return { ...task, diagnostic: type, target, dataModel, resultPath: definition.root, resultStatus: 'pending' };
    }

    async getDiagnosticResult(serialNumber, { type, dataModel, refresh = false, taskId = '' }) {
        const normalizedType = String(type || '').toLowerCase();
        const normalizedModel = String(dataModel || '').toUpperCase() === 'TR-181' ? 'TR-181' : 'TR-098';
        const definition = DIAGNOSTIC_DEFINITIONS[normalizedModel]?.[normalizedType];
        if (!definition) throw new Error(`Unsupported diagnostic type: ${type}`);

        let queuedTask = null;
        if (taskId) {
            queuedTask = await this.getTask(taskId).catch(() => null);
        }

        let refreshError = null;
        let refreshTask = null;
        const refreshKey = `${serialNumber}:${normalizedModel}:${normalizedType}`;
        const lastRefreshAt = this.diagnosticRefreshAt?.get(refreshKey) || 0;
        const refreshDue = Date.now() - lastRefreshAt >= 60000;
        if (refresh && !queuedTask && refreshDue) {
            try {
                if (!this.diagnosticRefreshAt) this.diagnosticRefreshAt = new Map();
                this.diagnosticRefreshAt.set(refreshKey, Date.now());
                refreshTask = await this.refreshObject(serialNumber, definition.root);
            } catch (error) {
                refreshError = error.message;
            }
        }

        const device = await this.getDeviceBySerial(serialNumber, {
            projection: `_id,${definition.root}`
        });
        const flattened = flattenParameters(device);
        const prefix = `${definition.root}.`;
        const parameters = Object.fromEntries(
            Object.entries(flattened)
                .filter(([path]) => path.startsWith(prefix))
                .map(([path, value]) => [path.slice(prefix.length), value])
        );
        const diagnosticsState = String(parameters.DiagnosticsState || 'Unknown');
        const lowerState = diagnosticsState.toLowerCase();
        const diagnosticStatus = lowerState === 'complete'
            ? 'completed'
            : lowerState.startsWith('error')
                ? 'failed'
                : ['requested', 'none', 'unknown', ''].includes(lowerState)
                    ? 'pending'
                    : 'pending';
        const status = queuedTask ? 'queued' : diagnosticStatus;

        const groupedResults = new Map();
        for (const [path, value] of Object.entries(parameters)) {
            const match = path.match(/^(?:Result|Results|RouteHops?|Hop)\.(\d+)\.(.+)$/i);
            if (!match) continue;
            const [, index, field] = match;
            if (!groupedResults.has(index)) groupedResults.set(index, { index: Number(index) });
            groupedResults.get(index)[field] = value;
        }

        const valueFor = (...names) => {
            for (const name of names) {
                if (Object.prototype.hasOwnProperty.call(parameters, name)) return parameters[name];
                const key = Object.keys(parameters).find(path => path.endsWith(`.${name}`));
                if (key) return parameters[key];
            }
            return null;
        };

        const responseTimeFor = (detailedName, coarseName) => {
            const detailed = Number(valueFor(detailedName));
            if (Number.isFinite(detailed) && detailed > 0) return Number((detailed / 1000).toFixed(3));
            return valueFor(coarseName);
        };

        return {
            diagnostic: normalizedType,
            dataModel: normalizedModel,
            resultPath: definition.root,
            status,
            taskStatus: queuedTask ? 'queued' : 'consumed',
            message: queuedTask
                ? 'GenieACS has queued the task, but the CPE has not consumed it yet.'
                : diagnosticStatus === 'pending'
                    ? 'The CPE consumed the task and the diagnostic is still running or awaiting refreshed results.'
                    : null,
            queuedAt: queuedTask?.timestamp || null,
            diagnosticsState,
            target: valueFor(definition.host),
            summary: {
                successCount: valueFor('SuccessCount'),
                failureCount: valueFor('FailureCount'),
                resultCount: valueFor('ResultNumberOfEntries', 'RouteHopsNumberOfEntries'),
                minimumResponseTime: responseTimeFor('MinimumResponseTimeDetailed', 'MinimumResponseTime'),
                averageResponseTime: responseTimeFor('AverageResponseTimeDetailed', 'AverageResponseTime'),
                maximumResponseTime: responseTimeFor('MaximumResponseTimeDetailed', 'MaximumResponseTime'),
                responseTime: valueFor('ResponseTime'),
                dnsServer: valueFor('DNSServer')
            },
            results: [...groupedResults.values()].sort((a, b) => a.index - b.index),
            parameters,
            refreshTask,
            refreshError,
            retrievedAt: new Date().toISOString()
        };
    }

    async getTask(taskId) {
        if (!/^[a-f0-9]{24}$/i.test(String(taskId || ''))) return null;
        const response = await this.client.get('/tasks', {
            params: { query: JSON.stringify({ _id: String(taskId) }) }
        });
        return Array.isArray(response.data) ? response.data[0] || null : null;
    }

    async getDeviceTasks(serialNumber, limit = 20) {
        try {
            const device = await this.getDeviceBySerial(serialNumber);
            const response = await this.client.get('/tasks', {
                params: {
                    query: JSON.stringify({ device: device.id }),
                    limit
                }
            });

            return {
                serial: serialNumber,
                tasks: response.data || [],
                total: response.data ? response.data.length : 0
            };
        } catch (error) {
            throw new Error(`Failed to get device tasks: ${error.message}`);
        }
    }

    async getConnectedClients(serialNumber) {
        try {
            const device = await this.getDeviceBySerial(serialNumber);
            const deviceId = device.id;

            const response = await this.client.get(`/ devices / ${deviceId} / parameters`, {
                params: {
                    parameterNames: [
                        'InternetGatewayDevice.LANDevice.1.Hosts.Host.*.HostName',
                        'InternetGatewayDevice.LANDevice.1.Hosts.Host.*.MACAddress',
                        'InternetGatewayDevice.LANDevice.1.Hosts.Host.*.IPAddress',
                        'InternetGatewayDevice.LANDevice.1.Hosts.Host.*.LeaseTimeRemaining'
                    ]
                }
            });

            const parameters = response.data || {};
            const clients = [];

            // Parse client data
            Object.keys(parameters).forEach(key => {
                if (key.includes('InternetGatewayDevice.LANDevice.1.Hosts.Host')) {
                    const parts = key.split('.');
                    const hostIndex = parts[6];
                    const paramType = parts[7];

                    let client = clients.find(c => c.index === hostIndex);
                    if (!client) {
                        client = { index: hostIndex };
                        clients.push(client);
                    }

                    switch (paramType) {
                        case 'HostName':
                            client.name = parameters[key];
                            break;
                        case 'MACAddress':
                            client.mac = parameters[key];
                            break;
                        case 'IPAddress':
                            client.ip = parameters[key];
                            break;
                        case 'LeaseTimeRemaining':
                            client.leaseTime = parameters[key];
                            break;
                    }
                }
            });

            return {
                serial: serialNumber,
                totalClients: clients.length,
                clients: clients
            };
        } catch (error) {
            throw new Error(`Failed to get connected clients: ${error.message}`);
        }
    }
    
    // ==================== GENIEACS ADMIN CRUD METHODS ====================
    async getProvisions() {
        try {
            const response = await this.client.get('/provisions');
            return response.data || [];
        } catch (error) {
            if (error.response?.status === 404) return [];
            throw new Error(`Failed to get provisions: ${error.response?.status || ''} ${error.response?.statusText || error.message}`);
        }
    }

    async uploadProvision(name, scriptText) {
        try {
            const response = await this.client.put(`/provisions/${encodeURIComponent(name)}`, scriptText, {
                headers: { 'Content-Type': 'text/plain' }
            });
            return response.data;
        } catch (error) {
            throw new Error(`Failed to save provision: ${error.response?.data || error.message}`);
        }
    }

    async deleteProvision(name) {
        try {
            const response = await this.client.delete(`/provisions/${encodeURIComponent(name)}`);
            return response.data;
        } catch (error) {
            throw new Error(`Failed to delete provision: ${error.response?.data || error.message}`);
        }
    }

    async getVirtualParameters() {
        try {
            const response = await this.client.get('/virtual_parameters');
            return response.data || [];
        } catch (error) {
            if (error.response?.status === 404) return [];
            throw new Error(`Failed to get virtual parameters: ${error.response?.status || ''} ${error.response?.statusText || error.message}`);
        }
    }

    async uploadVirtualParameter(name, scriptText) {
        try {
            const response = await this.client.put(`/virtual_parameters/${encodeURIComponent(name)}`, scriptText, {
                headers: { 'Content-Type': 'text/plain' }
            });
            return response.data;
        } catch (error) {
            throw new Error(`Failed to save virtual parameter: ${error.response?.status || ''} ${error.response?.statusText || error.message}`);
        }
    }

    async deleteVirtualParameter(name) {
        try {
            const response = await this.client.delete(`/virtual_parameters/${encodeURIComponent(name)}`);
            return response.data;
        } catch (error) {
            throw new Error(`Failed to delete virtual parameter: ${error.response?.status || ''} ${error.response?.statusText || error.message}`);
        }
    }

    async getPresets() {
        try {
            const response = await this.client.get('/presets');
            return response.data || [];
        } catch (error) {
            if (error.response?.status === 404) return [];
            throw new Error(`Failed to get presets: ${error.response?.status || ''} ${error.response?.statusText || error.message}`);
        }
    }

    async uploadPreset(name, presetJson) {
        try {
            const response = await this.client.put(`/presets/${encodeURIComponent(name)}`, presetJson);
            return response.data;
        } catch (error) {
            throw new Error(`Failed to save preset: ${error.response?.data || error.message}`);
        }
    }

    async deletePreset(name) {
        try {
            const response = await this.client.delete(`/presets/${encodeURIComponent(name)}`);
            return response.data;
        } catch (error) {
            throw new Error(`Failed to delete preset: ${error.response?.data || error.message}`);
        }
    }

    async getFiles() {
        try {
            const response = await this.client.get('/files');
            return response.data || [];
        } catch (error) {
            if (error.response?.status === 404) return [];
            throw new Error(`Failed to get files: ${error.response?.status || ''} ${error.response?.statusText || error.message}`);
        }
    }

    async uploadFile(name, fileData, metadata = {}) {
        try {
            const response = await this.client.put(`/files/${encodeURIComponent(name)}`, fileData, {
                headers: {
                    'Content-Type': metadata.contentType || 'application/octet-stream',
                    'ch-options': JSON.stringify(metadata)
                }
            });
            return response.data;
        } catch (error) {
            throw new Error(`Failed to upload file: ${error.response?.data || error.message}`);
        }
    }

    async deleteFile(name) {
        try {
            const response = await this.client.delete(`/files/${encodeURIComponent(name)}`);
            return response.data;
        } catch (error) {
            throw new Error(`Failed to delete file: ${error.response?.data || error.message}`);
        }
    }
}

module.exports = { GenieACSClient };
