const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { once } = require('events');
const { pipeline } = require('stream/promises');
const mysql = require('mysql2/promise');
const prisma = require('../../prisma/client');
const mailHelper = require('../utils/mailHelper');

const SERVICE_CODE = 'DATABASE_BACKUP';
const BACKUP_DIRECTORY = path.resolve(__dirname, '../../backups/database');
const DEFAULT_CONFIG = Object.freeze({
    enabled: false,
    email: '',
    time: '00:00',
    timezone: 'Asia/Kathmandu',
    retentionDays: 7
});

const settingKey = (name, ispId) => `databaseBackup${name}:${ispId}`;

function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function isValidTime(value) {
    return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));
}

function isValidTimezone(value) {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: String(value) }).format();
        return true;
    } catch {
        return false;
    }
}

function localDateTime(date, timezone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(date).reduce((result, part) => {
        if (part.type !== 'literal') result[part.type] = part.value;
        return result;
    }, {});
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function quoteIdentifier(identifier) {
    return `\`${String(identifier).replace(/`/g, '``')}\``;
}

function databaseOptions(databaseUrl = process.env.DATABASE_URL) {
    if (!databaseUrl) throw new Error('DATABASE_URL is not configured');
    const url = new URL(databaseUrl);
    if (!['mysql:', 'mariadb:'].includes(url.protocol)) {
        throw new Error('Scheduled database backup currently supports MySQL or MariaDB DATABASE_URL values');
    }
    const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (!database) throw new Error('DATABASE_URL does not include a database name');
    return {
        host: url.hostname,
        port: Number(url.port || 3306),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database,
        charset: 'utf8mb4',
        dateStrings: true,
        supportBigNumbers: true,
        bigNumberStrings: true
    };
}

async function writeChunk(stream, value) {
    if (!stream.write(value)) await once(stream, 'drain');
}

function assertInsideBackupDirectory(target) {
    const relative = path.relative(BACKUP_DIRECTORY, path.resolve(target));
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('Refusing to access a path outside the database backup directory');
    }
}

class DatabaseBackupService {
    constructor(dependencies = {}) {
        this.prisma = dependencies.prisma || prisma;
        this.mailHelper = dependencies.mailHelper || mailHelper;
        this.running = new Set();
        this.scheduler = null;
        this.lastScheduledDay = new Map();
    }

    async getConfig(ispId) {
        const keys = {
            enabled: settingKey('Enabled', ispId),
            email: settingKey('Email', ispId),
            time: settingKey('Time', ispId),
            timezone: settingKey('Timezone', ispId),
            retentionDays: settingKey('RetentionDays', ispId)
        };
        const [settings, lastRun] = await Promise.all([
            this.prisma.iSPSettings.findMany({ where: { ispId, key: { in: Object.values(keys) } } }),
            this.prisma.serviceLog.findFirst({
                where: { ispId, serviceCode: SERVICE_CODE },
                orderBy: { createdAt: 'desc' }
            })
        ]);
        const values = new Map(settings.map(item => [item.key, item.value]));
        return {
            enabled: values.get(keys.enabled) === 'true',
            email: values.get(keys.email) || DEFAULT_CONFIG.email,
            time: values.get(keys.time) || DEFAULT_CONFIG.time,
            timezone: values.get(keys.timezone) || DEFAULT_CONFIG.timezone,
            retentionDays: Number(values.get(keys.retentionDays) || DEFAULT_CONFIG.retentionDays),
            running: this.running.has(Number(ispId)),
            lastRun: lastRun ? {
                status: lastRun.status,
                message: lastRun.message,
                operation: lastRun.operation,
                createdAt: lastRun.createdAt,
                ...(lastRun.data && typeof lastRun.data === 'object' ? lastRun.data : {})
            } : null
        };
    }

    validateConfig(input = {}) {
        const config = {
            enabled: Boolean(input.enabled),
            email: String(input.email || '').trim(),
            time: String(input.time || DEFAULT_CONFIG.time),
            timezone: String(input.timezone || DEFAULT_CONFIG.timezone),
            retentionDays: Number(input.retentionDays ?? DEFAULT_CONFIG.retentionDays)
        };
        if (!isValidEmail(config.email)) throw new Error('A valid backup recipient email is required');
        if (!isValidTime(config.time)) throw new Error('Backup time must use 24-hour HH:mm format');
        if (!isValidTimezone(config.timezone)) throw new Error('Invalid backup timezone');
        if (!Number.isInteger(config.retentionDays) || config.retentionDays < 1 || config.retentionDays > 90) {
            throw new Error('Backup retention must be between 1 and 90 days');
        }
        return config;
    }

