const SSHSession = require('../../core/ssh/SSHSession');
const TelnetSession = require('../../core/telnet/TelnetSession');
const prisma = require('../../../prisma/client');
const { normalizeMac } = require('../../utils/macAddress');

class BdcomOLTDriver {
    constructor(device) {
        this.device = device;
        this.ssh = null;
    }

    async connect() {
        if (!this.device.sshHost) throw new Error("Missing Device Host");

        const transport = (this.device.defaultTransport || 'ssh').toLowerCase();
        console.log("Connecting as Transport ... ", transport);

        const SessionClass = transport === 'telnet' ? TelnetSession : SSHSession;

        let port;
        if (transport === 'telnet') {
            port = this.device.telnetPort || 23;
        } else {
            port = this.device.sshPort || 22;
        }

        console.log(`Using ${transport} port: ${port}`);

        this.ssh = new SessionClass({
            host: this.device.sshHost,
            port,
            username: this.device.sshUsername,
            password: this.device.sshPassword,
            enablePassword: this.device.sshEnablePassword,
            promptRegex: /([>#])\s?$/
        });

        await this.ssh.connect();
    }

    async serviceBoardType(slot = 0) {
        const serviceBoard = await prisma.serviceBoard.findFirst({
            where: { oltId: this.device.id, slot },
        });

        if (!serviceBoard) {
            return 'epon';
        }

        return String(serviceBoard.type || 'epon').toLowerCase();
    }

    async runSession(callback) {
        if (!this.ssh) throw new Error("SSH not connected");

        return this.ssh.runShellSession(async (send) => {
            await send('enable').catch(() => { });
            await send('terminal length 0').catch(() => { });
            await send('config').catch(() => { });

            try {
                return await callback(send);
            } finally {
                await send('end').catch(() => { });
            }
        });
    }

    // --- MAC to F/S/P LOOKUP ---

    /**
     * Convert any MAC address format to BDCOM format: xxxx.xxxx.xxxx
     */
    static normalizeMAC(mac) {
        return normalizeMac(mac, 'dotted');
    }

    /**
     * Find interface/port from a MAC address on this OLT.
     * Runs: show mac address-table | include <mac>
     * Returns array of matches
     */
    async findFSPByMac(mac) {
        const bdcomMac = BdcomOLTDriver.normalizeMAC(mac);

        return this.runSession(async (send) => {
            const raw = await send(`show mac address-table | include ${bdcomMac}`);
            return this.parseMacAddressTable(raw, bdcomMac);
        });
    }

    /**
     * Parse BDCOM MAC address table output.
     * BDCOM format varies but commonly:
     * VLAN    MAC Address       Type      Ports
     * ----    -----------       ----      -----
     * 100     0011.2233.4455    DYNAMIC   EPON0/1:2
     */
    parseMacAddressTable(text, filterMac = null) {
        const results = [];
        const lines = text
            .replace(/\r/g, '')
            .split('\n')
            .filter(l => l.trim() && !l.includes('---') && !l.includes('VLAN') && !l.includes('Mac Address'));

        for (const line of lines) {
            // Match: VLAN  MAC  Type  Port
            const m = line.match(
                /^\s*(\d+)\s+([0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4})\s+(\w+)\s+(\S+)/
            );
            if (!m) continue;

            const macAddr = m[2].toLowerCase();
            if (filterMac && macAddr !== filterMac.toLowerCase()) continue;

            const portStr = m[4];
            // Parse EPON0/1:2 or GE0/1 style port identifiers
            let frame = 0, slot = 0, port = 0, ontId = null;
            const eponMatch = portStr.match(/(?:EPON|GPON)(\d+)\/(\d+)(?::(\d+))?/i);
            const geMatch = portStr.match(/(?:GE|XGE)(\d+)\/(\d+)/i);

            if (eponMatch) {
                frame = parseInt(eponMatch[1]);
                slot = 0;
                port = parseInt(eponMatch[2]);
                ontId = eponMatch[3] ? parseInt(eponMatch[3]) : null;
            } else if (geMatch) {
                frame = parseInt(geMatch[1]);
                port = parseInt(geMatch[2]);
            }

            results.push({
                originalMac: filterMac || macAddr,
                normalizedMac: macAddr,
                macAddress: macAddr,
                vlan: parseInt(m[1]),
                macType: m[3],
                interface: portStr,
                interfaceType: portStr.replace(/[0-9/:].*$/, ''),
                frame,
                slot,
                port,
                ontId,
                fsp: `${frame}/${slot}/${port}`,
                rawMatchedLine: line.trim(),
                lookupTimestamp: new Date().toISOString()
            });
        }

        return results;
    }

    // --- HIGH LEVEL ACTIONS ---

    async getOntInfoWithOptical() {
        return this.runSession(async (send) => {
            const serviceBoardType = await this.serviceBoardType();

            if (serviceBoardType !== 'epon') {
                throw new Error('This parser currently supports BDCOM EPON only');
            }

            const rawInfo = await send(`show ${serviceBoardType} onu-information detail`);
            const rawActive = await send(`show ${serviceBoardType} active-onu`);
            const rawInactive = await send(`show ${serviceBoardType} inactive-onu`);

            console.log('RAW ONU OUTPUT:', rawInfo);
            console.log('RAW ACTIVE OUTPUT:', rawActive);
            console.log('RAW INACTIVE OUTPUT:', rawInactive);

            const onuList = this.parseOntTable(rawInfo);
            const activeMap = this.parseActiveOnu(rawActive);
            const inactiveMap = this.parseInactiveOnu(rawInactive);

            const interfaces = [...new Set(onuList.map(o => o.interface).filter(Boolean))];
            const opticalMap = {};
            const onuCtcOpticalMap = {};

            for (const intf of interfaces) {
                const match = intf.match(/^EPON(\d+)\/(\d+)$/i);
                if (!match) continue;

                const frame = match[1];
                const port = match[2];

                try {
                    const rawOptical = await send(`show ${serviceBoardType} optical-transceiver-diagnosis interface epon ${frame}/${port}`);
                    opticalMap[intf.toUpperCase()] = this.parseOpticalPort(rawOptical);
                } catch (e) {
                    console.log(`Optical fetch failed for ${intf}:`, e.message);
                    opticalMap[intf.toUpperCase()] = {
                        olt: {
                            interface: intf.toUpperCase(),
                            temperature: null,
                            voltage: null,
                            current: null,
                            tx_power: null
                        },
                        onus: {}
                    };
                }

                try {
                    const rawOnuCtcOptical = await send(`show ${serviceBoardType} onu-ctc-optical-transceiver-diagnosis interface epon ${frame}/${port}`);
                    onuCtcOpticalMap[intf.toUpperCase()] = this.parseOnuCtcOpticalPort(rawOnuCtcOptical);
                } catch (e) {
                    console.log(`ONU CTC optical fetch failed for ${intf}:`, e.message);
                    onuCtcOpticalMap[intf.toUpperCase()] = {};
                }
            }

            return onuList.map((onu) => {
                const key = (onu.full_name || '').toUpperCase();
                const intf = (onu.interface || '').toUpperCase();

                const active = activeMap[key] || null;
                const inactive = inactiveMap[key] || null;
                const optical = opticalMap[intf] || { olt: {}, onus: {} };
                const onuOptical = optical.onus[key] || {};
                const onuCtcOptical = (onuCtcOpticalMap[intf] || {})[key] || {};

                let run_state = 'unknown';
                if ((onu.status || '').toLowerCase() === 'auto-configured') {
                    run_state = 'online';
                } else if (['deregistered', 'lost'].includes((onu.status || '').toLowerCase())) {
                    run_state = 'offline';
                }

                return {
                    ...onu,
                    control_flag: onu.bind_type ? 'active' : 'inactive',
                    run_state,
                    config_state: run_state === 'online' ? 'normal' : 'initial',
                    match_state: run_state === 'online' ? 'match' : 'initial',
                    protect_side: 'no',

                    oam_status: active?.oam_status || null,
                    distance: active?.distance ?? null,
                    rtt: active?.rtt ?? null,
                    alive_time: active?.alive_time || null,
                    absent_time: inactive?.absent_time || null,

                    last_reg_time: active?.last_reg_time || inactive?.last_reg_time || null,
                    last_dereg_time: active?.last_dereg_time || inactive?.last_dereg_time || null,
                    last_dereg_reason: active?.last_dereg_reason || inactive?.last_dereg_reason || onu.dereg_reason || null,

                    offline_reason: run_state === 'offline'
                        ? (active?.last_dereg_reason || inactive?.last_dereg_reason || onu.dereg_reason || null)
                        : null,

                    rx_power: onuCtcOptical.rx_power ?? onuOptical.rx_power ?? null,
                    tx_power: onuCtcOptical.tx_power ?? null,
                    temperature: onuCtcOptical.temperature ?? null,
                    voltage: onuCtcOptical.voltage ?? null,
                    current: onuCtcOptical.current ?? null,

                    olt_temperature: optical.olt?.temperature ?? null,
                    olt_voltage: optical.olt?.voltage ?? null,
                    olt_current: optical.olt?.current ?? null,
                    olt_tx_power: optical.olt?.tx_power ?? null,

                    optical_diagnostics: {
                        rx_power: onuCtcOptical.rx_power ?? onuOptical.rx_power ?? null,
                        tx_power: onuCtcOptical.tx_power ?? null,
                        temperature: onuCtcOptical.temperature ?? null,
                        voltage: onuCtcOptical.voltage ?? null,
                        current: onuCtcOptical.current ?? null,
                        olt_temperature: optical.olt?.temperature ?? null,
                        olt_voltage: optical.olt?.voltage ?? null,
                        olt_current: optical.olt?.current ?? null,
                        olt_tx_power: optical.olt?.tx_power ?? null
                    }
                };
            });
        });
    }

    async getOntInfoBySN(serial) {
        return this.runSession(async (send) => {
            const serviceBoardType = await this.serviceBoardType();

            if (serviceBoardType !== 'epon') {
                throw new Error('This parser currently supports BDCOM EPON only');
            }

            const normalizedSerial = String(serial || '').trim().toLowerCase();

            const rawInfo = await send(`show ${serviceBoardType} onu-information detail`);
            const rawActive = await send(`show ${serviceBoardType} active-onu`);
            const rawInactive = await send(`show ${serviceBoardType} inactive-onu`);

            const onuList = this.parseOntTable(rawInfo);
            const activeMap = this.parseActiveOnu(rawActive);
            const inactiveMap = this.parseInactiveOnu(rawInactive);

            const onu = onuList.find(item =>
                (item.sn || '').toLowerCase() === normalizedSerial ||
                (item.mac_address || '').toLowerCase() === normalizedSerial
            );

            if (!onu) return null;

            let optical = {
                olt: {
                    interface: onu.interface,
                    temperature: null,
                    voltage: null,
                    current: null,
                    tx_power: null
                },
                onus: {}
            };

            let onuCtcOpticalMap = {};

            const match = (onu.interface || '').match(/^EPON(\d+)\/(\d+)$/i);
            if (match) {
                const frame = match[1];
                const port = match[2];

                try {
                    const rawOptical = await send(`show ${serviceBoardType} optical-transceiver-diagnosis interface epon ${frame}/${port}`);
                    optical = this.parseOpticalPort(rawOptical);
                } catch (e) {
                    console.log('Error getting optical info:', e.message);
                }

                try {
                    const rawOnuCtcOptical = await send(`show ${serviceBoardType} onu-ctc-optical-transceiver-diagnosis interface epon ${frame}/${port}`);
                    onuCtcOpticalMap = this.parseOnuCtcOpticalPort(rawOnuCtcOptical);
                } catch (e) {
                    console.log('Error getting ONU CTC optical info:', e.message);
                }
            }

            const active = activeMap[(onu.full_name || '').toUpperCase()] || null;
            const inactive = inactiveMap[(onu.full_name || '').toUpperCase()] || null;
            const onuOptical = optical.onus[(onu.full_name || '').toUpperCase()] || {};
            const onuCtcOptical = onuCtcOpticalMap[(onu.full_name || '').toUpperCase()] || {};

            let run_state = 'unknown';
            if ((onu.status || '').toLowerCase() === 'auto-configured') {
                run_state = 'online';
            } else if (['deregistered', 'lost'].includes((onu.status || '').toLowerCase())) {
                run_state = 'offline';
            }

            return {
                ...onu,
                control_flag: onu.bind_type ? 'active' : 'inactive',
                run_state,
                config_state: run_state === 'online' ? 'normal' : 'initial',
                match_state: run_state === 'online' ? 'match' : 'initial',
                protect_side: 'no',

                oam_status: active?.oam_status || null,
                distance: active?.distance ?? null,
                rtt: active?.rtt ?? null,
                alive_time: active?.alive_time || null,
                absent_time: inactive?.absent_time || null,

                last_reg_time: active?.last_reg_time || inactive?.last_reg_time || null,
                last_dereg_time: active?.last_dereg_time || inactive?.last_dereg_time || null,
                last_dereg_reason: active?.last_dereg_reason || inactive?.last_dereg_reason || onu.dereg_reason || null,

                offline_reason: run_state === 'offline'
                    ? (active?.last_dereg_reason || inactive?.last_dereg_reason || onu.dereg_reason || null)
                    : null,

                rx_power: onuCtcOptical.rx_power ?? onuOptical.rx_power ?? null,
                tx_power: onuCtcOptical.tx_power ?? null,
                temperature: onuCtcOptical.temperature ?? null,
                voltage: onuCtcOptical.voltage ?? null,
                current: onuCtcOptical.current ?? null,

                olt_temperature: optical.olt?.temperature ?? null,
                olt_voltage: optical.olt?.voltage ?? null,
                olt_current: optical.olt?.current ?? null,
                olt_tx_power: optical.olt?.tx_power ?? null,

                service_ports: [],
                optical_diagnostics: {
                    rx_power: onuCtcOptical.rx_power ?? onuOptical.rx_power ?? null,
                    tx_power: onuCtcOptical.tx_power ?? null,
                    temperature: onuCtcOptical.temperature ?? null,
                    voltage: onuCtcOptical.voltage ?? null,
                    current: onuCtcOptical.current ?? null,
                    olt_temperature: optical.olt?.temperature ?? null,
                    olt_voltage: optical.olt?.voltage ?? null,
                    olt_current: optical.olt?.current ?? null,
                    olt_tx_power: optical.olt?.tx_power ?? null
                }
            };
        });
    }

    async autofindall(slot) {
        return this.runSession(async (send) => {
            const serviceBoardType = await this.serviceBoardType(slot);
            const raw = await send(`show ${serviceBoardType} rejected-onu`);
            console.log("Raw Rejected ONT", raw);
            return this.parseRejectONT(raw);
        });
    }

    async autofind(frame, slot, port) {
        return this.runSession(async (send) => {
            const serviceBoardType = await this.serviceBoardType();
            const raw = await send(`show ${serviceBoardType} rejected-onu interface ${serviceBoardType} ${slot}/${port}`);
            return this.parseRejectONT(raw);
        });
    }

    async registerONT(data) {
        const { slot, port, serial } = data;

        const serviceBoardType = await this.serviceBoardType();
        const registerParam = serviceBoardType === 'epon' ? 'mac' : 'sn';

        return this.runSession(async (send) => {
            const results = { ont_registration: {} };

            await send(`interface ${serviceBoardType} ${slot}/${port}`);
            const ontCommand = `${serviceBoardType} bind-onu ${registerParam} ${serial}`;

            console.log("Registation Param CLI", ontCommand);
            results.ont_registration.result = (await send(ontCommand)).trim();
            await send('quit');

            return results;
        });
    }

    async deleteOnt(data) {
        const { slot, port, serial } = data;

        return this.runSession(async (send) => {
            const processLogs = { ont_deletion: "" };
            const serviceBoardType = await this.serviceBoardType();

            await send(`interface ${serviceBoardType} ${slot}/${port}`);
            const deleteOutput = await send(`no ${serviceBoardType} bind-onu mac ${serial}`);
            processLogs.ont_deletion = deleteOutput.trim();

            await send('quit');

            return processLogs;
        });
    }

    async executeCommand(command) {
        return this.runSession(async (send) => {
            const output = await send(command);
            return output.trim();
        });
    }

    // --- HELPERS ---

    _normalizeOutput(text) {
        return String(text || '')
            .replace(/\r/g, '')
            .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
            .replace(/[^\x20-\x7E\n]/g, '');
    }

    _mergeWrappedRows(text, rowStartRegex) {
        const lines = this._normalizeOutput(text).split('\n');
        const merged = [];
        let current = '';

        for (const rawLine of lines) {
            const line = rawLine.trimRight();
            if (!line) continue;

            if (
                line.startsWith('Interface ') ||
                line.includes('IntfName') ||
                line.includes('--------') ||
                line.startsWith('Bind Flag:') ||
                line.startsWith('lS -') ||
                line.startsWith('fS -') ||
                line.startsWith('HO-')
            ) {
                if (current) {
                    merged.push(current.trim());
                    current = '';
                }
                merged.push(line);
                continue;
            }

            if (rowStartRegex.test(line.trim())) {
                if (current) {
                    merged.push(current.trim());
                }
                current = line.trim();
            } else {
                if (current) {
                    current += ' ' + line.trim();
                } else {
                    merged.push(line.trim());
                }
            }
        }

        if (current) {
            merged.push(current.trim());
        }

        return merged;
    }

    _convertInterfaceToFSP(interfaceStr) {
        if (!interfaceStr) return interfaceStr;
        const match = interfaceStr.match(/EPON(\d+)\/(\d+)/i);
        if (match) {
            const frame = match[1];
            const slot = match[2];
            return `${frame}/${slot}/0`;
        }
        return interfaceStr;
    }

    _toInt(value) {
        const n = parseInt(value, 10);
        return isNaN(n) ? null : n;
    }

    _toFloat(value) {
        const n = parseFloat(value);
        return isNaN(n) ? null : n;
    }

    // --- PARSERS ---

    parseOntTable(text) {
        const onuList = [];
        const lines = this._mergeWrappedRows(text, /^EPON\d+\/\d+:\d+/i);

        for (const line of lines) {
            if (!line) continue;

            if (
                line.startsWith('Interface ') ||
                line.includes('IntfName') ||
                line.includes('--------') ||
                line.startsWith('Bind Flag:')
            ) {
                continue;
            }

            if (!/^EPON\d+\/\d+:\d+/i.test(line)) continue;

            const match = line.match(
                /^(EPON\d+\/\d+:\d+)\s+(\S+)\s+(\S+)\s+([0-9a-fA-F.]+)\s+(\S+)\s+(.+?)\s+(static\(\w+\)|dynamic\(\w+\)|static|dynamic)\s+(auto-configured|deregistered|lost)\s+(\S+.*)$/i
            );

            if (!match) {
                console.log('Skipping unparsable ONU row:', line);
                continue;
            }

            const full_name = match[1].toUpperCase();
            const vendor_id = match[2];
            const model_id = match[3];
            const mac_address = match[4].toLowerCase();
            const loid = match[5] === 'N/A' ? null : match[5];
            const description = match[6] === 'N/A' ? null : match[6];
            const bind_type = match[7];
            const status = match[8];
            const dereg_reason = match[9] === 'N/A' ? null : match[9];

            const [interfaceName, ontIdStr] = full_name.split(':');

            onuList.push({
                fsp: this._convertInterfaceToFSP(interfaceName),
                interface: interfaceName.toUpperCase(),
                full_name,
                ont_id: parseInt(ontIdStr, 10),
                sn: mac_address,
                mac_address,
                vendor_id,
                model_id,
                loid,
                description,
                bind_type,
                bind_details: this.parseBindType(bind_type),
                status,
                dereg_reason
            });
        }

        console.log('PARSED ONU COUNT:', onuList.length);
        return onuList;
    }

    parseActiveOnu(text) {
        const result = {};
        const lines = this._mergeWrappedRows(text, /^EPON\d+\/\d+:\d+/i);

        for (const line of lines) {
            if (!line) continue;

            if (
                line.startsWith('Interface ') ||
                line.includes('IntfName') ||
                line.includes('--------')
            ) {
                continue;
            }

            if (!/^EPON\d+\/\d+:\d+/i.test(line)) continue;

            const match = line.match(
                /^(EPON\d+\/\d+:\d+)\s+([0-9a-fA-F.]+)\s+(auto-configured|deregistered|lost)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+(\S+)\s+(\S+)$/i
            );

            if (!match) {
                console.log('Skipping unparsable ACTIVE row:', line);
                continue;
            }

            result[match[1].toUpperCase()] = {
                full_name: match[1].toUpperCase(),
                mac_address: match[2].toLowerCase(),
                status: match[3],
                oam_status: match[4],
                distance: parseInt(match[5], 10),
                rtt: parseInt(match[6], 10),
                last_reg_time: match[7],
                last_dereg_time: match[8],
                last_dereg_reason: match[9],
                alive_time: match[10]
            };
        }

        return result;
    }

    parseInactiveOnu(text) {
        const result = {};
        const lines = this._mergeWrappedRows(text, /^EPON\d+\/\d+:\d+/i);

        for (const line of lines) {
            if (!line) continue;

            if (
                line.startsWith('Interface ') ||
                line.includes('IntfName') ||
                line.includes('--------')
            ) {
                continue;
            }

            if (!/^EPON\d+\/\d+:\d+/i.test(line)) continue;

            const match = line.match(
                /^(EPON\d+\/\d+:\d+)\s+([0-9a-fA-F.]+)\s+(deregistered|lost)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+(\S+)\s+(\S+)$/i
            );

            if (!match) {
                console.log('Skipping unparsable INACTIVE row:', line);
                continue;
            }

            result[match[1].toUpperCase()] = {
                full_name: match[1].toUpperCase(),
                mac_address: match[2].toLowerCase(),
                status: match[3],
                last_reg_time: match[4],
                last_dereg_time: match[5],
                last_dereg_reason: match[6],
                absent_time: match[7]
            };
        }

        return result;
    }

    parseOpticalPort(text) {
        const result = {
            olt: {
                interface: null,
                temperature: null,
                voltage: null,
                current: null,
                tx_power: null
            },
            onus: {}
        };

        const lines = this._normalizeOutput(text).split('\n');

        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line) continue;
            if (line.includes('Temperature(degree)')) continue;
            if (line.includes('RxPower(dBm)')) continue;
            if (line.includes('-----------')) continue;

            let m = line.match(/^epon(\d+\/\d+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)$/i);
            if (m) {
                result.olt = {
                    interface: `EPON${m[1]}`.toUpperCase(),
                    temperature: this._toFloat(m[2]),
                    voltage: this._toFloat(m[3]),
                    current: this._toFloat(m[4]),
                    tx_power: this._toFloat(m[5])
                };
                continue;
            }

            m = line.match(/^epon(\d+\/\d+:\d+)\s+([-\d.]+)$/i);
            if (m) {
                result.onus[`EPON${m[1]}`.toUpperCase()] = {
                    rx_power: this._toFloat(m[2])
                };
            }
        }

        return result;
    }

