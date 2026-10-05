const defaultPrisma = require('../../prisma/client');
const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};
let consoleCaptureInstalled = false;
let consoleLogQueue = Promise.resolve();

function redactText(value) {
  return String(value)
    .replace(/(password|secret|token|authorization|cookie|credential)(\s*[=:]\s*)[^\s,;]+/gi, '$1$2[REDACTED]')
    .slice(0, 10000);
}

function toSafeDetails(details, seen = new WeakSet()) {
  if (details === null) return null;
  if (details === undefined) return undefined;
  if (typeof details === 'bigint') return details.toString();
  if (typeof details !== 'object') {
    if (typeof details === 'string') return redactText(details).slice(0, 1000);
    if (typeof details === 'number' || typeof details === 'boolean') return details;
    return String(details);
  }
  if (seen.has(details)) return '[Circular]';
  seen.add(details);
  if (Array.isArray(details)) return details.slice(0, 100).map((value) => toSafeDetails(value, seen));
  if (details instanceof Date) return details.toISOString();
  const blocked = /password|secret|token|authorization|cookie|credential/i;
  return Object.fromEntries(
    Object.entries(details).slice(0, 100)
      .filter(([key]) => !blocked.test(key))
      .map(([key, value]) => [key, toSafeDetails(value, seen)])
  );
}

let tableChecked = false;
let tableExists = true;

async function ensureSystemLogsTable(client) {
  if (tableChecked) return tableExists;
  try {
    if (client?.$executeRawUnsafe) {
      await client.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS \`system_logs\` (
          \`id\` INTEGER NOT NULL AUTO_INCREMENT,
          \`ispId\` INTEGER NULL,
          \`userId\` INTEGER NULL,
          \`level\` VARCHAR(16) NOT NULL,
          \`operation\` VARCHAR(120) NOT NULL,
          \`message\` TEXT NOT NULL,
          \`method\` VARCHAR(10) NULL,
          \`path\` VARCHAR(500) NULL,
          \`statusCode\` INTEGER NULL,
          \`ip\` VARCHAR(191) NULL,
          \`userAgent\` VARCHAR(500) NULL,
          \`durationMs\` INTEGER NULL,
          \`details\` JSON NULL,
          \`timestamp\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          INDEX \`system_logs_ispId_timestamp_idx\`(\`ispId\`, \`timestamp\`),
          INDEX \`system_logs_level_timestamp_idx\`(\`level\`, \`timestamp\`),
          INDEX \`system_logs_operation_timestamp_idx\`(\`operation\`, \`timestamp\`),
          PRIMARY KEY (\`id\`)
        ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
      `);
      tableExists = true;
    }
  } catch (e) {
    tableExists = false;
  } finally {
    tableChecked = true;
  }
  return tableExists;
}

async function logSystem(prismaClient, entry = {}) {
  try {
    const client = prismaClient || defaultPrisma;
    if (!client?.systemLog) return;
    
    if (!tableChecked) {
      await ensureSystemLogsTable(client);
    }
    if (!tableExists) return;

    await client.systemLog.create({
      data: {
        ispId: entry.ispId ? Number(entry.ispId) : null,
        userId: entry.userId ? Number(entry.userId) : null,
        level: String(entry.level || 'INFO').toUpperCase().slice(0, 16),
        operation: String(entry.operation || 'SYSTEM').slice(0, 120),
        message: String(entry.message || 'System operation').slice(0, 10000),
        method: entry.method ? String(entry.method).slice(0, 10) : null,
        path: entry.path ? String(entry.path).slice(0, 500) : null,
        statusCode: Number.isFinite(Number(entry.statusCode)) ? Number(entry.statusCode) : null,
        ip: entry.ip ? String(entry.ip).slice(0, 191) : null,
        userAgent: entry.userAgent ? String(entry.userAgent).slice(0, 500) : null,
        durationMs: Number.isFinite(Number(entry.durationMs)) ? Number(entry.durationMs) : null,
        details: toSafeDetails(entry.details),
        timestamp: entry.timestamp || new Date(),
      },
    });
  } catch (error) {
    if (error.message?.includes('system_logs') && error.message?.includes('does not exist')) {
      tableExists = false;
      tableChecked = true;
    }
  }
}

function installConsoleSystemLogger(prismaClient) {
  if (consoleCaptureInstalled) return;
  consoleCaptureInstalled = true;
  const levels = { log: 'INFO', info: 'INFO', warn: 'WARN', error: 'ERROR', debug: 'DEBUG' };

  Object.entries(levels).forEach(([method, level]) => {
    console[method] = (...args) => {
      originalConsole[method](...args);
      try {
        const safeArgs = args.map((arg, index) => {
          if (index > 0 && /password|secret|token|authorization|cookie|credential/i.test(String(args[index - 1] || ''))) {
            return '[REDACTED]';
          }
          if (arg instanceof Error) return { name: arg.name, message: redactText(arg.message), stack: redactText(arg.stack || '') };
          return toSafeDetails(arg);
        });
        const message = safeArgs.map((arg) => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ');
        consoleLogQueue = consoleLogQueue
          .then(() => logSystem(prismaClient, {
            level,
            operation: `CONSOLE_${level}`,
            message: redactText(message || method),
            details: { arguments: safeArgs },
          }))
          .catch(() => {});
      } catch (error) {}
    };
  });
}

module.exports = { installConsoleSystemLogger, logSystem, toSafeDetails };
