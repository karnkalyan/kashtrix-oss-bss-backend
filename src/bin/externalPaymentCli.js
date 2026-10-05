#!/usr/bin/env node
/**
 * CLI Tool for External Payment Configuration Management
 * Usage:
 *   node src/bin/externalPaymentCli.js --isp 1 --username my_gateway --password "MySecretPass#123"
 *   node src/bin/externalPaymentCli.js --generate --isp 2
 *   node src/bin/externalPaymentCli.js --list
 */

const path = require('path');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const prisma = require('../../prisma/client');

function printHelp() {
  console.log(`
=====================================================
  Kisan ISP - External Payment Gateway CLI Generator
=====================================================

Usage:
  node src/bin/externalPaymentCli.js [options]

Commands & Options:
  --isp <id>             ISP ID (default: 1)
  --username <user>      Set custom username for the external gateway
  --password <pass>      Set custom password (minimum 8 characters)
  --generate             Auto-generate random strong username & password
  --mode <mode>          Default payment mode (EXTERNAL, CASH, ONLINE, ESEWA, etc. default: EXTERNAL)
  --disable              Deactivate external payment credentials for this ISP
  --enable               Activate external payment credentials for this ISP
  --list                 List all configured external payment gateways across all ISPs
  --help                 Show this help screen

Examples:
  # Auto-generate credentials for ISP 2:
  node src/bin/externalPaymentCli.js --isp 2 --generate

  # Set custom credentials for ISP 1:
  node src/bin/externalPaymentCli.js --isp 1 --username reseller_gateway --password "KisanReseller#2026!"

  # List all ISP gateway configurations:
  node src/bin/externalPaymentCli.js --list
`);
}

async function listAll() {
  const configs = await prisma.externalPaymentConfiguration.findMany({
    orderBy: { ispId: 'asc' },
    include: {
      isp: {
        select: { id: true, companyName: true }
      }
    }
  });

  if (configs.length === 0) {
    console.log('No external payment configurations found in database.');
    return;
  }

  console.log('\n=== CONFIGURED EXTERNAL PAYMENT GATEWAYS ===');
  configs.forEach(c => {
    const ispName = c.isp?.companyName || c.isp?.name || `ISP #${c.ispId}`;
    console.log(`
--------------------------------------------------
ISP ID:               ${c.ispId} (${ispName})
Gateway Username:     ${c.username}
Password Hash:        ${c.passwordHash ? 'Configured (Encrypted bcrypt)' : 'Not set'}
API Key:              ${c.apiKey || 'None'}
Status:               ${c.isActive ? 'ACTIVE' : 'DISABLED'}
Default Payment Mode: ${c.defaultPaymentMode}
Last Updated:         ${c.updatedAt ? new Date(c.updatedAt).toLocaleString() : 'N/A'}
--------------------------------------------------`);
  });
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h') || (args.length === 0 && !args.includes('--list'))) {
    printHelp();
    process.exit(0);
  }

  if (args.includes('--list')) {
    await listAll();
    process.exit(0);
  }

  // Parse arguments
  const getArg = (flag) => {
    const idx = args.indexOf(flag);
    if (idx !== -1 && idx + 1 < args.length) {
      return args[idx + 1];
    }
    return null;
  };

  const ispId = Number(getArg('--isp') || 1);
  const isGenerate = args.includes('--generate');
  const isDisable = args.includes('--disable');
  const isEnable = args.includes('--enable');
  const mode = (getArg('--mode') || 'EXTERNAL').toUpperCase();

  let username = getArg('--username');
  let password = getArg('--password');

  if (isGenerate) {
    const randomSuffix = crypto.randomBytes(3).toString('hex');
    username = username || `ext_isp${ispId}_${randomSuffix}`;
    const generatedPass = `ExtPay#${ispId}!${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    password = password || generatedPass;
  }

  if (!username && !password && !isDisable && !isEnable) {
    console.error('❌ Error: Please provide --username and --password or use --generate');
    printHelp();
    process.exit(1);
  }

  // Validate ISP exists
  const isp = await prisma.iSP.findUnique({ where: { id: ispId } });
  if (!isp) {
    console.error(`❌ Error: ISP with ID ${ispId} does not exist in database.`);
    process.exit(1);
  }

  const ispName = isp.companyName || isp.name || `ISP #${ispId}`;
  const existing = await prisma.externalPaymentConfiguration.findUnique({ where: { ispId } });

  let newPasswordHash = undefined;
  if (password) {
    if (password.length < 8) {
      console.error('❌ Error: Password must be at least 8 characters long.');
      process.exit(1);
    }
    newPasswordHash = await bcrypt.hash(password, 10);
  }

  const updateData = {
    ...(username ? { username: username.trim() } : {}),
    ...(newPasswordHash ? { passwordHash: newPasswordHash } : {}),
    defaultPaymentMode: mode,
    updatedAt: new Date()
  };

  if (isDisable) updateData.isActive = false;
  if (isEnable) updateData.isActive = true;

  let result;
  if (existing) {
    result = await prisma.externalPaymentConfiguration.update({
      where: { ispId },
      data: updateData
    });
  } else {
    if (!password) {
      password = `External@ISP#${ispId}!2025`;
      newPasswordHash = await bcrypt.hash(password, 10);
    }
    username = username || `external_isp_${ispId}`;

    result = await prisma.externalPaymentConfiguration.create({
      data: {
        ispId,
        username: username.trim(),
        passwordHash: newPasswordHash,
        apiKey: crypto.randomBytes(32).toString('hex'),
        defaultPaymentMode: mode,
        authMethod: 'BEARER',
        isActive: !isDisable
      }
    });
  }

  console.log(`
=====================================================
  ✅ External Payment Credentials Ready for ISP ${ispId}
=====================================================
ISP Name:             ${ispName}
ISP ID:               ${ispId}
Gateway Username:     ${result.username}
Gateway Password:     ${password ? password : '(Unchanged - existing password retained)'}
Default Payment Mode: ${result.defaultPaymentMode}
Gateway Status:       ${result.isActive ? 'ACTIVE' : 'DISABLED'}
API Key:              ${result.apiKey || 'Auto-configured'}
=====================================================

cURL Integration Command:
curl -X POST "https://cms.kisan.net.np/api/externalpayment/payment" \\
  -u "${result.username}:${password || '<configured-password>'}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "username": "karnkalyan",
    "payment_mode": "${result.defaultPaymentMode}"
  }'
`);
}

main()
  .catch(err => {
    console.error('❌ CLI Execution Error:', err.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
