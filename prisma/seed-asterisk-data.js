const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const ispId = 1;
  console.log(`[SEED] Seeding Asterisk configurations for ISP ID ${ispId}...`);

  // 1. Seed AsteriskProvisioningConfig
  const existingConfig = await prisma.asteriskProvisioningConfig.findUnique({
    where: { ispId }
  });

  const configData = {
    enabled: true,
    pbxHost: '10.3.2.16',
    sipPort: 5060,
    ariEnabled: true,
    ariHost: '10.3.2.16',
    ariPort: 8088,
    ariAppName: 'kisan',
    ariUsername: 'kashtrix-api',
    ariPassword: process.env.KASHTRIX_ARI_PASSWORD || 'ff3a057975bf236605cd718948b8cf9bb9d07994088ee4e1',
    amiEnabled: true,
    amiHost: '10.3.2.16',
    amiPort: 5038,
    amiUsername: 'kashtrix-ami',
    amiPassword: process.env.KASHTRIX_AMI_SECRET || 'kashtrix-ami-secret-key-1234',
    provisioningEnabled: true,
    provisioningMode: 'ssh',
    provisioningHost: '10.3.2.16',
    provisioningPort: 22,
    provisioningUsername: 'kashtrix-api',
    sshPrivateKey: process.env.KASHTRIX_ASTERISK_SSH_KEY_PATH || '',
    asteriskConfigDirectory: '/etc/asterisk',
    asteriskCliPath: '/usr/sbin/asterisk',
    asteriskSystemdService: 'asterisk',
    customDialplanFile: '/etc/asterisk/extensions_custom.conf',
    audioSocketBindHost: '127.0.0.1',
    cdrSourceType: 'internal_cache',
    
    // Compatibility fields
    mode: 'ssh',
    host: '10.3.2.16',
    port: 22,
    username: 'kashtrix-api',
    sshHost: '10.3.2.16',
    sshPort: 22,
    sshUsername: 'kashtrix-api',
    sshPassword: process.env.KASHTRIX_AMI_SECRET || 'kashtrix-ami-secret-key-1234',
    localConfigDir: './scratch/asterisk'
  };

  if (!existingConfig) {
    await prisma.asteriskProvisioningConfig.create({
      data: {
        ispId,
        ...configData
      }
    });
    console.log('[SEED] Created default AsteriskProvisioningConfig.');
  } else {
    // Reconcile and fill missing properties without overwriting existing non-empty values
    const updates = {};
    for (const [key, val] of Object.entries(configData)) {
      if (existingConfig[key] === null || existingConfig[key] === undefined || existingConfig[key] === '') {
        updates[key] = val;
      }
    }
    if (Object.keys(updates).length > 0) {
      await prisma.asteriskProvisioningConfig.update({
        where: { ispId },
        data: updates
      });
      console.log('[SEED] Reconciled existing AsteriskProvisioningConfig fields:', Object.keys(updates));
    } else {
      console.log('[SEED] AsteriskProvisioningConfig already fully populated.');
    }
  }

  // 1.5 Seed legacy ISPService credentials (ARI + AMI)
  const asteriskService = await prisma.service.findFirst({
    where: { code: 'ASTERISK' }
  });
  if (asteriskService) {
    const ispService = await prisma.iSPService.findFirst({
      where: { ispId, serviceId: asteriskService.id }
    });
    if (ispService) {
      const credentialsToSeed = [
        { key: 'ari_host', value: '10.3.2.16', credentialType: 'username_password', label: 'ARI Host/IP' },
        { key: 'ari_port', value: '8088', credentialType: 'username_password', label: 'ARI Port' },
        { key: 'ari_username', value: 'kashtrix-api', credentialType: 'username_password', label: 'ARI Username' },
        { key: 'ari_password', value: 'ff3a057975bf236605cd718948b8cf9bb9d07994088ee4e1', credentialType: 'username_password', label: 'ARI Password', isEncrypted: true },
        { key: 'ari_app_name', value: 'kisan', credentialType: 'username_password', label: 'ARI App Name' },
        { key: 'ami_host', value: '10.3.2.16', credentialType: 'username_password', label: 'AMI Host/IP' },
        { key: 'ami_port', value: '5038', credentialType: 'username_password', label: 'AMI Port' },
        { key: 'ami_username', value: 'kashtrix-ami', credentialType: 'username_password', label: 'AMI Username' },
        { key: 'ami_password', value: 'kashtrix-ami-secret-key-1234', credentialType: 'username_password', label: 'AMI Password', isEncrypted: true }
      ];
      for (const cred of credentialsToSeed) {
        await prisma.serviceCredential.upsert({
          where: {
            ispServiceId_key: {
              ispServiceId: ispService.id,
              key: cred.key
            }
          },
          update: {
            value: cred.value
          },
          create: {
            ispServiceId: ispService.id,
            ...cred
          }
        });
      }
      console.log('[SEED] Seeded legacy ASTERISK Service credentials (ARI + AMI).');
    }
  }

  // 2. Seed Default AI Agents
  const AsteriskAiAgentService = require('../src/services/asterisk-ai-agent.service');
  const agentService = new AsteriskAiAgentService(ispId, prisma);
  await agentService.syncDefaultAgents();
  console.log('[SEED] Seeding default AI Voice Agents complete.');
}

main()
  .catch((e) => {
    console.error('[SEED] Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
