require('dotenv').config();

const { execSync } = require('child_process');
const prisma = require('../../../prisma/client.js');

function assertPostgreSQLDatabase(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not configured');
  }

  const protocol = new URL(databaseUrl).protocol;
  if (!['postgres:', 'postgresql:'].includes(protocol)) {
    throw new Error('DATABASE_URL must use PostgreSQL (postgresql:// or postgres://)');
  }
}

async function main() {
  assertPostgreSQLDatabase();

  // Ensure persistent license storage directory and permissions exist
  try {
    const fs = require('fs');
    const storageDir = process.env.KTX_LICENSE_STORAGE_DIR || '/app/data/secure-license';
    fs.mkdirSync(storageDir, { recursive: true, mode: 0o777 });
    try {
      execSync(`chmod -R 777 "${storageDir}" 2>/dev/null || true`);
    } catch {}
  } catch {}

  // The checked-in migration history was originally generated for MySQL and
  // cannot be executed by PostgreSQL. Synchronize the current Prisma schema
  // directly until a PostgreSQL migration history is baselined.
  console.log('[docker-startup] Synchronizing the Prisma schema with PostgreSQL without accepting data loss.');
  execSync('npx prisma db push --skip-generate', { stdio: 'inherit' });

  const userCount = await prisma.user.count();
  const forceSeed = String(process.env.FORCE_FULL_SEED || '').toLowerCase() === 'true';

  if (forceSeed || userCount === 0) {
    console.log('[docker-startup] Empty database detected; running default full seed.');
    execSync('npm run defaultFullSeed', { stdio: 'inherit' });
  } else {
    console.log(`[docker-startup] Database already has ${userCount} user(s); skipping destructive full seed.`);
  }

  // This seed only upserts catalog definitions. It never deletes ISP service
  // configuration or credentials, so it is safe on every container startup.
  console.log('[docker-startup] Updating service catalog definitions.');
  execSync('npm run servicesSeed', { stdio: 'inherit' });
  execSync('npm run services:update-accounting', { stdio: 'inherit' });
}

main()
  .catch((error) => {
    console.error('[docker-startup] Failed:', error.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
