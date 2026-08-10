const fs = require('fs');
const path = require('path');

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim().replace(/^"|"$/g, ''));
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim().replace(/^"|"$/g, ''));
  return result;
}

class AsteriskCdrProvider {
  constructor(config, prisma, adapter) {
    this.config = config;
    this.prisma = prisma;
    this.adapter = adapter;
  }

  async fetchLogs(filters = {}) {
    const { page = 1, limit = 10, source, destination, disposition } = filters;
    const skip = (page - 1) * limit;

    // Auto-detect priority sequence:
    // 1. Configured SQL CDR Source (skipped if none configured)
    // 2. CEL Source (skipped if none configured)
    // 3. CSV fallback via adapter from /var/log/asterisk/cdr-csv/Master.csv
    // 4. Internal Database Cache fallback

    // 1 & 2: SQL Check
    if (this.config.cdrSourceType === 'database' && this.config.cdrConnectionSettings) {
      try {
        // Simulated SQL or actual SQL query if settings exist
        const sqlLogs = await this.#querySqlCdr(this.config.cdrConnectionSettings, filters);
        return {
          success: true,
          data: sqlLogs.slice(skip, skip + limit),
          total: sqlLogs.length,
          sourceConfigured: true,
          source: 'database'
        };
      } catch (err) {
        console.warn('[CDR PROVIDER] SQL query failed, falling back to CSV/Cache:', err.message);
      }
    }

    // 3. CSV File check via provisioning adapter
    if (this.adapter && this.config.provisioningMode !== 'disabled') {
      try {
        const csvPath = '/var/log/asterisk/cdr-csv/Master.csv';
        let csvContent = '';
        if (await this.adapter.fileExists(csvPath)) {
          csvContent = await this.adapter.readFile(csvPath);
        }

        if (csvContent) {
          const parsed = this.#parseCsvCdr(csvContent, filters);
          return {
            success: true,
            data: parsed.slice(skip, skip + limit),
            total: parsed.length,
            sourceConfigured: true,
            source: 'csv_file'
          };
        }
      } catch (err) {
        console.warn('[CDR PROVIDER] CSV parser failed, falling back to database cache:', err.message);
      }
    }

    // 4. Internal Database Cache fallback
    const dbLogs = await this.prisma.asteriskCallLog.findMany({
      where: {
        ispId: this.config.ispId,
        caller: source ? { contains: source } : undefined,
        called: destination ? { contains: destination } : undefined,
        status: disposition ? { contains: disposition } : undefined
      },
      skip: parseInt(skip, 10),
      take: parseInt(limit, 10),
      orderBy: { startTime: 'desc' }
    });

    const total = await this.prisma.asteriskCallLog.count({
      where: {
        ispId: this.config.ispId,
        caller: source ? { contains: source } : undefined,
        called: destination ? { contains: destination } : undefined,
        status: disposition ? { contains: disposition } : undefined
      }
    });

    return {
      success: true,
      data: dbLogs,
      total,
      sourceConfigured: false,
      source: 'internal_cache',
      message: 'Historical call records require a configured CDR database source. Displaying local cache.'
    };
  }

  #parseCsvCdr(csvContent, filters) {
    const { source, destination, disposition } = filters;
    const lines = csvContent.split(/\r?\n/).filter(line => line.trim().length > 0);
    const results = [];

    for (let i = 0; i < lines.length; i++) {
      const parts = parseCsvLine(lines[i]);
      if (parts.length < 15) continue;

      const caller = parts[1] || '';
      const called = parts[2] || '';
      const duration = parseInt(parts[12] || '0', 10);
      const billsec = parseInt(parts[13] || '0', 10);
      const rawDisp = parts[14] || 'UNKNOWN';
      const startTimeStr = parts[9] || new Date().toISOString();

      // Normalize disposition
      let status = 'UNKNOWN';
      const normalized = rawDisp.toUpperCase();
      if (normalized.includes('ANSWERED')) status = 'ANSWERED';
      else if (normalized.includes('NO ANSWER')) status = 'NO ANSWER';
      else if (normalized.includes('BUSY')) status = 'BUSY';
      else if (normalized.includes('FAILED')) status = 'FAILED';
      else if (normalized.includes('CONGESTION')) status = 'CONGESTION';

      // Filters
      if (source && !caller.includes(source)) continue;
      if (destination && !called.includes(destination)) continue;
      if (disposition && status !== disposition.toUpperCase()) continue;

      results.push({
        id: i + 1,
        caller,
        called,
        duration,
        billsec,
        status,
        startTime: new Date(startTimeStr).toISOString(),
        endTime: parts[11] ? new Date(parts[11]).toISOString() : new Date().toISOString(),
        uniqueId: parts[16] || `csv-${i}`
      });
    }

    // Sort newest first
    return results.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
  }

  async #querySqlCdr(settings, filters) {
    // Basic stub returning an empty list. Could connect to external DB if necessary.
    return [];
  }
}

module.exports = AsteriskCdrProvider;
