import { createHash, randomUUID } from 'node:crypto';
import { arch, networkInterfaces, platform } from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
function rejectPlaceholder(value) {
    const normalized = value.replace(/[^a-f0-9]/gi, '').toLowerCase();
    if (!normalized || /^0+$/.test(normalized) || /^f+$/.test(normalized))
        throw new Error('Machine identifier is a firmware placeholder');
    return value;
}
function getMacAddress() {
    try {
        const nets = networkInterfaces();
        for (const name of Object.keys(nets)) {
            const list = nets[name];
            if (list) {
                for (const net of list) {
                    if (!net.internal && net.mac && net.mac !== '00:00:00:00:00:00') {
                        const clean = net.mac.replace(/[^a-f0-9]/gi, '').toLowerCase();
                        if (clean && !/^0+$/.test(clean) && !/^f+$/.test(clean)) {
                            return clean;
                        }
                    }
                }
            }
        }
    }
    catch { }
    return null;
}
async function machineId() {
    const os = platform();
    if (os === 'linux') {
        // 1. Check system machine-id & DMI files
        for (const path of [
            '/etc/machine-id',
            '/var/lib/dbus/machine-id',
            '/sys/class/dmi/id/product_uuid',
            '/sys/devices/virtual/dmi/id/product_uuid',
            '/sys/class/dmi/id/product_serial',
            '/sys/class/dmi/id/board_serial',
            '/proc/device-tree/serial-number',
            '/etc/hostid'
        ]) {
            try {
                const val = (await readFile(path, 'utf8')).trim();
                if (val)
                    return rejectPlaceholder(val);
            }
            catch { }
        }
    }
    if (os === 'darwin') {
        try {
            const { stdout } = await exec('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
            const match = stdout.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
            if (match?.[1])
                return rejectPlaceholder(match[1]);
        }
        catch { }
    }
    if (os === 'win32') {
        try {
            const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_ComputerSystemProduct).UUID']);
            if (stdout.trim())
                return rejectPlaceholder(stdout.trim());
        }
        catch { }
    }
    // 2. Hardware network interface MAC fallback
    const mac = getMacAddress();
    if (mac)
        return mac;
    // 3. Persistent machine-id fallback in storage directories
    const candidatePaths = [
        '/app/data/secure-license/system-machine-id',
        '/app/data/system-machine-id',
        '/var/lib/secure-license/system-machine-id',
        join(process.cwd(), 'data', 'secure-license', 'system-machine-id'),
        join(process.cwd(), 'data', 'system-machine-id'),
        join(os === 'win32' ? (process.env.TEMP || 'C:\\Windows\\Temp') : '/tmp', '.kashtrix-system-machine-id')
    ];
    for (const path of candidatePaths) {
        try {
            const val = (await readFile(path, 'utf8')).trim();
            if (val && val.length >= 8)
                return val;
        }
        catch { }
    }
    // 4. Create and persist stable installation identifier
    for (const path of candidatePaths) {
        try {
            const id = randomUUID().replace(/-/g, '');
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, id, { encoding: 'utf8', mode: 0o600 });
            return id;
        }
        catch { }
    }
    throw new Error('Unable to obtain a stable OS machine identifier');
}
function normalizeNamespace(value, label) {
    const normalized = value.trim().toLowerCase();
    if (!/^[0-9a-f-]{36}$/i.test(normalized))
        throw new Error(`${label} must be a UUID from the License Manager admin application`);
    return normalized;
}
/** Internal privacy-preserving machine fingerprint. Do not transmit this value. */
export async function generateBaseHardwareFingerprint() {
    const components = [await machineId(), platform(), arch()].map(x => x.trim().toLowerCase()).sort();
    return createHash('sha256').update(`lm-base-hwid-v2|${components.join('|')}`, 'utf8').digest('hex');
}
/**
 * Public application-scoped HWID sent to the licensing server.
 * Same hardware + different tenant/application => deliberately different HWID.
 */
export async function generateHwid(scope) {
    const tenantId = normalizeNamespace(scope.tenantId, 'tenantId');
    const applicationId = normalizeNamespace(scope.applicationId, 'applicationId');
    const base = await generateBaseHardwareFingerprint();
    return createHash('sha256').update(`lm-app-hwid-v2|${tenantId}|${applicationId}|${base}`, 'utf8').digest('hex');
}
export async function loadOrCreateClientId(filePath) {
    try {
        const current = (await readFile(filePath, 'utf8')).trim();
        if (/^[0-9a-f-]{36}$/i.test(current))
            return current;
    }
    catch { }
    const id = randomUUID();
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, id, { encoding: 'utf8', mode: 0o600 });
    return id;
}
/** Makes it hard to accidentally reuse one installation id across applications. */
export async function loadOrCreateScopedClientId(storageDir, tenantId, applicationId) {
    const namespace = createHash('sha256').update(`${normalizeNamespace(tenantId, 'tenantId')}|${normalizeNamespace(applicationId, 'applicationId')}`).digest('hex').slice(0, 24);
    return loadOrCreateClientId(join(storageDir, `license-client-${namespace}.id`));
}