    async saveConfig(ispId, input) {
        const config = this.validateConfig(input);
        const values = [
            ['Enabled', String(config.enabled), 'Enable automatic full database backups'],
            ['Email', config.email, 'Database backup email recipient'],
            ['Time', config.time, 'Daily database backup time'],
            ['Timezone', config.timezone, 'Database backup schedule timezone'],
            ['RetentionDays', String(config.retentionDays), 'Local database backup retention days']
        ];
        await this.prisma.$transaction(values.map(([name, value, description]) =>
            this.prisma.iSPSettings.upsert({
                where: { key: settingKey(name, ispId) },
                update: { value, description, updatedAt: new Date() },
                create: { ispId, key: settingKey(name, ispId), value, description, updatedAt: new Date() }
            })
        ));
        return this.getConfig(ispId);
    }

    async createDump() {
        await fs.promises.mkdir(BACKUP_DIRECTORY, { recursive: true });
        const options = databaseOptions();
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const baseName = `${options.database}-${timestamp}.sql`;
        const sqlPath = path.join(BACKUP_DIRECTORY, baseName);
        const gzipPath = `${sqlPath}.gz`;
        assertInsideBackupDirectory(sqlPath);
        assertInsideBackupDirectory(gzipPath);

        const connection = await mysql.createConnection(options);
        const output = fs.createWriteStream(sqlPath, { flags: 'wx' });
        try {
            await connection.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
            await writeChunk(output, `-- Kashtrix OSS/BSS database backup\n-- Created: ${new Date().toISOString()}\n\nSET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\n\n`);
            const [objects] = await connection.query('SHOW FULL TABLES');
            // Tables must appear before views so a restore never creates a view
            // before one of its underlying tables exists.
            objects.sort((left, right) => {
                const leftView = String(Object.values(left)[1] || '').toUpperCase() === 'VIEW';
                const rightView = String(Object.values(right)[1] || '').toUpperCase() === 'VIEW';
                return Number(leftView) - Number(rightView);
            });
            for (const object of objects) {
                const values = Object.values(object);
                const tableName = String(values[0]);
                const objectType = String(values[1] || 'BASE TABLE').toUpperCase();
                const quotedTable = quoteIdentifier(tableName);
                const [createRows] = await connection.query(`SHOW CREATE ${objectType === 'VIEW' ? 'VIEW' : 'TABLE'} ${quotedTable}`);
                const createSql = createRows[0]?.['Create Table'] || createRows[0]?.['Create View'];
                if (!createSql) continue;
                await writeChunk(output, `DROP ${objectType === 'VIEW' ? 'VIEW' : 'TABLE'} IF EXISTS ${quotedTable};\n${createSql};\n\n`);
                if (objectType === 'VIEW') continue;

                const [columns] = await connection.query(`SHOW COLUMNS FROM ${quotedTable}`);
                // MySQL rejects explicit INSERT values for virtual/stored generated columns.
                const insertColumns = columns.filter(column => !/GENERATED/i.test(String(column.Extra || '')));
                if (!insertColumns.length) continue;
                const columnSql = insertColumns.map(column => quoteIdentifier(column.Field)).join(', ');
                let offset = 0;
                const pageSize = 500;
                while (true) {
                    const [rows] = await connection.query(`SELECT * FROM ${quotedTable} LIMIT ${pageSize} OFFSET ${offset}`);
                    if (!rows.length) break;
                    const rowSql = rows.map(row => `(${insertColumns.map(column => connection.escape(row[column.Field])).join(', ')})`).join(',\n');
                    await writeChunk(output, `INSERT INTO ${quotedTable} (${columnSql}) VALUES\n${rowSql};\n`);
                    offset += rows.length;
                    if (rows.length < pageSize) break;
                }
                await writeChunk(output, '\n');
            }
            await writeChunk(output, 'SET FOREIGN_KEY_CHECKS=1;\nCOMMIT;\n');
            output.end();
            await once(output, 'finish');
            await connection.commit();
            await pipeline(fs.createReadStream(sqlPath), zlib.createGzip({ level: 9 }), fs.createWriteStream(gzipPath, { flags: 'wx' }));
            await fs.promises.unlink(sqlPath);
            const stat = await fs.promises.stat(gzipPath);
            return { fileName: path.basename(gzipPath), filePath: gzipPath, sizeBytes: stat.size };
        } catch (error) {
            output.destroy();
            await connection.rollback().catch(() => {});
            await fs.promises.unlink(sqlPath).catch(() => {});
            await fs.promises.unlink(gzipPath).catch(() => {});
            throw error;
        } finally {
            await connection.end().catch(() => {});
        }
    }

    async cleanupOldBackups(retentionDays) {
        await fs.promises.mkdir(BACKUP_DIRECTORY, { recursive: true });
        const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
        const entries = await fs.promises.readdir(BACKUP_DIRECTORY, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.sql.gz')) continue;
            const target = path.join(BACKUP_DIRECTORY, entry.name);
            assertInsideBackupDirectory(target);
            const stat = await fs.promises.stat(target);
            if (stat.mtimeMs < cutoff) await fs.promises.unlink(target);
        }
    }

