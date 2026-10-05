const bcrypt = require('bcrypt');
const crypto = require('crypto');
const prisma = require('../../prisma/client');

async function initExternalPaymentDb(prismaClient = prisma) {
  try {
    console.log('[External Payment DB] Initializing tables and configurations...');

    // 4. Ensure default BillingPaymentMethod for EXTERNAL exists for each active ISP
    const isps = await prismaClient.iSP.findMany({ select: { id: true } });
    for (const isp of isps) {
      const existingMethod = await prismaClient.billingPaymentMethod.findFirst({
        where: { ispId: isp.id, code: 'EXTERNAL' }
      });
      if (!existingMethod) {
        await prismaClient.billingPaymentMethod.create({
          data: {
            ispId: isp.id,
            name: 'External Payment',
            code: 'EXTERNAL',
            description: 'Automated external gateway & push payment method',
            isEnabled: true,
            isDefault: false
          }
        }).catch(err => console.warn('[External Payment DB] Billing method notice:', err.message));
      }

      // Ensure default configuration for the ISP
      const existingConfig = await prismaClient.externalPaymentConfiguration.findUnique({
        where: { ispId: isp.id }
      });

      if (!existingConfig) {
        const defaultUsername = `external_isp_${isp.id}`;
        const defaultPassword = `External@ISP#${isp.id}!2025`;
        const passwordHash = await bcrypt.hash(defaultPassword, 10);
        const apiKey = crypto.randomBytes(32).toString('hex');

        await prismaClient.externalPaymentConfiguration.create({
          data: {
            ispId: isp.id,
            username: defaultUsername,
            passwordHash: passwordHash,
            apiKey: apiKey,
            authMethod: 'BEARER',
            defaultPaymentMode: 'EXTERNAL',
            isActive: true
          }
        });
        console.log(`✅ [External Payment DB] Created default ExternalPaymentConfiguration for ISP ${isp.id} (username: ${defaultUsername}, password: ${defaultPassword})`);
      }
    }

  } catch (error) {
    console.error('❌ [External Payment DB] Error initializing tables:', error.message);
  }
}

if (require.main === module) {
  initExternalPaymentDb().then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = initExternalPaymentDb;
