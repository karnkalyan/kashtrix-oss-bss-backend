const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
const { SERVICE_CODES } = require('../lib/serviceConstants');
const prisma = new PrismaClient();

class NetTVClient {
    #config;
    #api;

    constructor(config) {
        this.#config = config;
        this.#api = axios.create({
            baseURL: config.baseUrl || 'https://resources.geniustv.dev.geniussystems.com.np',
            headers: {
                'Content-Type': 'application/json',
                'api-key': config.apiKey,
                'api-secret': config.apiSecret
            },
            timeout: 30000
        });
    }

    get resellerId() {
        return this.#config.resellerId;
    }

    get config() {
        return this.#config;
    }


    /**
     * Factory method to create NetTVClient using service code
     */
    static async create(ispId) {
        if (!ispId) {
            throw new Error('ISP ID is required to create a NetTV client.');
        }

        // Fetch service configuration using service code
        const nettvService = await prisma.iSPService.findFirst({
            where: {
                ispId: ispId,
                service: { code: SERVICE_CODES.NETTV },
                isActive: true,
                isEnabled: true,
                isDeleted: false
            },
            include: {
                service: true,
                credentials: {
                    where: { isActive: true, isDeleted: false },
                    orderBy: { createdAt: 'desc' }
                }
            }
        });

        if (!nettvService || !nettvService.baseUrl) {
            throw new Error(`NetTV service is not configured or enabled for ISP ID: ${ispId}`);
        }

        // Map credentials to key-value object
        const credentials = {};
        nettvService.credentials.forEach(cred => {
            credentials[cred.key] = cred.value;
        });

        // Required credentials for NetTV (based on your working Postman test)
        const apiKey = credentials.api_key;
        const apiSecret = credentials.api_secret;

        if (!apiKey || !apiSecret) {
            throw new Error(`Missing credentials for NetTV service. Required: api_key, api_secret`);
        }

        console.log(`[NETTV] Creating client for baseUrl: ${nettvService.baseUrl}, API Key: ${apiKey.substring(0, 8)}...`);

        return new NetTVClient({
            baseUrl: nettvService.baseUrl,
            apiKey: apiKey,
            apiSecret: apiSecret,
            apiVersion: nettvService.apiVersion || 'v1',
            config: nettvService.config || {},
            resellerId: credentials.reseller_id || credentials.resellerId || nettvService.config?.resellerId || nettvService.config?.reseller_id || null,
            createdBy: credentials.reseller_username || credentials.resellerUsername || credentials.createdBy || nettvService.config?.createdBy || 'kisannet',
            defaultPackageId: nettvService.config?.packageId || nettvService.config?.defaultPackageId || 145,
            btbnBaseUrl: nettvService.config?.btbnBaseUrl || 'https://btbn.geniustv.geniussystems.com.np',
            ispId: ispId
        });
    }

    // Helper method to get service status
    static async getServiceStatus(ispId) {
        try {
            const service = await prisma.iSPService.findFirst({
                where: {
                    ispId: ispId,
                    service: { code: SERVICE_CODES.NETTV },
                    isDeleted: false
                },
                include: {
                    service: true,
                    credentials: {
                        where: { isActive: true, isDeleted: false }
                    }
                }
            });

            if (!service) {
                return {
                    enabled: false,
                    configured: false,
                    message: 'Service not configured'
                };
            }

            const hasValidCredentials = service.credentials.some(c =>
                c.key === 'api_key' && c.value
            ) && service.credentials.some(c =>
                c.key === 'api_secret' && c.value
            );

            // Try to test connection
            let connectionTest = false;
            let connectionError = null;
            let connectionDetails = null;

            if (hasValidCredentials && service.baseUrl) {
                try {
                    const client = await NetTVClient.create(ispId);
                    const testResult = await client.testConnection();
                    connectionTest = testResult.connected;
                    connectionError = testResult.message;
                    connectionDetails = testResult.data;
                } catch (error) {
                    connectionTest = false;
                    connectionError = error.message;
                }
            }

            return {
                enabled: service.isActive && service.isEnabled,
                configured: !!service.baseUrl && hasValidCredentials,
                isActive: service.isActive,
                isEnabled: service.isEnabled,
                baseUrl: service.baseUrl,
                hasValidCredentials,
                connectionTest,
                connectionError,
                connectionDetails,
                serviceName: service.service.name,
                lastUpdated: service.updatedAt
            };
        } catch (error) {
            console.error('Error getting NetTV service status:', error);
            return {
                enabled: false,
                configured: false,
                error: error.message
            };
        }
    }

    // Make API request
    #formatApiMessage(errorData, fallback) {
        const message = errorData?.message || errorData?.error || fallback;
        if (typeof message === 'string') return message;
        if (Array.isArray(message)) return message.join(', ');
        if (message && typeof message === 'object') {
            return Object.entries(message)
                .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`)
                .join('; ');
        }
        return String(message || fallback);
    }

    async #apiRequest(method, endpoint, data = null, params = null) {
        try {
            const config = {
                method,
                url: endpoint.startsWith('/') ? endpoint : `/${endpoint}`,
                headers: {
                    'Content-Type': 'application/json',
                    'api-key': this.#config.apiKey,
                    'api-secret': this.#config.apiSecret
                }
            };

            if (method.toLowerCase() === 'get') {
                config.params = params;
            } else if (data) {
                config.data = data;
            }

            console.log(`[NETTV REQUEST] ${method.toUpperCase()} ${endpoint} - Params: ${JSON.stringify(params)} - Data: ${JSON.stringify(data)}`);

            const response = await this.#api.request(config);

            // Check for API errors
            if (response.data && response.data.error) {
                console.error(`[NETTV RESPONSE ERROR] ${method.toUpperCase()} ${endpoint} - Error:`, response.data.error);
                
                await prisma.serviceLog.create({
                    data: {
                        ispId: Number(this.#config.ispId || 1),
                        serviceCode: 'NETTV',
                        operation: `${method.toUpperCase()} ${endpoint}`,
                        status: 'failed',
                        message: String(response.data.error),
                        data: {
                            request: { params, data },
                            response: response.data
                        }
                    }
                }).catch(e => console.error('Failed to save service log', e));

                throw new Error(response.data.error);
            }

            console.log(`[NETTV RESPONSE SUCCESS] ${method.toUpperCase()} ${endpoint} - Status: ${response.status} - Data: ${JSON.stringify(response.data)}`);

            await prisma.serviceLog.create({
                data: {
                    ispId: Number(this.#config.ispId || 1),
                    serviceCode: 'NETTV',
                    operation: `${method.toUpperCase()} ${endpoint}`,
                    status: 'success',
                    message: `Status: ${response.status}`,
                    data: {
                        request: { params, data },
                        response: response.data
                    }
                }
            }).catch(e => console.error('Failed to save service log', e));

            return response.data;
        } catch (error) {
            console.error(`[NETTV API ERROR] ${method.toUpperCase()} ${endpoint} - Message: ${error.message} - Response:`, error.response?.data ? JSON.stringify(error.response.data) : 'No response data');

            await prisma.serviceLog.create({
                data: {
                    ispId: Number(this.#config.ispId || 1),
                    serviceCode: 'NETTV',
                    operation: `${method.toUpperCase()} ${endpoint}`,
                    status: 'failed',
                    message: error.message,
                    data: {
                        request: { params, data },
                        errorResponse: error.response?.data || null
                    }
                }
            }).catch(e => console.error('Failed to save service log', e));

            if (error.response) {
                const status = error.response.status;
                const errorData = error.response.data;

                switch (status) {
                    case 401:
                        throw new Error('Invalid API credentials');
                    case 403:
                        throw new Error('Access forbidden');
                    case 404:
                        throw new Error('Endpoint not found');
                    case 429:
                        throw new Error('Rate limit exceeded');
                    default:
                        throw new Error(this.#formatApiMessage(errorData, `API request failed with status ${status}`));
                }
            }

            throw new Error(error.message || 'API request failed');
        }
    }

    async testConnection() {
        try {
            // Try to get subscribers list to test connection
            const response = await this.#apiRequest('get', '/subscribers', null, {
                page: 1,
                per_page: 1
            });

            return {
                connected: true,
                message: 'Successfully connected to NetTV API',
                data: {
                    apiVersion: this.#config.apiVersion,
                    baseUrl: this.#config.baseUrl,
                    totalSubscribers: response.total || 0,
                    serverTime: new Date().toISOString(),
                    // Don't include the full data in test response
                    paginationInfo: {
                        totalPages: response.last_page || 1,
                        perPage: response.per_page || 1
                    }
                },
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            console.error('[NETTV] Test connection error:', error.message);
            return {
                connected: false,
                message: error.message,
                timestamp: new Date().toISOString()
            };
        }
    }

    // --- Public API Methods ---

    // Get all subscribers with pagination
    async getSubscribers(page = 1, perPage = 20, search = null) {
        const params = {
            page,
            limit: perPage,
            q: search || '',
            sort_field: 'id',
            sort_by: 'desc'
        };

        return this.#apiRequest('get', '/subscribers', null, params);
    }

    // Get a specific subscriber by username
    async getSubscriber(username) {
        return this.#apiRequest('get', `/subscribers/${encodeURIComponent(username)}`);
    }

    // Search subscribers
    async searchSubscribers(query, page = 1, perPage = 20) {
        return this.getSubscribers(page, perPage, query);
    }

    // Create a new subscriber
    async createSubscriber(subscriberData) {
        const requiredFields = ['username', 'email', 'password', 'fname', 'lname'];
        const missingFields = requiredFields.filter(field => !subscriberData[field]);

        if (missingFields.length > 0) {
            throw new Error(`Missing required fields: ${missingFields.join(', ')}`);
        }

        const payload = {
            has_ratv: 1,
            status: 1,
            ...subscriberData
        };

        const result = await this.#apiRequest('post', '/subscribers', payload);

        const subscriberId = result?.data?.id || result?.id || result?.subscriber?.id;
        if (subscriberId) {
            await this.addSubscriberGroup(subscriberId, 6).catch(err => {
                console.warn('[NETTV] Failed to add subscriber group 6:', err.message);
            });
        }

        return result;
    }

    async addSubscriberGroup(subscriberId, groupId = 6, resellerId = null) {
        const rId = resellerId || this.#config.resellerId || 2946;
        const endpoint = `/reseller/subscriber/v2/namespace/${rId}/subscribers/${subscriberId}/subscriber-groups`;
        return this.#apiRequest('post', endpoint, { subscriber_group_id: Number(groupId) });
    }



    async getCountriesProvices() {
        return this.#apiRequest('get', `/countries`);

    }

    // Update a subscriber
    async updateSubscriber(username, updateData) {
        const { username: _username, user_name: _userName, customer_username: _customerUsername, ...payload } = updateData || {};
        return this.#apiRequest('patch', `/subscribers/${encodeURIComponent(username)}`, payload);
    }

    // Delete a subscriber
    async deleteSubscriber(username) {
        return this.#apiRequest('delete', `/subscribers/${encodeURIComponent(username)}`);
    }

    async forceSubscriberPassword(username, payload) {
        return this.#apiRequest('patch', `/subscribers/${encodeURIComponent(username)}/pwd`, payload);
    }

    async requestSubscriberPasswordReset(payload) {
        return this.#apiRequest('post', '/subscribers/pwd/reset', payload);
    }

    async resetSubscriberPassword(payload) {
        return this.#apiRequest('patch', '/subscribers/pwd/reset', payload);
    }

    // Get packages
    async getPackages(page = 1, perPage = 20) {
        return this.#apiRequest('get', '/packages', null, {
            page,
            limit: perPage,
            q: '',
            sort_field: 'id',
            sort_by: 'desc'
        });
    }

    // Get package by ID
    async getPackage(packageId, serial = null) {
        return this.#apiRequest('get', `/packages/${packageId}`, null, serial ? { serial } : null);
    }

    async getPackageConfigs(serial) {
        return this.#apiRequest('get', `/config/${encodeURIComponent(serial)}/packages`);
    }

    async getPackageConfig(serial, packageId) {
        return this.#apiRequest(
            'get',
            `/config/${encodeURIComponent(serial)}/packages/${encodeURIComponent(packageId)}`
        );
    }

    // Get STBs (Set-Top Boxes)
    async getSTBs(subscriberId = null, page = 1, perPage = 20) {
        const params = { page, limit: perPage, q: '', sort_field: 'id', sort_by: 'desc' };
        if (subscriberId) {
            params.subscriber_id = subscriberId;
        }

        return this.#apiRequest('get', '/stbs', null, params);
    }

    async getSTB(serial) {
        return this.#apiRequest('get', `/stbs/${encodeURIComponent(serial)}`);
    }

    async getSubscriberSTB(username, serial) {
        return this.#apiRequest(
            'get',
            `/subscribers/${encodeURIComponent(username)}/stbs/${encodeURIComponent(serial)}`
        );
    }

    async createSTB(stbData) {
        return this.#apiRequest('post', '/stbs', stbData);
    }

    async updateSTB(serial, stbData) {
        return this.#apiRequest('patch', `/stbs/${encodeURIComponent(serial)}`, stbData);
    }

    async getSTBModels(page = 1, perPage = 100) {
        const params = { page, limit: perPage, sort_field: 'id', sort_by: 'desc' };
        return this.#apiRequest('get', '/models', null, params)
            .catch(() => this.#apiRequest('get', '/stb/models', null, params));
    }

    async getSTBVendors(page = 1, perPage = 100) {
        const params = { page, limit: perPage, sort_field: 'id', sort_by: 'desc' };
        return this.#apiRequest('get', '/vendors', null, params)
            .catch(() => this.#apiRequest('get', '/stb/vendors', null, params));
    }

    async getBootstrapServices(serial) {
        const baseUrl = String(this.#config.btbnBaseUrl || '').replace(/\/$/, '');
        if (!baseUrl) return null;
        const response = await axios.get(`${baseUrl}/${encodeURIComponent(serial)}`, { timeout: 30000 });
        return response.data;
    }

    async getSubscriberDevicePackages(resellerId, subscriberId, deviceId) {
        return this.#apiRequest(
            'get',
            `/reseller/package/v2/namespaces/${resellerId}/subscribers/${subscriberId}/devices/${deviceId}/packages`,
            null,
            { limit: 1000, page: 1, q: '', sort_field: 'id', sort_by: 'desc' }
        );
    }

    async getPaymentMethods(resellerId) {
        return this.#apiRequest('get', `/reseller/subscription/v1/namespaces/${resellerId}/payment-methods`);
    }

    async getCreditBalance(resellerId) {
        return this.#apiRequest('get', `/reseller/account/v1/namespaces/${resellerId}/credit-balance`);
    }

    async subscribePackages(serial, payload) {
        return this.#apiRequest('post', `/subscriptions/${encodeURIComponent(serial)}/packages`, payload);
    }

    async cancelPackageSubscription(serial, payload) {
        return this.#apiRequest('patch', `/subscriptions/${encodeURIComponent(serial)}/packages`, payload);
    }

    async getSubscriberOrders(page = 1, perPage = 20, username = '') {
        const params = { page, limit: perPage, sort_field: 'id', sort_by: 'desc' };
        if (username) params['filter[subscriber_stb.user.username]'] = username;
        return this.#apiRequest('get', '/subscribers/orders', null, params);
    }

    async getSubscriberOrder(orderId) {
        return this.#apiRequest('get', `/subscribers/orders/${encodeURIComponent(orderId)}`);
    }

    async getInvoicePrint(companyPaymentId) {
        return this.#apiRequest('get', `/invoices/${encodeURIComponent(companyPaymentId)}/print`);
    }

    async getCreditNotePrint(companyPaymentId) {
        return this.#apiRequest('get', `/credit-notes/${encodeURIComponent(companyPaymentId)}/print`);
    }

    async getMacReplaceReasons() {
        return this.#apiRequest('get', '/mac/replace-reasons/config');
    }

    async getSubscriberOverview(username) {
        const subscriber = await this.getSubscriber(username);
        const resellerId = subscriber?.reseller_id || this.#config.resellerId;
        const directStbs = Array.isArray(subscriber?.stbs) ? subscriber.stbs : [];
        const userStbs = Array.isArray(subscriber?.user_stbs)
            ? subscriber.user_stbs.map(link => ({
                ...(link.stb || {}),
                subscriber_stb_id: link.id,
                stb_user: { ...link, stb: undefined }
            }))
            : [];
        const shallowStbs = [...directStbs, ...userStbs].filter(
            (stb, index, all) => stb?.serial && all.findIndex(item => item?.serial === stb.serial) === index
        );
        const stbs = await Promise.all(shallowStbs.map(async (stb) => {
            const serial = stb.serial;
            if (!serial) return { ...stb };
            const detail = await this.getSTB(serial).catch(error => ({ ...stb, detail_error: error.message }));
            const deviceId = detail?.stb_user?.id || stb.subscriber_stb_id;
            const packageIds = [...new Set([
                this.#config.defaultPackageId,
                ...(detail?.subscribed_packages || []).map(item => item.package_id),
                ...(detail?.active_package || []).map(item => item.package_id)
            ].filter(Boolean))];
            const [bootstrap, availablePackages, packageDetails] = await Promise.all([
                this.getBootstrapServices(serial).catch(error => ({ error: error.message })),
                resellerId && subscriber?.id && deviceId
                    ? this.getSubscriberDevicePackages(resellerId, subscriber.id, deviceId).catch(error => ({ error: error.message }))
                    : null,
                Promise.all(packageIds.map(id => this.getPackage(id, serial).catch(error => ({ id, error: error.message }))))
            ]);
            return { ...detail, bootstrap, available_packages: availablePackages, package_details: packageDetails };
        }));
        let [paymentMethods, creditBalance] = resellerId
            ? await Promise.all([
                this.getPaymentMethods(resellerId).catch(error => ({ error: error.message })),
                this.getCreditBalance(resellerId).catch(error => ({ error: error.message }))
            ])
            : [null, null];
        if (paymentMethods?.error) {
            paymentMethods = {
                status: 'fallback',
                data: [{ reseller_wallet: 'Reseller Wallet' }, { wallet: 'Subscriber Wallet' }]
            };
        }
        if (creditBalance?.error) {
            creditBalance = {
                credit_balance: Number(subscriber?.reseller?.credit_balance ?? subscriber?.balance ?? 0),
                enable_credit_balance: String(subscriber?.reseller?.enable_credit_balance ?? '0')
            };
        }
        return { subscriber, stbs, reseller: { id: resellerId, payment_methods: paymentMethods, credit_balance: creditBalance } };
    }

    // Add STB to subscriber
    async addSTBToSubscriber(username, stbData) {
        const payload = {
            username,
            ...stbData
        };

        return this.#apiRequest('post', `/subscribers/${encodeURIComponent(username)}/stbs`, payload);
    }

    // Remove STB from subscriber
    async removeSTBFromSubscriber(username, serial, payload = {}) {
        return this.#apiRequest(
            'delete',
            `/subscribers/${encodeURIComponent(username)}/stbs/${encodeURIComponent(serial)}`,
            { username, ...payload }
        );
    }

    async replaceSubscriberSTB(username, oldSerial, payload) {
        return this.#apiRequest(
            'post',
            `/subscribers/${encodeURIComponent(username)}/replace/stb/${encodeURIComponent(oldSerial)}`,
            payload
        );
    }

    // Get subscriber invoices
    async getInvoices(subscriberId = null, status = null, page = 1, perPage = 20) {
        const params = { page, per_page: perPage };
        if (subscriberId) params.subscriber_id = subscriberId;
        if (status) params.status = status;

        return this.#apiRequest('get', '/invoices', null, params);
    }

    // Get system statistics
    async getSystemStats() {
        return this.#apiRequest('get', '/stats/system');
    }

    // Get dashboard statistics
    async getDashboardStats() {
        return this.#apiRequest('get', '/dashboard/stats');
    }

    // Health check
    async getHealth() {
        try {
            const [systemStats, connectionTest] = await Promise.all([
                this.getSystemStats(),
                this.testConnection()
            ]);

            return {
                status: 'healthy',
                timestamp: new Date().toISOString(),
                system: systemStats,
                connection: connectionTest
            };
        } catch (error) {
            return {
                status: 'unhealthy',
                timestamp: new Date().toISOString(),
                error: error.message
            };
        }
    }
}

module.exports = { NetTVClient };
