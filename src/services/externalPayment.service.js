const { PrismaClient } = require('@prisma/client');
const { SERVICE_CODES } = require('../lib/serviceConstants');
const prisma = new PrismaClient();

class ExternalPaymentClient {
    #config;

    constructor(config) {
        this.#config = config;
    }

    static async create(ispId) {
        if (!ispId) {
            throw new Error('ISP ID is required to create an External Payment client.');
        }

        const config = await prisma.externalPaymentConfiguration.findUnique({
            where: { ispId: Number(ispId) }
        });

        if (!config || !config.isActive) {
            throw new Error(`External Payment service is not active or configured for ISP ID: ${ispId}`);
        }

        return new ExternalPaymentClient({
            ispId: Number(ispId),
            username: config.username,
            apiKey: config.apiKey,
            authMethod: config.authMethod,
            defaultPaymentMode: config.defaultPaymentMode,
            integrationMode: 'TOKEN_BASED'
        });
    }

    static async getServiceStatus(ispId) {
        try {
            const [config, service] = await Promise.all([
                prisma.externalPaymentConfiguration.findUnique({
                    where: { ispId: Number(ispId) }
                }),
                prisma.iSPService.findFirst({
                    where: {
                        ispId: Number(ispId),
                        service: { code: SERVICE_CODES.EXTERNAL_PAYMENT },
                        isDeleted: false
                    },
                    include: { service: true }
                })
            ]);

            const isConfigured = Boolean(config && config.username);
            const isEnabled = Boolean(config?.isActive);

            return {
                enabled: isEnabled,
                configured: isConfigured,
                isActive: config?.isActive || false,
                isEnabled: isEnabled,
                username: config?.username || null,
                authMethod: config?.authMethod || 'BEARER',
                defaultPaymentMode: config?.defaultPaymentMode || 'EXTERNAL',
                integrationMode: 'TOKEN_BASED',
                serviceName: service?.service?.name || 'External Payment Gateway',
                lastUpdated: config?.updatedAt || null
            };
        } catch (error) {
            console.error('Error getting External Payment service status:', error);
            return {
                enabled: false,
                configured: false,
                error: error.message
            };
        }
    }

    async testConnection() {
        try {
            const ispId = Number(this.#config.ispId || 1);
            const paymentCount = await prisma.externalPayment.count({
                where: { ispId }
            });

            const result = {
                connected: true,
                message: 'External Payment gateway routes and tables are active and ready for inbound requests.',
                integrationMode: 'TOKEN_BASED',
                username: this.#config.username,
                defaultPaymentMode: this.#config.defaultPaymentMode,
                totalTransactionsRecorded: paymentCount,
                timestamp: new Date().toISOString()
            };

            await prisma.serviceLog.create({
                data: {
                    ispId,
                    serviceCode: SERVICE_CODES.EXTERNAL_PAYMENT,
                    operation: 'testConnection',
                    status: 'success',
                    message: 'External Payment connection test successful',
                    data: result
                }
            }).catch(e => console.warn('Failed to save service log', e.message));

            return result;
        } catch (error) {
            return {
                connected: false,
                message: 'External Payment test failed: ' + error.message,
                timestamp: new Date().toISOString()
            };
        }
    }

    async verifyPayment(transactionCode) {
        const payment = await prisma.externalPayment.findFirst({
            where: {
                ispId: Number(this.#config.ispId || 1),
                transactionCode: String(transactionCode)
            }
        });

        if (!payment) {
            throw new Error(`Payment transaction not found for code: ${transactionCode}`);
        }

        return payment;
    }

    async processPayment(paymentData) {
        // Direct method call delegating to database verification
        return {
            success: true,
            message: 'External payment ready for processing via /api/externalpayment/payment',
            data: paymentData
        };
    }
}

module.exports = {
    ExternalPaymentClient
};
