const SSHSession = require('../../core/ssh/SSHSession');
const TelnetSession = require('../../core/telnet/TelnetSession');
const prisma = require('../../../prisma/client');
const { normalizeMac } = require('../../utils/macAddress');

class HuaweiOLTDriver {
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
            return 'gpon';
        }

        return String(serviceBoard.type || 'gpon').toLowerCase();
    }

    async runSession(callback) {
        if (!this.ssh) throw new Error("SSH not connected");

        return this.ssh.runShellSession(async (send) => {
            await send('enable').catch(() => { });
            await send('scroll').catch(() => { });
            await send('config').catch(() => { });

            try {
                return await callback(send);
            } finally {
                await send('return').catch(() => { });
            }
        });
    }

    // -------------------------
    // MAC to F/S/P LOOKUP
    // -------------------------

    /**
     * Convert any MAC address format to Huawei format: xxxx-xxxx-xxxx
     * Accepts: AA:BB:CC:DD:EE:FF, AA-BB-CC-DD-EE-FF, AABB.CCDD.EEFF, AABBCCDDEEFF
     */
    static normalizeMAC(mac) {
        return normalizeMac(mac, 'huawei');
    }

    /**
     * Find Frame/Slot/Port from a MAC address on this OLT.
     * Runs: display mac-address all | include <mac>
     * Returns array of matches: [{ frame, slot, port, ontId, gemIndex, vlan, macAddress, portType }]
     */
    async findFSPByMac(mac) {
        const huaweiMac = HuaweiOLTDriver.normalizeMAC(mac);

        return this.runSession(async (send) => {
            const raw = await send(`display mac-address all | include ${huaweiMac}`);
            return this.parseMacAddressTable(raw, huaweiMac);
        });
    }

    /**
     * Parse Huawei MAC address table output.
     * Expected columns: SRV-P INDEX, BUNDLE INDEX, TYPE, MAC, MAC TYPE, F/S/P, VPI, VCI, VLAN ID
     */
    parseMacAddressTable(text, filterMac = null) {
        const results = [];
        const lines = text
            .replace(/\r/g, '')
            .replace(/---- More.*?\n/g, '')
            .split('\n')
            .filter(l => l.trim() && !l.includes('---') && !l.includes('Note:') && !l.includes('SRV-P'));

        for (const line of lines) {
            // Match lines like: 12  -  gpon 784f-2462-fd2f dynamic  0 /5 /0   3    6   527
            const m = line.match(
                /^\s*(\d+)\s+(\S+)\s+(\w+)\s+([0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4})\s+(\w+)\s+(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/
            );
            if (!m) continue;

            const macAddr = m[4].toLowerCase();
            if (filterMac && macAddr !== filterMac.toLowerCase()) continue;

            results.push({
                originalMac: filterMac || macAddr,
                normalizedMac: macAddr,
                macAddress: macAddr,
                interfaceType: m[3],
                portType: m[3],
                macType: m[5],
                frame: parseInt(m[6]),
                slot: parseInt(m[7]),
                port: parseInt(m[8]),
                fsp: `${m[6]}/${m[7]}/${m[8]}`,
                ontId: parseInt(m[9]),
                gemIndex: parseInt(m[10]),
                vlan: parseInt(m[11]),
                servicePortIndex: parseInt(m[1]),
                srvpIndex: parseInt(m[1]),
                rawMatchedLine: line.trim(),
                lookupTimestamp: new Date().toISOString()
            });
        }

        return results;
    }

    // -------------------------
    // HIGH LEVEL ACTIONS
    // -------------------------

    async autofindall(slot = 0) {
        return this.runSession(async (send) => {
            const boardType = await this.serviceBoardType(slot);

            if (boardType === 'gpon') {
                const raw = await send('display ont autofind all');
                return this.parseAutofind(raw);
            }

            if (boardType === 'epon') {
                const raw = await send('display epon ont autofind all');
                return this.parseAutofind(raw);
            }

            throw new Error(`Unsupported board type: ${boardType}`);
        });
    }

    async autofind(frame, slot, port) {
        return this.runSession(async (send) => {
            const boardType = await this.serviceBoardType(slot);

            if (boardType === 'gpon') {
                await send(`interface gpon ${frame}/${slot}`);
                const raw = await send(`display ont autofind ${port}`);
                await send('quit');
                return this.parseAutofind(raw);
            }

            if (boardType === 'epon') {
                await send(`interface epon ${frame}/${slot}`);
                const raw = await send(`display ont autofind ${port}`);
                await send('quit');
                return this.parseAutofind(raw);
            }

            throw new Error(`Unsupported board type: ${boardType}`);
        });
    }

    async getOntInfoBySN(serial, slot = 0) {
        return this.runSession(async (send) => {
            const boardType = await this.serviceBoardType(slot);

            let rawOntInfo;
            if (boardType === 'gpon') {
                rawOntInfo = await send(`display ont info by-sn ${serial}`);
            } else if (boardType === 'epon') {
                rawOntInfo = await send(`display epon ont info by-sn ${serial}`);
            } else {
                throw new Error(`Unsupported board type: ${boardType}`);
            }

            const ont = this.parseOntInfoBySN(rawOntInfo);

            if (!ont.fsp || ont.fsp === "N/A") return null;

            const [f, s, p] = ont.fsp.split('/');

            try {
                if (boardType === 'gpon') {
                    const servicePortRaw = await send(`display service-port port ${ont.fsp} ont ${ont.ont_id}`);
                    ont.service_ports = this.parseServicePortByOnt(servicePortRaw);

                    await send(`interface gpon ${f}/${s}`);
                    const opticalRaw = await send(`display ont optical-info ${p} ${ont.ont_id}`);
                    const opticalMap = this.parseOpticalTable(opticalRaw, ont.ont_id);
                    ont.optical_diagnostics = opticalMap[ont.ont_id] || { rx_power: "N/A" };
                    await send('quit');
                } else if (boardType === 'epon') {
                    const servicePortRaw = await send(`display service-port port ${ont.fsp} ont ${ont.ont_id}`);
                    ont.service_ports = this.parseServicePortByOnt(servicePortRaw);

                    await send(`interface epon ${f}/${s}`);
                    const opticalRaw = await send(`display ont optical-info ${p} ${ont.ont_id}`);
                    const opticalMap = this.parseOpticalTable(opticalRaw, ont.ont_id);
                    ont.optical_diagnostics = opticalMap[ont.ont_id] || { rx_power: "N/A" };
                    await send('quit');
                }
            } catch (e) {
                console.error('Error getting service/optical info by SN:', e.message);
                ont.service_ports = ont.service_ports || [];
                ont.optical_diagnostics = ont.optical_diagnostics || { rx_power: "N/A" };
                await send('quit').catch(() => { });
            }

            return ont;
        });
    }

    async getOntInfoWithOptical(frame, slot, port) {
        return this.runSession(async (send) => {
            const boardType = await this.serviceBoardType(slot);
            const scope = (port !== undefined && port !== null)
                ? `${frame} ${slot} ${port}`
                : `${frame} ${slot}`;

            let rawInfo;
            if (boardType === 'gpon') {
                rawInfo = await send(`display ont info ${scope} all`);
            } else if (boardType === 'epon') {
                rawInfo = await send(`display epon ont info ${scope} all`);
            } else {
                throw new Error(`Unsupported board type: ${boardType}`);
            }

            const ontMap = this.parseOntTable(rawInfo);
            const extMap = this.parseExtendedInfo(rawInfo);

            const portsToQuery = port !== undefined && port !== null
                ? [String(port)]
                : [...new Set(
                    Object.values(ontMap)
                        .map(o => o.fsp?.split('/')[2])
                        .filter(Boolean)
                )];

            let allOptical = {};

            if (boardType === 'gpon') {
                await send(`interface gpon ${frame}/${slot}`);
            } else {
                await send(`interface epon ${frame}/${slot}`);
            }

            for (const p of portsToQuery) {
                try {
                    let rawOpt;
                    if (boardType === 'gpon') {
                        rawOpt = await send(`display ont optical-info ${p} all`);
                    } else {
                        rawOpt = await send(`display ont optical-info ${p} all`);
                    }

                    const optMap = this.parseOpticalTable(rawOpt);

                    Object.keys(optMap).forEach(ontId => {
                        const fsp = `${frame}/${slot}/${p}`;
                        allOptical[`${fsp}-${ontId}`] = optMap[ontId];
                    });
                } catch (e) {
                    console.error(`Error getting optical info for ${boardType} ${frame}/${slot}/${p}:`, e.message);
                }
            }

            await send('quit').catch(() => { });

            return Object.values(ontMap).map(ont => {
                const key = `${ont.fsp}-${ont.ont_id}`;
                const ext = extMap[key] || {};
                const diag = allOptical[key] || { rx_power: "offline/NA" };

                return {
                    ...ont,
                    ...ext,
                    distance: ext.distance || ont.distance || diag.distance || null,
                    diagnostics: diag,
                    optical_diagnostics: diag
                };
            });
        });
    }

    async registerONT(data) {
        const {
            frame,
            slot,
            port,
            serial,
            line_profile_id,
            service_profile_id,
            description = "",
            vlans = [],
            load_file = null
        } = data;

        return this.runSession(async (send) => {
            const boardType = await this.serviceBoardType(slot);
            const results = { ont_registration: {}, service_ports: [] };

            if (boardType === 'gpon') {
                await send(`interface gpon ${frame}/${slot}`);
                const ontAddResult = await send(
                    `ont add ${port} sn-auth "${serial}" omci ont-lineprofile-id ${line_profile_id} ont-srvprofile-id ${service_profile_id} desc "${description}"`
                );
                results.ont_registration.result = ontAddResult.trim();

                const ontIdMatch = ontAddResult.match(/ONTID\s*:\s*(\d+)/i);
                if (!ontIdMatch) {
                    throw new Error('Could not parse ONT ID from ont add response');
                }
                const ont_id = ontIdMatch[1];

                await send('quit');

                for (const vlanConfig of vlans) {
                    if (vlanConfig.vlan && vlanConfig.gemport) {
                        const spCmd = `service-port vlan ${vlanConfig.vlan} gpon ${frame}/${slot}/${port} ont ${ont_id} gemport ${vlanConfig.gemport} multi-service user-vlan ${vlanConfig.vlan} tag-transform translate`;
                        results.service_ports.push({
                            vlan: vlanConfig.vlan,
                            result: (await send(spCmd)).trim()
                        });
                    }
                }

                if (load_file) {
                    results.ont_load = await this.loadOntWithSend(send, frame, slot, port, ont_id, load_file, serial);
                }

                return results;
            }

            if (boardType === 'epon') {
                await send(`interface epon ${frame}/${slot}`);
                const ontAddResult = await send(
                    `ont add ${port} sn-auth "${serial}" desc "${description}"`
                );
                results.ont_registration.result = ontAddResult.trim();

                const ontIdMatch = ontAddResult.match(/ONTID\s*:\s*(\d+)/i) || ontAddResult.match(/ONT\s*ID\s*:\s*(\d+)/i);
                if (!ontIdMatch) {
                    throw new Error('Could not parse ONT ID from EPON ont add response');
                }
                const ont_id = ontIdMatch[1];

                await send('quit');

                for (const vlanConfig of vlans) {
                    if (vlanConfig.vlan) {
                        const spCmd = `service-port vlan ${vlanConfig.vlan} epon ${frame}/${slot}/${port} ont ${ont_id} multi-service user-vlan ${vlanConfig.vlan} tag-transform translate`;
                        results.service_ports.push({
                            vlan: vlanConfig.vlan,
                            result: (await send(spCmd)).trim()
                        });
                    }
                }

                return results;
            }

            throw new Error(`Unsupported board type: ${boardType}`);
        });
    }

    async loadFileFromTftp(data) {
        const { tftp_host, tftpHost, filename } = data || {};
        const host = tftp_host || tftpHost;
        this.validateCliToken(host, 'TFTP server IP');
        this.validateCliToken(filename, 'filename');
        return this.runSession(async (send) => {
            const command = `load file tftp ${host} ${filename}`;
            const output = await send(command, 5000);
            if (/failure:|user cancelled|loading\([^)]*\) failed/i.test(output)) {
                throw new Error(`OLT file transfer failed: ${output.replace(/\s+/g, ' ').trim()}`);
            }
            const oltFilename = String(filename).toLowerCase();
            const file = await this.waitForFile(send, oltFilename);
            if (!file.found) throw new Error(`OLT reported transfer completion, but '${oltFilename}' was not found in flash`);
            return {
                command,
                result: output.trim(),
                olt_filename: oltFilename,
                file
            };
        });
    }

    async displayFile(data) {
        const filename = typeof data === 'string' ? data : data?.filename;
        this.validateCliToken(filename, 'filename');
        return this.runSession((send) => this.waitForFile(send, String(filename).toLowerCase()));
    }

    async loadOnt(data) {
        const { frame, slot, port, ont_id, ontId, filename } = data || {};
        return this.runSession((send) => this.loadOntWithSend(send, frame, slot, port, ont_id ?? ontId, filename, data?.serial));
    }

    async loadOntWithSend(send, frame, slot, port, ontId, filename, serial = null) {
        [frame, slot, port, ontId].forEach((value, index) => {
            if (!Number.isInteger(Number(value)) || Number(value) < 0) {
                throw new Error(`Invalid ${['frame', 'slot', 'port', 'ONT ID'][index]}`);
            }
        });
        this.validateCliToken(filename, 'filename');
        const oltFilename = String(filename).toLowerCase();
        const file = await this.waitForFile(send, oltFilename);
        if (!file.found) {
            throw new Error(`ONT configuration file '${oltFilename}' was not found on the OLT`);
        }

        const online = await this.waitForOntOnline(send, frame, slot, port, ontId, serial);
        if (!online.online) {
            throw new Error(`ONT ${ontId} on ${frame}/${slot}/${port} did not come online before loading '${oltFilename}'`);
        }

        const command = `ont load ${frame}/${slot}/${port} ${ontId} ${oltFilename}`;
        const output = await send(command);
        if (/\bfailure\s*:/i.test(output) || /\b(error|failed)\b/i.test(output)) {
            throw new Error(`ONT configuration load failed: ${output.replace(/\s+/g, ' ').trim()}`);
        }
        return { command, result: output.trim(), file, online_check: online };
    }

    async waitForOntOnline(send, frame, slot, port, ontId, serial = null, attempts = 15, intervalMs = 2000) {
        let lastOutput = '';
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            const command = serial
                ? `display ont info by-sn ${serial}`
                : `display ont info ${frame}/${slot} ${port} ${ontId}`;
            lastOutput = await send(command);
            const runState = lastOutput.match(/Run\s+state\s*:\s*([^\r\n]+)/i)?.[1]?.trim() || null;
            if (runState && /^online\b/i.test(runState)) {
                return { online: true, run_state: runState, attempts: attempt, command };
            }
            if (attempt < attempts) {
                await new Promise(resolve => setTimeout(resolve, intervalMs));
            }
        }
        return {
            online: false,
            run_state: lastOutput.match(/Run\s+state\s*:\s*([^\r\n]+)/i)?.[1]?.trim() || null,
            attempts
        };
    }

    async checkFileWithSend(send, filename) {
        const command = `display file ${filename}`;
        const output = await send(command);
        const escapedFilename = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const row = output.match(new RegExp(
            `^\\s*(${escapedFilename})\\s+(\\d+)\\s+(\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}:\\d{2}(?:[+-]\\d{2}:\\d{2})?)\\s+(\\S+)\\s*$`,
            'im'
        ));
        const location = output.match(/^\s*([A-Za-z0-9_-]+:)\s*$/m)?.[1] || null;

        if (!row) {
            return {
                found: false,
                filename,
                command,
                busy: /command being executed|please retry later|loading\(backuping,rollbacking,duplicating/i.test(output)
            };
        }

        return {
            found: true,
            filename: row[1],
            size_bytes: Number(row[2]),
            creation_time: row[3],
            attribute: row[4],
            location,
            command
        };
    }

    async waitForFile(send, filename, attempts = 8, intervalMs = 1500) {
        const normalizedFilename = String(filename).toLowerCase();
        let result = null;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            result = await this.checkFileWithSend(send, normalizedFilename);
            if (result.found) return { ...result, verification_attempts: attempt };
            if (attempt < attempts) {
                await new Promise(resolve => setTimeout(resolve, intervalMs));
            }
        }
        return { ...(result || {}), found: false, filename: normalizedFilename, verification_attempts: attempts };
    }

    validateCliToken(value, label) {
        if (!value || !/^[A-Za-z0-9._:-]+$/.test(String(value))) {
            throw new Error(`Invalid ${label}`);
        }
    }

    async deleteOnt(data) {
        const { frame, slot, port, ont_id, service_port_indices = [] } = data;

        return this.runSession(async (send) => {
            const boardType = await this.serviceBoardType(slot);
            const processLogs = { service_ports: [], ont_deletion: "", discovered_service_ports: [] };

            // Cached ONT details can be stale or empty. Always ask the OLT for
            // the live service-port list before deleting the ONT and merge it
            // with any indices supplied by the caller.
            const servicePortOutput = await send(`display service-port port ${frame}/${slot}/${port} ont ${ont_id}`);
            const parsedServicePorts = this.parseServicePortByOnt(servicePortOutput);
            const fallbackIndices = [...servicePortOutput.matchAll(/^\s*(\d+)\s+\d+\s+/gm)]
                .map(match => Number(match[1]));
            const labeledIndices = [...servicePortOutput.matchAll(/service-port(?:\s+index)?\s*:\s*(\d+)/gi)]
                .map(match => Number(match[1]));
            const liveIndices = parsedServicePorts.map(row => Number(row.index));
            const indicesToDelete = [...new Set([
                ...(Array.isArray(service_port_indices) ? service_port_indices : []).map(Number),
                ...liveIndices,
                ...fallbackIndices,
                ...labeledIndices
            ].filter(index => Number.isInteger(index) && index >= 0))];
            processLogs.discovered_service_ports = indicesToDelete;

            for (const index of indicesToDelete) {
                const undoCmd = `undo service-port ${index}`;
                const undoOutput = await send(undoCmd);
                const failed = /\bfailure\s*:|\b(error|failed)\b/i.test(undoOutput);
                processLogs.service_ports.push({
                    index,
                    status: failed ? "Failed" : "Success",
                    result: undoOutput.trim()
                });
                if (failed) {
                    throw new Error(`Failed to delete service port ${index}: ${undoOutput.replace(/\s+/g, ' ').trim()}`);
                }
            }

            if (boardType === 'gpon') {
                await send(`interface gpon ${frame}/${slot}`);
                const deleteOutput = await send(`ont delete ${port} ${ont_id}`);
                processLogs.ont_deletion = deleteOutput.trim();
                await send('quit');
                if (/\bfailure\s*:|\b(error|failed)\b/i.test(deleteOutput)) {
                    throw new Error(`Failed to delete ONT ${ont_id}: ${deleteOutput.replace(/\s+/g, ' ').trim()}`);
                }
                return processLogs;
            }

            if (boardType === 'epon') {
                await send(`interface epon ${frame}/${slot}`);
                const deleteOutput = await send(`ont delete ${port} ${ont_id}`);
                processLogs.ont_deletion = deleteOutput.trim();
                await send('quit');
                if (/\bfailure\s*:|\b(error|failed)\b/i.test(deleteOutput)) {
                    throw new Error(`Failed to delete ONT ${ont_id}: ${deleteOutput.replace(/\s+/g, ' ').trim()}`);
                }
                return processLogs;
            }

            throw new Error(`Unsupported board type: ${boardType}`);
        });
    }

    async getServicePorts() {
        return this.runSession(async (send) => {
            const raw = await send('display service-port all', 2000);
            return this.parseServicePortTable(raw);
        });
    }

    async executeCommand(command) {
        return this.runSession(async (send) => {
            const output = await send(command);
            return output.trim();
        });
    }

    // -------------------------
    // PARSERS
    // -------------------------

    parseOntTable(text) {
        const ontMap = {};
        const statusRegex = /^\s*(\d+\/\s*\d+\/\d+)\s+(\d+)\s+([0-9A-Z]{16})\s+(\w+)\s+(\w+)\s+(\w+)\s+(\w+)\s+(\w+)/gm;
        const descRegex = /^\s*(\d+\/\s*\d+\/\d+)\s+(\d+)\s{2,}(.+)/gm;
        let m;

        while ((m = statusRegex.exec(text)) !== null) {
            const fsp = m[1].replace(/\s+/g, '');
            const id = m[2];
            ontMap[`${fsp}-${id}`] = {
                fsp,
                ont_id: id,
                sn: m[3],
                control_flag: m[4],
                run_state: m[5],
                config_state: m[6],
                match_state: m[7],
                protect_side: m[8]
            };
        }

        while ((m = descRegex.exec(text)) !== null) {
            const fsp = m[1].replace(/\s+/g, '');
            const id = m[2];
            if (ontMap[`${fsp}-${id}`]) {
                ontMap[`${fsp}-${id}`].description = m[3].trim();
            }
        }

        return ontMap;
    }

    parseServicePortTable(text) {
        const results = [];
        const clean = text
            .replace(/\r/g, '')
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

    parseExtendedInfo(text) {
        const results = {};
        const blocks = text.split(/-----------------------------------------------------------------------------/);
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
        const entries = text.split(/----------------------------------------------------------------------------/);
        const results = [];

        entries.forEach(entry => {
            const fspMatch = entry.match(/F\/S\/P\s+:\s+(\d+\/\d+\/\d+)/);
            const snMatch = entry.match(/Ont SN\s+:\s+([A-Z0-9]+)/);
            const timeMatch = entry.match(/Ont autofind time\s+:\s+(.+)/);

            if (fspMatch && snMatch) {
                results.push({
                    interface: fspMatch[1],
                    ont_id_details: snMatch[1],
                    discovered_at: timeMatch ? timeMatch[1].trim() : 'Unknown'
                });
            }
        });

        return results;
    }

    parseServicePortByOnt(text) {
        const results = [];
        const lines = text
            .replace(/\r/g, '')
            .replace(/---- More.*?\n/g, '')
            .split('\n')
            .filter(l => /^\s*\d+\s+\d+/.test(l));

        const regex = /^\s*(\d+)\s+(\d+)\s+(\w+)\s+(\w+)\s+([\d/ ]+)\s+(\d+)\s+(\d+)\s+(\w+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(up|down)/i;

        for (const line of lines) {
            const m = line.match(regex);
            if (!m) continue;

            results.push({
                index: Number(m[1]),
                vlan: Number(m[2]),
                vlan_attr: m[3],
                port_type: m[4],
                fsp: m[5].replace(/\s+/g, ''),
                ont_id: Number(m[6]),
                gem_index: Number(m[7]),
                flow_type: m[8],
                flow_para: m[9],
                rx: m[10],
                tx: m[11],
                state: m[12].toLowerCase()
            });
        }

        return results;
    }

    extractValue(text, label) {
        const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`${escapedLabel}\\s*:\\s*([^\\r\\n]+)`, 'i');
        const match = text.match(regex);
        return match ? match[1].trim() : "N/A";
    }
}

module.exports = HuaweiOLTDriver;