    async runBackup(ispId, { trigger = 'manual' } = {}) {
        const numericIspId = Number(ispId);
        if (this.running.has(numericIspId)) throw new Error('A database backup is already running');
        const config = await this.getConfig(numericIspId);
        if (!isValidEmail(config.email)) throw new Error('Configure a valid database backup email first');
        this.running.add(numericIspId);
        const started = Date.now();
        let dump;
        try {
            dump = await this.createDump();
            const result = await this.mailHelper.sendMail(numericIspId, {
                to: config.email,
                subject: `Database backup - ${new Date().toISOString().slice(0, 10)}`,
                text: `Attached is the scheduled full database backup ${dump.fileName}.`,
                attachments: [{ filename: dump.fileName, path: dump.filePath, contentType: 'application/gzip' }]
            }, { ignoreNotificationSetting: true });
            if (!result?.success) throw new Error(result?.error || 'SMTP server did not accept the database backup email');
            // Do not expose or persist the server's absolute filesystem path.
            const data = {
                fileName: dump.fileName,
                sizeBytes: dump.sizeBytes,
                recipient: config.email,
                messageId: result.messageId,
                startedAt: new Date(started).toISOString(),
                finishedAt: new Date().toISOString()
            };
            await this.prisma.serviceLog.create({ data: {
                ispId: numericIspId, serviceCode: SERVICE_CODE, operation: trigger,
                status: 'success', message: `Database backup emailed to ${config.email}`,
                data, duration: Date.now() - started
            } });
            await this.cleanupOldBackups(config.retentionDays);
            return data;
        } catch (error) {
            await this.prisma.serviceLog.create({ data: {
                ispId: numericIspId, serviceCode: SERVICE_CODE, operation: trigger,
                status: 'failed', message: error.message,
                data: {
                    recipient: config.email,
                    fileName: dump?.fileName,
                    startedAt: new Date(started).toISOString(),
                    finishedAt: new Date().toISOString()
                },
                duration: Date.now() - started
            } }).catch(logError => console.error('[Database Backup] Failed to record failure:', logError.message));
            throw error;
        } finally {
            this.running.delete(numericIspId);
        }
    }

    async schedulerTick(now = new Date()) {
        const enabled = await this.prisma.iSPSettings.findMany({
            where: { key: { startsWith: 'databaseBackupEnabled:' }, value: 'true' },
            select: { ispId: true }
        });
        for (const { ispId } of enabled) {
            try {
                const config = await this.getConfig(ispId);
                const local = localDateTime(now, config.timezone);
                const dayKey = `${ispId}:${local.date}`;
                if (local.time < config.time || this.lastScheduledDay.get(ispId) === dayKey || this.running.has(ispId)) continue;
                const latest = await this.prisma.serviceLog.findFirst({
                    where: { ispId, serviceCode: SERVICE_CODE, operation: 'scheduled' },
                    orderBy: { createdAt: 'desc' }, select: { createdAt: true }
                });
                if (latest && localDateTime(latest.createdAt, config.timezone).date === local.date) {
                    this.lastScheduledDay.set(ispId, dayKey);
                    continue;
                }
                this.lastScheduledDay.set(ispId, dayKey);
                this.runBackup(ispId, { trigger: 'scheduled' })
                    .catch(error => console.error(`[Database Backup] Scheduled backup failed for ISP ${ispId}:`, error.message));
            } catch (error) {
                console.error(`[Database Backup] Schedule check failed for ISP ${ispId}:`, error.message);
            }
        }
    }

    startScheduler() {
        if (this.scheduler) return;
        this.schedulerTick().catch(error => console.error('[Database Backup] Initial schedule check failed:', error.message));
        this.scheduler = setInterval(() => {
            this.schedulerTick().catch(error => console.error('[Database Backup] Schedule check failed:', error.message));
        }, 60 * 1000);
        this.scheduler.unref();
        console.log('[Database Backup] Daily scheduler started');
    }

    stopScheduler() {
        if (this.scheduler) clearInterval(this.scheduler);
        this.scheduler = null;
    }
}

const databaseBackupService = new DatabaseBackupService();
module.exports = databaseBackupService;
module.exports.DatabaseBackupService = DatabaseBackupService;
module.exports.isValidEmail = isValidEmail;
module.exports.isValidTime = isValidTime;
module.exports.isValidTimezone = isValidTimezone;
module.exports.localDateTime = localDateTime;
module.exports.databaseOptions = databaseOptions;
module.exports.quoteIdentifier = quoteIdentifier;