    parseOnuCtcOpticalPort(text) {
        const result = {};
        const lines = this._normalizeOutput(text).split('\n');

        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line) continue;
            if (line.includes('IntfName')) continue;
            if (line.includes('Temp(degree)')) continue;
            if (line.includes('------------')) continue;

            const match = line.match(
                /^epon(\d+\/\d+:\d+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)$/i
            );

            if (!match) continue;

            result[`EPON${match[1]}`.toUpperCase()] = {
                temperature: this._toFloat(match[2]),
                voltage: this._toFloat(match[3]),
                current: this._toFloat(match[4]), // Bias current
                tx_power: this._toFloat(match[5]),
                rx_power: this._toFloat(match[6])
            };
        }

        return result;
    }

    parseRejectONT(text) {
        const rejectedONUs = [];
        const lines = this._normalizeOutput(text).split('\n');
        let currentInterface = null;

        for (const line of lines) {
            const trimmedLine = line.trim();

            const interfaceMatch = trimmedLine.match(/ONU rejected to register on interface (EPON\d+\/\d+):/);
            if (interfaceMatch) {
                currentInterface = interfaceMatch[1];
                continue;
            }

            if (trimmedLine.includes('INDEX') || trimmedLine.includes('-----') || !trimmedLine) {
                continue;
            }

            const parts = trimmedLine.split(/\s+/).filter(p => p.length > 0);

            if (parts.length >= 6 && /^\d+$/.test(parts[0])) {
                rejectedONUs.push({
                    interface: currentInterface,
                    index: parseInt(parts[0], 10),
                    ont_id_details: parts[1],
                    discovered_at: `${parts[2]} ${parts[3]}`,
                    loid: parts[4] === '(N/A)' ? null : parts[4],
                    password: parts[5] === '(N/A)' ? null : parts[5]
                });
            }
        }

        return rejectedONUs;
    }

    parseOntInfoByMAC(text, macAddress) {
        const all = this.parseOntTable(text);
        const normalized = String(macAddress || '').toLowerCase();
        return all.find(item => (item.mac_address || '').toLowerCase() === normalized) || null;
    }

    parseBindType(bindType) {
        const result = {
            type: 'unknown',
            method: 'unknown',
            is_static: false,
            is_dynamic: false,
            raw: bindType
        };

        if (!bindType || bindType === 'N/A') {
            return result;
        }

        if (bindType.includes('static')) {
            result.is_static = true;
            result.type = 'static';
        } else if (bindType.includes('dynamic')) {
            result.is_dynamic = true;
            result.type = 'dynamic';
        }

        if (bindType.includes('(mS)')) {
            result.method = 'mac-address';
            result.is_static = true;
            result.bind_flag = 'mS';
        } else if (bindType.includes('(mD)')) {
            result.method = 'mac-address';
            result.is_dynamic = true;
            result.bind_flag = 'mD';
        } else if (bindType.includes('(lS)')) {
            result.method = 'loid';
            result.is_static = true;
            result.bind_flag = 'lS';
        } else if (bindType.includes('(lD)')) {
            result.method = 'loid';
            result.is_dynamic = true;
            result.bind_flag = 'lD';
        } else if (bindType.includes('(fS)')) {
            result.method = 'force';
            result.is_static = true;
            result.bind_flag = 'fS';
        }

        return result;
    }

    parseOpticalInfo(text) {
        const optical = {
            rx_power: "N/A",
            tx_power: "N/A",
            temperature: "N/A",
            voltage: "N/A",
            current: "N/A"
        };

        const lines = this._normalizeOutput(text).split('\n');
        for (const line of lines) {
            const rxMatch = line.match(/Rx optical power\(dBm\)\s*:\s*([-\d.]+)/i);
            if (rxMatch) optical.rx_power = `${rxMatch[1]} dBm`;

            const txMatch = line.match(/Tx optical power\(dBm\)\s*:\s*([-\d.]+)/i);
            if (txMatch) optical.tx_power = `${txMatch[1]} dBm`;

            const tempMatch = line.match(/Temperature\(C\)\s*:\s*([-\d.]+)/i);
            if (tempMatch) optical.temperature = `${tempMatch[1]} C`;

            const voltMatch = line.match(/Voltage\(V\)\s*:\s*([-\d.]+)/i);
            if (voltMatch) optical.voltage = `${voltMatch[1]} V`;

            const currMatch = line.match(/Laser bias current\(mA\)\s*:\s*([-\d.]+)/i);
            if (currMatch) optical.current = `${currMatch[1]} mA`;
        }

        return optical;
    }

    parseServicePortByOnt(text) {
        const results = [];
        const lines = this._normalizeOutput(text).replace(/---- More.*?\n/g, '').split('\n');

        for (const line of lines) {
            const trimmed = line.trim();
            if (/^\s*\d+\s+\d+/.test(trimmed)) {
                const parts = trimmed.split(/\s+/);
                if (parts.length >= 8) {
                    results.push({
                        index: parseInt(parts[0], 10) || null,
                        vlan: parseInt(parts[1], 10) || null,
                        vlan_attr: parts[2] || 'N/A',
                        port_type: parts[3] || 'N/A',
                        fsp: parts[4]?.replace(/\s+/g, '') || 'N/A',
                        ont_id: parseInt(parts[5], 10) || null,
                        gem_index: parseInt(parts[6], 10) || null,
                        flow_type: parts[7] || 'N/A',
                        flow_para: parts[8] || 'N/A',
                        rx: parts[9] || 'N/A',
                        tx: parts[10] || 'N/A',
                        state: parts[11]?.toLowerCase() || 'unknown'
                    });
                }
            }
        }

        return results;
    }

    parseServicePortTable(text) {
        const results = [];
        const clean = this._normalizeOutput(text)
            .replace(/---- More.*?\n/g, '')
            .split('\n')
            .filter(l => /^\s*\d+\s+\d+/.test(l));

        const regex = /^\s*(\d+)\s+(\d+)\s+(\w+)\s+(\w+)\s+(\d+\/\d+\s*\/\d+)\s+(\d+)\s+(\d+)\s+(\w+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(up|down)/i;

        for (const line of clean) {
            const m = line.match(regex);
            if (!m) continue;

            results.push({
                index: Number(m[1]),
                vlan: Number(m[2]),
                vlan_attr: m[3],
                port_type: m[4],
                fsp: m[5].replace(/\s+/g, ''),
                ont_id: Number(m[6]),
                gemport: Number(m[7]),
                flow_type: m[8],
                flow_para: m[9],
                rx: m[10],
                tx: m[11],
                state: m[12].toLowerCase()
            });
        }

        return results;
    }

    parseExtendedInfo(text) {
        const results = {};
        const blocks = this._normalizeOutput(text).split(/-----------------------------------------------------------------------------/);
        let currentFSP = "";

        blocks.forEach(block => {
            const fspHeader = block.match(/In port\s+(\d+\/\s*\d+\/\d+)/);
            if (fspHeader) currentFSP = fspHeader[1].replace(/\s+/g, '');

            const idMatch = block.match(/ONT-ID\s+:\s+(\d+)/);
            if (idMatch) {
                const id = idMatch[1];
                const internalFsp = block.match(/F\/S\/P\s+:\s+(\d+\/\d+\/\d+)/);
                const fsp = internalFsp ? internalFsp[1] : currentFSP;

                results[`${fsp}-${id}`] = {
                    last_down_cause: this.extractValue(block, "Last down cause"),
                    last_up_time: this.extractValue(block, "Last up time"),
                    last_down_time: this.extractValue(block, "Last down time"),
                    ont_online_duration: this.extractValue(block, "ONT online duration"),
                    line_profile_id: this.extractValue(block, "Line profile ID"),
                    service_profile_id: this.extractValue(block, "Service profile ID")
                };
            }
        });

        return results;
    }

    parseAutofind(text) {
        const entries = this._normalizeOutput(text).split(/----------------------------------------------------------------------------/);
        const results = [];

        entries.forEach(entry => {
            const fspMatch = entry.match(/F\/S\/P\s+:\s+(\d+\/\d+\/\d+)/);
            const snMatch = entry.match(/Ont SN\s+:\s+([A-Z0-9]+)/);
            const timeMatch = entry.match(/Ont autofind time\s+:\s+(.+)/);

            if (fspMatch && snMatch) {
                results.push({
                    service_port: fspMatch[1],
                    ont_id_details: snMatch[1],
                    discovered_at: timeMatch ? timeMatch[1].trim() : 'Unknown'
                });
            }
        });

        return results;
    }

    parseOntInfoBySN(text) {
        const kv = (key) => this.extractValue(text, key);
        const ont = {
            fsp: kv("F/S/P"),
            ont_id: kv("ONT-ID"),
            sn: kv("SN")?.split(' ')[0],
            description: kv("Description"),
            control_flag: kv("Control flag"),
            run_state: kv("Run state"),
            config_state: kv("Config state"),
            match_state: kv("Match state"),
            isolation_state: kv("Isolation state"),
            distance: kv("ONT distance(m)"),
            battery_state: kv("ONT battery state"),
            last_up_time: kv("Last up time"),
            last_down_time: kv("Last down time"),
            last_down_cause: kv("Last down cause"),
            last_dying_gasp_time: kv("Last dying gasp time"),
            online_duration: kv("ONT online duration"),
            system_uptime: kv("ONT system up duration"),
            line_profile_id: kv("Line profile ID"),
            line_profile_name: kv("Line profile name"),
            service_profile_id: kv("Service profile ID"),
            service_profile_name: kv("Service profile name"),
            mapping_mode: kv("Mapping mode"),
            qos_mode: kv("Qos mode"),
            tr069: kv("TR069 management"),
            tconts: [],
            gems: [],
            vlan_translations: []
        };

        const tcontRegex = /<T-CONT\s+(\d+)>\s+DBA Profile-ID:(\d+)/g;
        let tMatch;
        while ((tMatch = tcontRegex.exec(text)) !== null) {
            ont.tconts.push({ id: tMatch[1], dba_profile: tMatch[2] });
        }

        const gemBlockRegex = /<Gem Index\s+(\d+)>([\s\S]*?)(?=<Gem Index|Service profile ID|$)/g;
        let gMatch;
        while ((gMatch = gemBlockRegex.exec(text)) !== null) {
            const gemIndex = gMatch[1];
            const vlanRowRegex = /^\s*\d+\s+(\d+)\s+-/gm;
            let vlanMatch;
            while ((vlanMatch = vlanRowRegex.exec(gMatch[2])) !== null) {
                ont.gems.push({ gem_index: gemIndex, vlan: vlanMatch[1] });
            }
        }

        const transRegex = /ETH\s+(\d+)\s+Translation\s+(\d+)\s+(\d+)\s+-\s+(\d+)/g;
        let trMatch;
        while ((trMatch = transRegex.exec(text)) !== null) {
            ont.vlan_translations.push({
                port: trMatch[1],
                index: trMatch[2],
                s_vlan: trMatch[3],
                c_vlan: trMatch[4]
            });
        }

        return ont;
    }

    parseOpticalTable(text, singleOntId = null) {
        const results = {};
        const tableRegex = /^\s*(\d+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\d+)/gm;
        let m;
        let foundTable = false;

        while ((m = tableRegex.exec(text)) !== null) {
            foundTable = true;
            results[m[1]] = {
                rx_power: `${m[2]} dBm`,
                tx_power: `${m[3]} dBm`,
                olt_rx_power: `${m[4]} dBm`,
                temperature: `${m[5]} C`,
                voltage: `${m[6]} V`,
                current: `${m[7]} mA`,
                distance: `${m[8]} m`
            };
        }

        if (!foundTable && singleOntId !== null) {
            const rx = this.extractValue(text, "Rx optical power(dBm)");
            const tx = this.extractValue(text, "Tx optical power(dBm)");
            const oltRx = this.extractValue(text, "OLT Rx ONT optical power(dBm)");
            const temp = this.extractValue(text, "Temperature(C)");
            const volt = this.extractValue(text, "Voltage(V)");
            const curr = this.extractValue(text, "Laser bias current(mA)");

            if (rx !== "N/A") {
                results[singleOntId] = {
                    rx_power: `${rx} dBm`,
                    tx_power: `${tx} dBm`,
                    olt_rx_power: `${oltRx} dBm`,
                    temperature: `${temp} C`,
                    voltage: `${volt} V`,
                    current: `${curr} mA`
                };
            }
        }

        return results;
    }

    extractValue(text, label) {
        const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`${escapedLabel}\\s*:\\s*([^\\r\\n]+)`, 'i');
        const match = String(text || '').match(regex);
        return match ? match[1].trim() : "N/A";
    }
}

module.exports = BdcomOLTDriver;
