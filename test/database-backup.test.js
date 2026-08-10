const test = require('node:test');
const assert = require('node:assert/strict');
const {
    DatabaseBackupService,
    isValidEmail,
    isValidTime,
    isValidTimezone,
    localDateTime,
    databaseOptions,
    quoteIdentifier
} = require('../src/services/database-backup.service');

test('database backup schedule validates email, time, timezone, and retention', () => {
    const service = new DatabaseBackupService({ prisma: {}, mailHelper: {} });
    assert.deepEqual(service.validateConfig({
        enabled: true,
        email: 'backup@example.com',
        time: '00:00',
        timezone: 'Asia/Kathmandu',
        retentionDays: 14
    }), {
        enabled: true,
        email: 'backup@example.com',
        time: '00:00',
        timezone: 'Asia/Kathmandu',
        retentionDays: 14
    });
    assert.equal(isValidEmail('not-an-email'), false);
    assert.equal(isValidTime('24:00'), false);
    assert.equal(isValidTime('23:59'), true);
    assert.equal(isValidTimezone('Asia/Kathmandu'), true);
    assert.equal(isValidTimezone('Invalid/Timezone'), false);
    assert.throws(() => service.validateConfig({ email: 'backup@example.com', retentionDays: 0 }), /between 1 and 90/);
});

test('midnight scheduling uses the configured Nepal timezone', () => {
    assert.deepEqual(localDateTime(new Date('2026-08-03T18:15:00.000Z'), 'Asia/Kathmandu'), {
        date: '2026-08-04',
        time: '00:00'
    });
});

test('database URL parsing decodes credentials without exposing them to a process command', () => {
    assert.deepEqual(databaseOptions('mysql://backup%40user:p%40ss@db.internal:3307/oss_bss'), {
        host: 'db.internal',
        port: 3307,
        user: 'backup@user',
        password: 'p@ss',
        database: 'oss_bss',
        charset: 'utf8mb4',
        dateStrings: true,
        supportBigNumbers: true,
        bigNumberStrings: true
    });
    assert.equal(quoteIdentifier('odd`table'), '`odd``table`');
    assert.throws(() => databaseOptions('postgresql://db/test'), /MySQL or MariaDB/);
});
