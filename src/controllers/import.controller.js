const xlsx = require('xlsx');
const bcrypt = require('bcrypt');
const { ServiceFactory } = require('../lib/clients/ServiceFactory');
const { SERVICE_CODES } = require('../lib/serviceConstants');
const { computeExpiryFromBase, computeStartFromExpiry, normalizeDurationString, atPlanBoundary, parseAnyDate } = require('../utils/dateHelper');
const { formatRadiusExpiration } = require('../utils/radiusExpiration');

/**
 * Helper to slugify text for codes
 */
function slugify(text) {
    if (!text) return '';
    return String(text)
        .toUpperCase()
        .trim()
        .replace(/[^A-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * Split Full Name into First, Middle, and Last names
 */
function splitFullName(fullName) {
    if (!fullName) return { firstName: 'Customer', middleName: null, lastName: 'User' };
    const parts = String(fullName).trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
        return { firstName: 'Customer', middleName: null, lastName: 'User' };
    }
    if (parts.length === 1) {
        return { firstName: parts[0], middleName: null, lastName: '' };
    }
    if (parts.length === 2) {
        return { firstName: parts[0], middleName: null, lastName: parts[1] };
    }
    return {
        firstName: parts[0],
        middleName: parts.slice(1, parts.length - 1).join(' '),
        lastName: parts[parts.length - 1]
    };
}

/**
 * Generate a secure random password
 */
function generateSecurePassword(length = 10) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
    let password = '';
    for (let i = 0; i < length; i++) {
        password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
}

/**
 * Generate a unique branch code
 */
async function generateUniqueBranchCode(prisma, ispId, baseCode, isSubBranch = false) {
    const prefix = isSubBranch ? 'SB' : 'BR';
    const cleanBase = slugify(baseCode).substring(0, 20) || 'BRANCH';
    let candidate = `${prefix}-${cleanBase}`;
    let counter = 1;

    while (true) {
        const existing = await prisma.Branch.findFirst({
            where: {
                code: candidate,
                ...(ispId ? { ispId: Number(ispId) } : {}),
                isDeleted: false
            }
        });
        if (!existing) return candidate;
        candidate = `${prefix}-${cleanBase}-${counter}`;
        counter++;
    }
}

/**
 * Generate a unique plan code
 */
async function generateUniquePlanCode(prisma, ispId, planName) {
    const cleanBase = slugify(planName).substring(0, 30) || 'PLAN';
    let candidate = `PLAN-${cleanBase}`;
    let counter = 1;

    while (true) {
        const existing = await prisma.PackagePlan.findFirst({
            where: {
                planCode: candidate,
                ...(ispId ? { ispId: Number(ispId) } : {}),
                isDeleted: false
            }
        });
        if (!existing) return candidate;
        candidate = `PLAN-${cleanBase}-${counter}`;
        counter++;
    }
}

/**
 * Generate unique referenceId for PackagePrice
 */
async function generateUniqueReferenceId(prisma, baseRefId, excludeId = null) {
    let refId = baseRefId;
    let counter = 1;

    while (true) {
        const existing = await prisma.PackagePrice.findFirst({
            where: {
                referenceId: refId,
                ...(excludeId ? { id: { not: Number(excludeId) } } : {})
            }
        });
        if (!existing) return refId;
        refId = `${baseRefId}-${counter}`;
        counter++;
    }
}

/**
 * Generate customer unique ID
 */
async function generateCustomerUniqueId(prisma, customerId, firstName = '', lastName = '', membershipCode = 'GEN', branchId = null, subBranchId = null, ispId = null) {
    let settingsObj = {};
    if (ispId) {
        try {
            const settings = await prisma.ISPSettings.findMany({ where: { ispId: Number(ispId) } });
            settingsObj = settings.reduce((acc, s) => {
                acc[s.key] = s.value;
                return acc;
            }, {});
        } catch (e) {}
    }

    let branchCode = '';
    if (branchId && settingsObj.customerIdIncludeBranch === 'true') {
        try {
            const br = await prisma.Branch.findUnique({ where: { id: Number(branchId) } });
            if (br) branchCode = br.code || br.name.substring(0, 3).toUpperCase();
        } catch (e) {}
    }

    let subBranchCode = '';
    if (subBranchId && settingsObj.customerIdIncludeSubBranch === 'true') {
        try {
            const sb = await prisma.Branch.findUnique({ where: { id: Number(subBranchId) } });
            if (sb) subBranchCode = sb.code || sb.name.substring(0, 3).toUpperCase();
        } catch (e) {}
    }

    const prefix = settingsObj.hasOwnProperty('customerIdPrefix') ? settingsObj.customerIdPrefix : 'CUS';
    const includeMembership = settingsObj.customerIdIncludeMembership !== 'false';
    const memPart = includeMembership ? membershipCode : '';
    const paddingLen = parseInt(settingsObj.customerIdPaddingLength || '5', 10);
    const paddedId = String(customerId).padStart(paddingLen, '0');

    let namePart = '';
    if (settingsObj.customerIdIncludeNamePart !== 'false') {
        const nameLen = parseInt(settingsObj.customerIdNamePartLength || '5', 10);
        let nameStr = (firstName || '').substring(0, nameLen).toUpperCase();
        if (nameStr.length < nameLen && lastName) {
            const needed = nameLen - nameStr.length;
            nameStr += lastName.substring(0, needed).toUpperCase();
        }
        if (nameStr.length < nameLen) {
            nameStr = nameStr.padEnd(nameLen, 'X');
        }
        namePart = nameStr;
    }

    const parts = [];
    if (prefix) parts.push(prefix);
    if (memPart) parts.push(memPart);
    if (branchCode) parts.push(branchCode);
    if (subBranchCode) parts.push(subBranchCode);
    parts.push(paddedId);
    if (namePart) parts.push(namePart);

    return parts.join('-');
}

/**
 * Parse Speed in Mbps from package name or speed string
 */
function extractSpeedMbps(nameOrSpeed) {
    if (!nameOrSpeed) return 100;
    const str = String(nameOrSpeed).trim();
    if (/^\d+(\.\d+)?$/.test(str)) {
        return Math.max(1, Math.round(parseFloat(str)));
    }
    const gbMatch = str.match(/(\d+(?:\.\d+)?)\s*(?:gbps|gb|g)/i);
    if (gbMatch) {
        return Math.round(parseFloat(gbMatch[1]) * 1000);
    }
    const mbMatch = str.match(/(\d+(?:\.\d+)?)\s*(?:mbps|mb|m)?/i);
    if (mbMatch && mbMatch[1]) {
        return Math.max(1, Math.round(parseFloat(mbMatch[1])));
    }
    return 100;
}

/**
 * Return the first populated value from a spreadsheet/JSON row while
 * preserving meaningful false and zero values.
 */
function getFirstRowValue(row, keys, fallback = undefined) {
    for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
        const value = row[key];
        if (value === undefined || value === null) continue;
        if (typeof value === 'string' && value.trim() === '') continue;
        return value;
    }
    return fallback;
}

/**
 * Format Mikrotik Rate Limit string
 */
function formatMikrotikRateLimit(upMbps, downMbps, priority = 8) {
    const upload = Number(upMbps) || 100;
    const download = Number(downMbps) || 100;
    const burstUpload = upload;
    const burstDownload = download;
    const thresholdUpload = Math.floor(upload * 0.8) || upload;
    const thresholdDownload = Math.floor(download * 0.8) || download;
    const burstTime = '5/5';
    const minUpload = upload;
    const minDownload = download;

    return [
        `${upload}M/${download}M`,
        `${burstUpload}M/${burstDownload}M`,
        `${thresholdUpload}M/${thresholdDownload}M`,
        burstTime,
        String(priority),
        `${minUpload}M/${minDownload}M`
    ].join(' ');
}

function calculateJuniperBurstBytes(mbps) {
    const speed = Number(mbps) || 0;
    return Math.round((speed * 1000000 / 8) * 0.005);
}

/**
 * Parse VLAN IDs list from comma/semicolon delimited string or array
 */
function parseVlanList(val) {
    if (!val && val !== 0) return [];
    if (Array.isArray(val)) return val.map(Number).filter(n => !isNaN(n) && n >= 1 && n <= 4094);
    if (typeof val === 'number') return val >= 1 && val <= 4094 ? [val] : [];
    const str = String(val).trim();
    if (!str) return [];
    if (str.startsWith('[') && str.endsWith(']')) {
        try {
            const parsed = JSON.parse(str);
            if (Array.isArray(parsed)) {
                return parsed.map(item => typeof item === 'object' && item !== null ? Number(item.vlanId || item.vlan || item.id) : Number(item)).filter(n => !isNaN(n) && n >= 1 && n <= 4094);
            }
        } catch (e) {}
    }
    const matches = str.match(/\d+/g);
    if (!matches) return [];
    return [...new Set(matches.map(Number).filter(n => n >= 1 && n <= 4094))];
}

/**
 * Helper to parse service boards array or strings from import row
 */
function parseServiceBoardsFromRow(row) {
    // 1. If serviceBoards is already an array
    if (Array.isArray(row.serviceBoards)) {
        return row.serviceBoards.map((b, idx) => ({
            slot: Number(b.slot || idx + 1),
            type: (b.type || 'GPON').toString().toUpperCase(),
            portCount: Number(b.portCount || b.ports || 16),
            usedPorts: Number(b.usedPorts || 0),
            availablePorts: Number(b.portCount || b.ports || 16) - Number(b.usedPorts || 0),
            status: b.status || 'active',
            temperature: b.temperature ? Number(b.temperature) : null,
            powerConsumption: b.powerConsumption ? Number(b.powerConsumption) : null,
            firmwareVersion: b.firmwareVersion || null,
            serialNumber: b.serialNumber || null
        }));
    }

    const rawBoards = (row.serviceBoards || row.boards || row['Service Boards'] || '').toString().trim();
    if (rawBoards) {
        // Try parsing as JSON array
        try {
            if (rawBoards.startsWith('[') && rawBoards.endsWith(']')) {
                const parsed = JSON.parse(rawBoards);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    return parsed.map((b, idx) => ({
                        slot: Number(b.slot || idx + 1),
                        type: (b.type || 'GPON').toString().toUpperCase(),
                        portCount: Number(b.portCount || b.ports || 16),
                        usedPorts: Number(b.usedPorts || 0),
                        availablePorts: Number(b.portCount || b.ports || 16) - Number(b.usedPorts || 0),
                        status: b.status || 'active',
                        temperature: b.temperature ? Number(b.temperature) : null,
                        powerConsumption: b.powerConsumption ? Number(b.powerConsumption) : null,
                        firmwareVersion: b.firmwareVersion || null,
                        serialNumber: b.serialNumber || null
                    }));
                }
            }
        } catch (e) {}

        // Try parsing delimited: e.g. "Slot 1: GPON: 16 Ports, Slot 2: GPON: 16 Ports" or "1:GPON:16; 2:GPON:16"
        const boardSegments = rawBoards.split(/[,;|\n]+/).map(s => s.trim()).filter(Boolean);
        if (boardSegments.length > 0) {
            const parsedBoards = [];
            boardSegments.forEach((seg, idx) => {
                const slotMatch = seg.match(/slot\s*(\d+)/i) || seg.match(/^(\d+)\s*:/);
                const slot = slotMatch ? parseInt(slotMatch[1], 10) : (idx + 1);

                let type = 'GPON';
                if (/xg-pon|xgs-pon/i.test(seg)) type = 'XG-PON';
                else if (/epon/i.test(seg)) type = 'EPON';
                else if (/10ge|ge/i.test(seg)) type = 'GE';

                const portMatch = seg.match(/(\d+)\s*(?:ports?|p\b)?/i);
                let portCount = 16;
                if (portMatch) {
                    const parsedNum = parseInt(portMatch[1], 10);
                    if (parsedNum === 8 || parsedNum === 16 || parsedNum === 32 || parsedNum === 4 || parsedNum === 64) {
                        portCount = parsedNum;
                    }
                }

                parsedBoards.push({
                    slot,
                    type,
                    portCount,
                    usedPorts: 0,
                    availablePorts: portCount,
                    status: 'active',
                    temperature: null,
                    powerConsumption: null,
                    firmwareVersion: null,
                    serialNumber: null
                });
            });
            if (parsedBoards.length > 0) return parsedBoards;
        }
    }

    // Fallback to separate columns: numberOfBoards, boardType, portsPerBoard, totalPorts
    const numBoards = parseInt(row.numberOfBoards || row.serviceBoardsCount || row['Number of Service Boards'] || row['Service Board Count'] || '1', 10) || 1;
    const defaultType = (row.boardType || row['Board Type'] || row.type || 'GPON').toString().toUpperCase();
    const portsPerBoard = parseInt(row.portsPerBoard || row['Ports per Board'] || row.ports || '16', 10) || 16;

    const boards = [];
    for (let i = 1; i <= Math.min(numBoards, 32); i++) {
        boards.push({
            slot: i,
            type: defaultType,
            portCount: portsPerBoard,
            usedPorts: 0,
            availablePorts: portsPerBoard,
            status: 'active',
            temperature: null,
            powerConsumption: null,
            firmwareVersion: null,
            serialNumber: null
        });
    }
    return boards;
}

/**
 * Format MAC Address to xxxx.xxxx.xxxx format (Cisco / Huawei dot notation)
 */
function formatMacToDotNotation(mac) {
    if (!mac && mac !== 0) return null;
    const clean = String(mac).replace(/[^a-fA-F0-9]/g, '').toLowerCase();
    if (clean.length === 12) {
        return `${clean.slice(0, 4)}.${clean.slice(4, 8)}.${clean.slice(8, 12)}`;
    }
    const str = String(mac).trim().toLowerCase();
    if (/^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/.test(str)) {
        return str;
    }
    return str || null;
}

/**
 * Parse OLT VLAN configurations with dynamic multiple VLAN IDs, Names, GEM Indices, Types, and Descriptions
 */
function parseOltVlans(row) {
    const results = [];
    const rawVlans = row.vlans || row.vlan || row.vlanId || row['VLANs'] || row['VLAN ID'] || row['VLAN'] || '';

    // Check if array
    if (Array.isArray(rawVlans)) {
        return rawVlans.map((v, idx) => ({
            vlanId: Number(v.vlanId || v.id || v.vlan || 100),
            name: (v.name || v.vlanName || `${v.vlanId || v.id || 100}_VLAN`).toString().trim(),
            gemIndex: v.gemIndex !== undefined && v.gemIndex !== null ? Number(v.gemIndex) : (Number(v.vlanId || v.id) || idx + 1),
            vlanType: (v.vlanType || v.type || 'standard').toString().trim(),
            description: (v.description || '').toString().trim()
        })).filter(v => v.vlanId >= 1 && v.vlanId <= 4094);
    }

    const str = String(rawVlans).trim();
    if (str.startsWith('[') && str.endsWith(']')) {
        try {
            const parsed = JSON.parse(str);
            if (Array.isArray(parsed) && parsed.length > 0) {
                return parsed.map((v, idx) => ({
                    vlanId: Number(v.vlanId || v.id || v.vlan || 100),
                    name: (v.name || v.vlanName || `${v.vlanId || v.id || 100}_VLAN`).toString().trim(),
                    gemIndex: v.gemIndex !== undefined && v.gemIndex !== null ? Number(v.gemIndex) : (Number(v.vlanId || v.id) || idx + 1),
                    vlanType: (v.vlanType || v.type || 'standard').toString().trim(),
                    description: (v.description || '').toString().trim()
                })).filter(v => v.vlanId >= 1 && v.vlanId <= 4094);
            }
        } catch (e) {}
    }

    const rawVlanNames = (row.vlanName || row['VLAN Name'] || row.vlanNames || row['VLAN Names'] || '').toString().trim();
    const rawGemIndices = (row.gemIndex || row.gemPort || row['GEM Index'] || row['GEM Port'] || row.gemIndices || row['GEM Indices'] || '').toString().trim();
    const rawVlanTypes = (row.vlanType || row['VLAN Type'] || 'standard').toString().trim();
    const rawVlanDescs = (row.vlanDescription || row['VLAN Description'] || '').toString().trim();

    const nameList = rawVlanNames.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
    const gemList = rawGemIndices.split(/[,;\n]+/).map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    const typeList = rawVlanTypes.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
    const descList = rawVlanDescs.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);

    // Delimited string: e.g. "527:527_ACS:6, 528:528_INTERNET:7" or "527, 528"
    const segments = str.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
    if (segments.length > 0) {
        segments.forEach((seg, idx) => {
            const parts = seg.split(/[:=]/).map(p => p.trim());
            const vNum = parseInt(parts[0], 10);
            if (!isNaN(vNum) && vNum >= 1 && vNum <= 4094) {
                const name = parts[1] || nameList[idx] || (nameList.length === 1 && idx === 0 ? nameList[0] : `VLAN_${vNum}`);
                const gem = parts[2] ? parseInt(parts[2], 10) : (gemList[idx] !== undefined ? gemList[idx] : (gemList.length === 1 ? gemList[0] + idx : vNum));
                const vType = typeList[idx] || typeList[0] || 'standard';
                const vDesc = descList[idx] || descList[0] || '';
                results.push({
                    vlanId: vNum,
                    name,
                    gemIndex: !isNaN(gem) ? gem : vNum,
                    vlanType: vType,
                    description: vDesc
                });
            }
        });
    }

    return results;
}

/**
 * Parse OLT Line & Service Profiles with ID, Name, Services, VLANs, Bandwidth, Description
 */
function parseOltProfiles(row, defaultVlans = []) {
    const lineProfiles = [];
    const serviceProfiles = [];

    const rawLine = row.lineProfiles || row['Line Profiles'] || '';
    const rawService = row.serviceProfiles || row['Service Profiles'] || '';

    // Direct separate Line Profile columns
    const lineProfId = (row.lineProfileId || row['Line Profile ID'] || '').toString().trim();
    const lineProfName = (row.lineProfileName || row['Line Profile Name'] || row.lineProfile || row['Line Profile'] || '').toString().trim();

    // Direct separate Service Profile columns
    const servProfId = (row.serviceProfileId || row['Service Profile ID'] || '').toString().trim();
    const servProfName = (row.serviceProfileName || row['Service Profile Name'] || row.serviceProfile || row['Service Profile'] || '').toString().trim();

    // Combined/Generic Profile columns
    const genProfileId = (row.profileId || row['Profile ID'] || '').toString().trim();
    const genProfileName = (row.profileName || row['Profile Name'] || '').toString().trim();

    const upBw = (row.upstreamBandwidth || row['Upstream Bandwidth'] || '100M').toString().trim();
    const downBw = (row.downstreamBandwidth || row['Downstream Bandwidth'] || '1G').toString().trim();
    const rawServices = row.services || row['Services'] || ['internet', 'voice', 'iptv', 'management'];
    const servicesList = Array.isArray(rawServices) ? rawServices : String(rawServices).split(/[,;\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
    const desc = (row.profileDescription || row['Profile Description'] || row.description || '').toString().trim();

    // 1. If explicit Line Profile provided
    if (lineProfId || lineProfName) {
        const lpId = lineProfId || genProfileId || (lineProfName ? slugify(lineProfName) : '12');
        const lpName = lineProfName || `LineProfile_${lpId}`;
        lineProfiles.push({
            profileId: lpId,
            name: lpName,
            type: 'line',
            upstreamBandwidth: upBw || '100M',
            downstreamBandwidth: downBw || '1G',
            tcontType: 'type4',
            description: desc || `Line Profile ${lpName}`
        });
    } else if (genProfileId || genProfileName) {
        const pId = genProfileId || '12';
        const pName = genProfileName || `LineProfile_${pId}`;
        lineProfiles.push({
            profileId: pId,
            name: pName,
            type: 'line',
            upstreamBandwidth: upBw || '100M',
            downstreamBandwidth: downBw || '1G',
            tcontType: 'type4',
            description: desc || `Line Profile ${pName}`
        });
    }

    // 2. If explicit Service Profile provided
    if (servProfId || servProfName) {
        const spId = servProfId || genProfileId || (servProfName ? slugify(servProfName) : '12');
        const spName = servProfName || `ServiceProfile_${spId}`;
        serviceProfiles.push({
            profileId: spId,
            name: spName,
            type: 'service',
            services: servicesList.length > 0 ? servicesList : ['internet', 'voice', 'iptv', 'management'],
            vlans: defaultVlans.length > 0 ? defaultVlans : [100],
            qosProfile: 'default',
            description: desc || `Service Profile ${spName}`
        });
    } else if (genProfileId || genProfileName) {
        const pId = genProfileId || '12';
        const pName = genProfileName || `ServiceProfile_${pId}`;
        serviceProfiles.push({
            profileId: pId,
            name: pName,
            type: 'service',
            services: servicesList.length > 0 ? servicesList : ['internet', 'voice', 'iptv', 'management'],
            vlans: defaultVlans.length > 0 ? defaultVlans : [100],
            qosProfile: 'default',
            description: desc || `Service Profile ${pName}`
        });
    }

    // 3. Parse additional Line Profiles string / JSON
    if (rawLine) {
        if (typeof rawLine === 'string' && rawLine.startsWith('[') && rawLine.endsWith(']')) {
            try {
                const parsed = JSON.parse(rawLine);
                if (Array.isArray(parsed)) {
                    parsed.forEach((p, idx) => {
                        const id = (p.profileId || p.id || `LP_${idx + 1}`).toString().trim();
                        const name = (p.name || `LineProfile_${id}`).toString().trim();
                        if (!lineProfiles.find(x => x.profileId === id || x.name === name)) {
                            lineProfiles.push({
                                profileId: id,
                                name,
                                type: 'line',
                                upstreamBandwidth: p.upstreamBandwidth || '100M',
                                downstreamBandwidth: p.downstreamBandwidth || '1G',
                                tcontType: p.tcontType || 'type4',
                                description: p.description || `Line Profile ${name}`
                            });
                        }
                    });
                }
            } catch (e) {}
        } else {
            const segs = String(rawLine).split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
            segs.forEach((seg, idx) => {
                const parts = seg.split(/[:=]/).map(p => p.trim());
                const id = parts[0] || `LP_${idx + 1}`;
                const name = parts[1] || id;
                const up = parts[2] || '100M';
                const down = parts[3] || '1G';
                if (!lineProfiles.find(x => x.profileId === id || x.name === name)) {
                    lineProfiles.push({
                        profileId: id,
                        name,
                        type: 'line',
                        upstreamBandwidth: up,
                        downstreamBandwidth: down,
                        tcontType: 'type4',
                        description: `Line Profile ${name}`
                    });
                }
            });
        }
    }

    // 4. Parse additional Service Profiles string / JSON
    if (rawService) {
        if (typeof rawService === 'string' && rawService.startsWith('[') && rawService.endsWith(']')) {
            try {
                const parsed = JSON.parse(rawService);
                if (Array.isArray(parsed)) {
                    parsed.forEach((p, idx) => {
                        const id = (p.profileId || p.id || `SP_${idx + 1}`).toString().trim();
                        const name = (p.name || `ServiceProfile_${id}`).toString().trim();
                        if (!serviceProfiles.find(x => x.profileId === id || x.name === name)) {
                            serviceProfiles.push({
                                profileId: id,
                                name,
                                type: 'service',
                                services: Array.isArray(p.services) ? p.services : ['internet', 'voice', 'iptv', 'management'],
                                vlans: Array.isArray(p.vlans) ? p.vlans : defaultVlans,
                                qosProfile: p.qosProfile || 'default',
                                description: p.description || `Service Profile ${name}`
                            });
                        }
                    });
                }
            } catch (e) {}
        } else {
            const segs = String(rawService).split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
            segs.forEach((seg, idx) => {
                const parts = seg.split(/[:=]/).map(p => p.trim());
                const id = parts[0] || `SP_${idx + 1}`;
                const name = parts[1] || id;
                if (!serviceProfiles.find(x => x.profileId === id || x.name === name)) {
                    serviceProfiles.push({
                        profileId: id,
                        name,
                        type: 'service',
                        services: ['internet', 'voice', 'iptv', 'management'],
                        vlans: defaultVlans,
                        qosProfile: 'default',
                        description: `Service Profile ${name}`
                    });
                }
            });
        }
    }

    return { lineProfiles, serviceProfiles };
}

/**
 * Parse Vendor-Specific Profiles from JSON or String
 * e.g. [{"vendor":"juniper","profile":"xFTTH-pp0"}] or "JUNIPER:xFTTH-pp0; NOKIA:profile1"
 */
function parseVendorProfiles(input) {
    if (!input) return [];
    if (Array.isArray(input)) {
        return input.map(item => {
            if (typeof item === 'object' && item && item.vendor && item.profile) {
                return { vendor: String(item.vendor).toLowerCase().trim(), profile: String(item.profile).trim() };
            }
            return null;
        }).filter(Boolean);
    }
    if (typeof input === 'object') {
        if (input.vendor && input.profile) {
            return [{ vendor: String(input.vendor).toLowerCase().trim(), profile: String(input.profile).trim() }];
        }
        return [];
    }

    const str = String(input).trim();
    if (str.startsWith('[') || str.startsWith('{')) {
        try {
            const parsed = JSON.parse(str);
            return parseVendorProfiles(parsed);
        } catch (e) {}
    }

    const items = str.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
    const profiles = [];
    for (const item of items) {
        const parts = item.split(/[:=]/).map(s => s.trim());
        if (parts.length >= 2) {
            profiles.push({ vendor: parts[0].toLowerCase(), profile: parts[1] });
        } else if (parts.length === 1 && parts[0]) {
            profiles.push({ vendor: 'juniper', profile: parts[0] });
        }
    }
    return profiles;
}

/**
 * Parse Custom Radius Attributes from JSON, multi-line string, or comma/semicolon delimited string
 * e.g. "ERX-IPv6-Delegated-Pool-Name := v6-default-pd \n Framed-IPv6-Pool := v6-ndra"
 * or [{"attribute":"ERX-IPv6-Delegated-Pool-Name","op":":=","value":"v6-default-pd"}]
 */
function parseCustomRadiusAttributes(input) {
    if (!input) return [];
    if (Array.isArray(input)) {
        return input.map(item => {
            if (typeof item === 'string') {
                const sub = parseCustomRadiusAttributes(item);
                return sub[0] || null;
            }
            if (item && item.attribute && (item.op || item.value !== undefined)) {
                return {
                    attribute: String(item.attribute).trim(),
                    op: String(item.op || ':=').trim(),
                    value: String(item.value !== undefined ? item.value : '').trim().replace(/^["']|["']$/g, '')
                };
            }
            return null;
        }).filter(Boolean);
    }
    if (typeof input === 'object') {
        if (input.attribute) {
            return [{
                attribute: String(input.attribute).trim(),
                op: String(input.op || ':=').trim(),
                value: String(input.value !== undefined ? input.value : '').trim().replace(/^["']|["']$/g, '')
            }];
        }
        return [];
    }

    let str = String(input).trim();
    if (!str) return [];

    // JSON string parsing
    if (str.startsWith('[') || str.startsWith('{')) {
        try {
            const parsed = JSON.parse(str);
            return parseCustomRadiusAttributes(parsed);
        } catch (e) {}
    }

    // Replace literal escaped newlines '\n' with actual newlines
    str = str.replace(/\\n/g, '\n').replace(/\\r/g, '');

    // Split lines by newline first
    const rawLines = str.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const attrs = [];

    for (const rawLine of rawLines) {
        // Line can contain multiple attributes separated by semicolon or comma when followed by an attribute expression
        const segments = rawLine.split(/;|\s*,\s*(?=[A-Za-z0-9_.-]+\s*(?:[:=|+==!]=|=))/).map(s => s.trim()).filter(Boolean);

        for (const seg of segments) {
            const match = seg.match(/^([A-Za-z0-9_.-]+)\s*(:=|=|\+=|==|!=)\s*(.+)$/);
            if (match) {
                attrs.push({
                    attribute: match[1].trim(),
                    op: match[2].trim(),
                    value: match[3].trim().replace(/^["']|["']$/g, '')
                });
            } else if (seg.includes('=')) {
                const eqIdx = seg.indexOf('=');
                const attrName = seg.substring(0, eqIdx).trim();
                const val = seg.substring(eqIdx + 1).trim();
                if (attrName && val) {
                    attrs.push({
                        attribute: attrName,
                        op: '=',
                        value: val.replace(/^["']|["']$/g, '')
                    });
                }
            }
        }
    }
    return attrs;
}

const RADIUS_POOLS_SETTING_KEY = (ispId) => `isp:${ispId}:radiusPools`;

function normalizeRadiusPool(input) {
    const value = String(input?.value || input?.name || '').trim();
    if (!value) return null;
    return {
        id: value,
        name: String(input?.name || value).trim(),
        value,
        description: String(input?.description || '').trim(),
        type: String(input?.type || 'ipv4').trim().toLowerCase(),
        isActive: input?.isActive === undefined ? true : Boolean(input.isActive),
    };
}

async function getISPRadiusPools(prisma, ispId) {
    if (!prisma || !ispId) return [];
    try {
        const setting = await prisma.ISPSettings.findUnique({ where: { key: RADIUS_POOLS_SETTING_KEY(ispId) } });
        if (!setting?.value) return [];
        const parsed = JSON.parse(setting.value);
        return Array.isArray(parsed) ? parsed.map(normalizeRadiusPool).filter(Boolean) : [];
    } catch {
        return [];
    }
}

async function saveISPRadiusPools(prisma, ispId, pools) {
    if (!prisma || !ispId) return;
    try {
        const value = JSON.stringify(pools.map(normalizeRadiusPool).filter(Boolean));
        await prisma.ISPSettings.upsert({
            where: { key: RADIUS_POOLS_SETTING_KEY(ispId) },
            update: { value, description: 'RADIUS framed pool values', updatedAt: new Date() },
            create: { key: RADIUS_POOLS_SETTING_KEY(ispId), value, description: 'RADIUS framed pool values', ispId, updatedAt: new Date() }
        });
    } catch (e) {
        console.warn('[saveISPRadiusPools] Error saving radius pools:', e.message);
    }
}

/**
 * Resolves Framed Pool Value from various spreadsheet formats:
 * e.g. "Pool 2 (pool2)" -> value: "pool2", name: "Pool 2"
 * e.g. "Pool 1 (pool1)" -> value: "pool1", name: "Pool 1"
 * e.g. "pool2"          -> value: "pool2", name: "pool2"
 * e.g. "Pool 2"         -> matches existing pool named "Pool 2" to get its value "pool2", or "Pool 2"
 * Also auto-registers the pool in ISPSettings if not yet present so it works everywhere in UI and RADIUS!
 */
async function resolveFramedPool(prisma, ispId, rawInput, poolsCache = null) {
    if (!rawInput) return { value: null, name: null, apply: false };
    let str = String(rawInput).trim();
    if (!str || str.toLowerCase() === 'none' || str.toLowerCase() === 'null' || str === '-') {
        return { value: null, name: null, apply: false };
    }

    let pools = poolsCache;
    if (!pools && prisma && ispId) {
        pools = await getISPRadiusPools(prisma, ispId);
    }
    pools = pools || [];

    let extractedName = str;
    let extractedValue = str;

    // Check pattern: "Name (value)" or "Pool 2 (pool2)" or "Pool-Name (pool_code)"
    const parenMatch = str.match(/^(.*?)\s*\(([^)]+)\)$/);
    if (parenMatch) {
        extractedName = parenMatch[1].trim() || parenMatch[2].trim();
        extractedValue = parenMatch[2].trim();
    }

    // 1. Check if matches existing pool by value
    let matched = pools.find(p => p.value.toLowerCase() === extractedValue.toLowerCase());

    // 2. Check if matches existing pool by name
    if (!matched) {
        matched = pools.find(p => p.name.toLowerCase() === extractedName.toLowerCase() || p.name.toLowerCase() === str.toLowerCase());
    }

    // 3. Check if matches inside parentheses
    if (!matched && parenMatch) {
        matched = pools.find(p => p.value.toLowerCase() === parenMatch[2].trim().toLowerCase() || p.name.toLowerCase() === parenMatch[1].trim().toLowerCase());
    }

    if (matched) {
        return { value: matched.value, name: matched.name, apply: true };
    }

    // Auto-register in ISPSettings so the pool exists across the ISP system
    if (prisma && ispId && extractedValue) {
        try {
            const newPool = {
                id: extractedValue,
                name: extractedName || extractedValue,
                value: extractedValue,
                description: `Imported Framed Pool ${extractedName}`,
                type: 'ipv4',
                isActive: true
            };
            const nextPools = pools.filter(p => p.value.toLowerCase() !== extractedValue.toLowerCase());
            nextPools.push(newPool);
            await saveISPRadiusPools(prisma, ispId, nextPools);
            pools.push(newPool);
        } catch (regErr) {
            console.warn('[resolveFramedPool] Auto-register warning:', regErr.message);
        }
    }

    return { value: extractedValue, name: extractedName, apply: true };
}

function isAllReference(value, type) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return false;
    if (['all', 'global'].includes(normalized)) return true;
    return type === 'organization'
        ? /^all\s+organizations?$/.test(normalized)
        : /^all\s+branches$/.test(normalized);
}

function splitBranchReferences(value) {
    if (Array.isArray(value)) return value.flatMap(splitBranchReferences);
    return String(value || '')
        .replace(/\\n/g, '\n')
        .split(/[\r\n,;]+/)
        .map(item => item.trim())
        .filter(Boolean);
}

async function findHierarchyBranchByName(prisma, ispId, name, parentConstraint = undefined) {
    const normalizedName = String(name || '').trim();
    if (!normalizedName) return null;

    const scope = {
        ...(ispId ? { ispId: Number(ispId) } : {}),
        isDeleted: false
    };

    // 1. If specific parent ID(s) provided, check under those parents
    if (parentConstraint !== undefined && parentConstraint !== null) {
        const parentWhere = Array.isArray(parentConstraint)
            ? { parentId: { in: parentConstraint } }
            : { parentId: parentConstraint };

        // 1a. Exact match under parent(s)
        let branch = await prisma.Branch.findFirst({
            where: { ...scope, ...parentWhere, name: normalizedName },
            select: { id: true, name: true, parentId: true }
        });
        if (branch) return branch;

        // 1b. Fuzzy / Prefix match under parent(s) (e.g. "Bigu Arrownet" vs "Bigu Rural Municipality Dolakha")
        const firstWord = normalizedName.split(/\s+/)[0];
        if (firstWord && firstWord.length >= 4) {
            branch = await prisma.Branch.findFirst({
                where: { ...scope, ...parentWhere, name: { startsWith: firstWord } },
                select: { id: true, name: true, parentId: true }
            });
            if (branch) return branch;
        }
    }

    // 2. Exact match (Head branch or Any branch)
    let branch = await prisma.Branch.findFirst({
        where: { ...scope, name: normalizedName },
        select: { id: true, name: true, parentId: true }
    });
    if (branch) return branch;

    // 3. Substring / Prefix match across DB
    const firstWord = normalizedName.split(/\s+/)[0];
    if (firstWord && firstWord.length >= 4) {
        branch = await prisma.Branch.findFirst({
            where: { ...scope, name: { startsWith: firstWord } },
            select: { id: true, name: true, parentId: true }
        });
        if (branch) return branch;
    }

    return null;
}

/**
 * Resolve the two Internet Plan hierarchy columns independently.
 * Supports comma/newline/semicolon-separated multiple organizations and multiple sub-branches.
 * Automatically resolves and links organizations and branches, creating missing ones if needed.
 */
async function resolvePlanOrganizationBranches(prisma, ispId, rawOrganization, rawBranch) {
    const orgTokens = splitBranchReferences(rawOrganization);
    const branchTokens = splitBranchReferences(rawBranch);
    const hasOrganization = orgTokens.length > 0;
    const hasBranch = branchTokens.length > 0;

    if (!hasOrganization && !hasBranch) {
        return { ids: [], organization: null, organizations: [], branches: [], hasInput: false, allOrganizations: false };
    }

    const baseWhere = {
        ...(ispId ? { ispId: Number(ispId) } : {}),
        isDeleted: false
    };
    const select = { id: true, name: true, parentId: true };

    const resolvedIds = new Set();
    const resolvedOrganizations = [];
    const resolvedBranches = [];
    let isAllOrg = false;

    // 1. Resolve Organizations (supports comma-separated list of organizations)
    if (hasOrganization) {
        for (const orgName of orgTokens) {
            if (isAllReference(orgName, 'organization')) {
                isAllOrg = true;
                const allHeadBranches = await prisma.Branch.findMany({
                    where: { ...baseWhere, parentId: null },
                    select
                });
                for (const hb of allHeadBranches) {
                    resolvedIds.add(hb.id);
                    resolvedOrganizations.push(hb);
                }
                continue;
            }

            // Find existing head branch or any branch
            let org = await findHierarchyBranchByName(prisma, ispId, orgName, null);
            if (!org) {
                // Check if it exists as any branch (e.g. sub-branch given in org column)
                org = await findHierarchyBranchByName(prisma, ispId, orgName, undefined);
            }

            if (!org) {
                // Auto-create missing Head Branch so import succeeds smoothly
                const orgCode = await generateUniqueBranchCode(prisma, ispId, orgName, false);
                org = await prisma.Branch.create({
                    data: {
                        name: orgName,
                        code: orgCode,
                        isActive: true,
                        isDeleted: false,
                        parentId: null,
                        ispId: ispId ? Number(ispId) : 1
                    },
                    select
                });
            }

            if (org) {
                resolvedIds.add(org.id);
                resolvedOrganizations.push(org);
            }
        }
    }

    const parentIds = resolvedOrganizations.map(o => o.id);

    // 2. Resolve Branches / Sub-branches (supports comma-separated list of branches)
    if (hasBranch) {
        for (const branchName of branchTokens) {
            if (isAllReference(branchName, 'branch')) {
                const subBranches = await prisma.Branch.findMany({
                    where: {
                        ...baseWhere,
                        ...(parentIds.length > 0 ? { parentId: { in: parentIds } } : { parentId: { not: null } })
                    },
                    select
                });
                for (const sb of subBranches) {
                    resolvedIds.add(sb.id);
                    resolvedBranches.push(sb);
                }
                continue;
            }

            // Look under resolved parent organizations first
            let branch = await findHierarchyBranchByName(prisma, ispId, branchName, parentIds.length > 0 ? parentIds : undefined);
            if (!branch) {
                // Search anywhere in DB
                branch = await findHierarchyBranchByName(prisma, ispId, branchName, undefined);
            }

            if (!branch) {
                // Auto-create missing Sub-Branch under the primary parent org (if available) or standalone
                const parentId = parentIds.length > 0 ? parentIds[0] : null;
                const branchCode = await generateUniqueBranchCode(prisma, ispId, branchName, Boolean(parentId));
                branch = await prisma.Branch.create({
                    data: {
                        name: branchName,
                        code: branchCode,
                        isActive: true,
                        isDeleted: false,
                        parentId,
                        ispId: ispId ? Number(ispId) : 1
                    },
                    select
                });
            }

            if (branch) {
                resolvedIds.add(branch.id);
                resolvedBranches.push(branch);
            }
        }
    }

    const primaryOrg = resolvedOrganizations.length > 0 ? resolvedOrganizations[0] : null;

    return {
        ids: Array.from(resolvedIds),
        organization: primaryOrg,
        organizations: resolvedOrganizations,
        branches: resolvedBranches,
        hasInput: true,
        allOrganizations: isAllOrg
    };
}

// ==========================================
// 1. IMPORT BRANCHES & SUB-BRANCHES
// ==========================================
async function importBranches(req, res, next) {
    const prisma = req.prisma;
    const ispId = req.ispId ? Number(req.ispId) : null;
    const { items = [], skipExisting = false } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'No branch items provided for import' });
    }

    const logs = [];
    let successCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    const parentBranchCache = new Map();

    for (let i = 0; i < items.length; i++) {
        const rowNumber = i + 1;
        const row = items[i] || {};

        const rawBranchName = (row.branch || row.branchName || row.parentBranch || row.organization || row['Branch Name'] || row.HeadBranch || row.Organization || '').toString().trim();
        const rawSubBranchName = (row.subBranch || row.subBranchName || row['Sub-Branch Name'] || row.SubBranch || row.sub_branch || row.childBranch || '').toString().trim();

        if (!rawBranchName && !rawSubBranchName) {
            logs.push({
                rowNumber,
                name: 'Empty Row',
                status: 'skipped',
                message: 'Row skipped: Both Branch Name and Sub-Branch Name are empty.'
            });
            skippedCount++;
            continue;
        }

        const branchName = rawBranchName || rawSubBranchName;
        const subBranchName = rawSubBranchName;

        try {
            let parentBranch = parentBranchCache.get(branchName.toLowerCase());
            let isParentNewlyCreated = false;

            if (!parentBranch) {
                parentBranch = await prisma.Branch.findFirst({
                    where: {
                        name: branchName,
                        parentId: null,
                        ...(ispId ? { ispId } : {}),
                        isDeleted: false
                    }
                });

                if (!parentBranch) {
                    const branchCode = (row.code || row.branchCode || row['Branch Code'])
                        ? slugify(row.code || row.branchCode || row['Branch Code'])
                        : await generateUniqueBranchCode(prisma, ispId, branchName, false);

                    parentBranch = await prisma.Branch.create({
                        data: {
                            name: branchName,
                            code: branchCode,
                            phoneNumber: (row.phoneNumber || row.phone || row.contact || row['Phone Number'] || '').toString().trim() || null,
                            email: (row.email || row['Email'] || '').toString().trim() || null,
                            address: (row.address || row['Address'] || '').toString().trim() || null,
                            city: (row.city || row['City'] || '').toString().trim() || null,
                            state: (row.state || row.province || row['State'] || row['Province'] || '').toString().trim() || null,
                            contactPerson: (row.contactPerson || row.manager || row['Contact Person'] || '').toString().trim() || null,
                            isActive: true,
                            isDeleted: false,
                            parentId: null,
                            ispId: ispId || 1
                        }
                    });
                    isParentNewlyCreated = true;
                } else if (!skipExisting) {
                    await prisma.Branch.update({
                        where: { id: parentBranch.id },
                        data: {
                            phoneNumber: (row.phoneNumber || row.phone || row.contact || row['Phone Number'] || parentBranch.phoneNumber || '').toString().trim() || null,
                            email: (row.email || row['Email'] || parentBranch.email || '').toString().trim() || null,
                            address: (row.address || row['Address'] || parentBranch.address || '').toString().trim() || null,
                            city: (row.city || row['City'] || parentBranch.city || '').toString().trim() || null,
                            state: (row.state || row.province || row['State'] || row['Province'] || parentBranch.state || '').toString().trim() || null,
                            contactPerson: (row.contactPerson || row.manager || row['Contact Person'] || parentBranch.contactPerson || '').toString().trim() || null,
                            updatedAt: new Date()
                        }
                    });
                }
                parentBranchCache.set(branchName.toLowerCase(), parentBranch);
            }

            if (subBranchName) {
                let subBranch = await prisma.Branch.findFirst({
                    where: {
                        name: subBranchName,
                        parentId: parentBranch.id,
                        ...(ispId ? { ispId } : {}),
                        isDeleted: false
                    }
                });

                if (subBranch) {
                    if (skipExisting) {
                        logs.push({
                            rowNumber,
                            name: `${branchName} > ${subBranchName}`,
                            status: 'skipped',
                            message: `Sub-Branch '${subBranchName}' already exists under '${branchName}' (ID: ${subBranch.id}, Code: ${subBranch.code}).`
                        });
                        skippedCount++;
                    } else {
                        await prisma.Branch.update({
                            where: { id: subBranch.id },
                            data: {
                                phoneNumber: (row.subPhoneNumber || row.phoneNumber || row.phone || row['Sub-Branch Phone'] || subBranch.phoneNumber || '').toString().trim() || null,
                                email: (row.subEmail || row.email || row['Sub-Branch Email'] || subBranch.email || '').toString().trim() || null,
                                address: (row.subAddress || row.address || row['Sub-Branch Address'] || subBranch.address || '').toString().trim() || null,
                                city: (row.subCity || row.city || row['Sub-Branch City'] || subBranch.city || '').toString().trim() || null,
                                state: (row.subState || row.state || row['Sub-Branch State'] || subBranch.state || '').toString().trim() || null,
                                contactPerson: (row.subContactPerson || row.contactPerson || row['Sub-Branch Contact Person'] || subBranch.contactPerson || '').toString().trim() || null,
                                updatedAt: new Date()
                            }
                        });

                        logs.push({
                            rowNumber,
                            name: `${branchName} > ${subBranchName}`,
                            status: 'success',
                            message: `✓ Sub-Branch '${subBranchName}' verified/updated under '${branchName}' (ID: ${subBranch.id}, Code: ${subBranch.code}).`
                        });
                        successCount++;
                    }
                } else {
                    const subCode = (row.subBranchCode || row.subCode || row['Sub-Branch Code'])
                        ? slugify(row.subBranchCode || row.subCode || row['Sub-Branch Code'])
                        : await generateUniqueBranchCode(prisma, ispId, subBranchName, true);

                    subBranch = await prisma.Branch.create({
                        data: {
                            name: subBranchName,
                            code: subCode,
                            phoneNumber: (row.subPhoneNumber || row.phoneNumber || row.phone || row['Sub-Branch Phone'] || '').toString().trim() || parentBranch.phoneNumber,
                            email: (row.subEmail || row.email || row['Sub-Branch Email'] || '').toString().trim() || parentBranch.email,
                            address: (row.subAddress || row.address || row['Sub-Branch Address'] || '').toString().trim() || parentBranch.address,
                            city: (row.subCity || row.city || row['Sub-Branch City'] || '').toString().trim() || parentBranch.city,
                            state: (row.subState || row.state || row['Sub-Branch State'] || '').toString().trim() || parentBranch.state,
                            contactPerson: (row.subContactPerson || row.contactPerson || row['Sub-Branch Contact Person'] || '').toString().trim() || parentBranch.contactPerson,
                            isActive: true,
                            isDeleted: false,
                            parentId: parentBranch.id,
                            ispId: ispId || 1
                        }
                    });

                    logs.push({
                        rowNumber,
                        name: `${branchName} > ${subBranchName}`,
                        status: 'success',
                        message: `✓ Created Sub-Branch '${subBranchName}' (ID: ${subBranch.id}, Code: ${subBranch.code}) under Head Branch '${branchName}' (ID: ${parentBranch.id}).`
                    });
                    successCount++;
                }
            } else {
                logs.push({
                    rowNumber,
                    name: branchName,
                    status: 'success',
                    message: isParentNewlyCreated
                        ? `✓ Created Head Branch '${branchName}' (ID: ${parentBranch.id}, Code: ${parentBranch.code}).`
                        : `✓ Verified Head Branch '${branchName}' (ID: ${parentBranch.id}, Code: ${parentBranch.code}).`
                });
                successCount++;
            }
        } catch (err) {
            console.error(`Error importing branch row ${rowNumber}:`, err);
            logs.push({
                rowNumber,
                name: `${branchName}${subBranchName ? ` > ${subBranchName}` : ''}`,
                status: 'failed',
                message: `Failed: ${err.message}`
            });
            failedCount++;
        }
    }

    res.json({
        success: true,
        total: items.length,
        successCount,
        skippedCount,
        failedCount,
        logs
    });
}

// ==========================================
// 2. IMPORT INTERNET PLANS (BASE PLANS & RADIUS)
// ==========================================
async function importPlans(req, res, next) {
    const prisma = req.prisma;
    const ispId = req.ispId ? Number(req.ispId) : null;
    const { items = [], syncRadius = true, skipExisting = false } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'No internet plan items provided for import' });
    }

    let targetIspId = ispId;
    if (!targetIspId) {
        const firstIsp = await prisma.ISP.findFirst({ select: { id: true } });
        targetIspId = firstIsp ? firstIsp.id : 1;
    }

    let radiusClient = null;
    if (syncRadius && targetIspId) {
        try {
            radiusClient = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, targetIspId);
        } catch (rErr) {
            try {
                const { RadiusClient } = require('../services/radiusClient');
                radiusClient = await RadiusClient.create(targetIspId);
            } catch (rErr2) {
                console.warn('[IMPORT PLANS] FreeRADIUS client not available:', rErr2.message || rErr.message);
            }
        }
    }

    let defaultConnectionType = await prisma.ConnectionType.findFirst({
        where: {
            isDeleted: false,
            ...(ispId ? { OR: [{ ispId }, { ispId: null }] } : {})
        }
    });

    if (!defaultConnectionType) {
        defaultConnectionType = await prisma.ConnectionType.create({
            data: {
                name: 'Fiber',
                code: 'FIBER',
                isActive: true,
                isDeleted: false,
                ispId: ispId || 1
            }
        });
    }

    const connectionTypeCache = new Map();
    const existingRadiusPools = await getISPRadiusPools(prisma, targetIspId);
    const logs = [];
    let successCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (let i = 0; i < items.length; i++) {
        const rowNumber = i + 1;
        const row = items[i] || {};

        const rawPlanName = (row.planName || row.name || row.packageName || row['Plan Name'] || row['Package Name'] || '').toString().trim();
        if (!rawPlanName) {
            logs.push({
                rowNumber,
                name: 'Empty Plan Name',
                status: 'skipped',
                message: 'Row skipped: Plan Name is required.'
            });
            skippedCount++;
            continue;
        }

        try {
            const rawPlanCode = (row.planCode || row.code || row['Plan Code'] || '').toString().trim();
            const planCode = rawPlanCode ? slugify(rawPlanCode) : await generateUniquePlanCode(prisma, ispId, rawPlanName);

            // 1. Connection Type Resolution
            const rawConnType = String(getFirstRowValue(row, ['connectionType', 'type', 'Connection Type'], 'Fiber')).trim();
            let connectionTypeId = defaultConnectionType.id;

            if (rawConnType) {
                if (!isNaN(rawConnType) && Number(rawConnType) > 0) {
                    connectionTypeId = Number(rawConnType);
                } else {
                    const ctKey = rawConnType.toLowerCase();
                    if (connectionTypeCache.has(ctKey)) {
                        connectionTypeId = connectionTypeCache.get(ctKey);
                    } else {
                        let ct = await prisma.ConnectionType.findFirst({
                            where: {
                                OR: [
                                    { name: { contains: rawConnType } },
                                    { code: { contains: rawConnType } }
                                ],
                                isDeleted: false,
                                ...(ispId ? { OR: [{ ispId }, { ispId: null }] } : {})
                            }
                        });
                        if (!ct) {
                            ct = await prisma.ConnectionType.create({
                                data: {
                                    name: rawConnType,
                                    code: slugify(rawConnType),
                                    isActive: true,
                                    isDeleted: false,
                                    ispId: ispId || 1
                                }
                            });
                        }
                        connectionTypeId = ct.id;
                        connectionTypeCache.set(ctKey, connectionTypeId);
                    }
                }
            }

            // 2. Speeds & Bandwidth Parsing
            const speedInput = getFirstRowValue(
                row,
                ['downSpeed', 'speed', 'bandwidth', 'Download Speed (Mbps)', 'Speed (Mbps)'],
                rawPlanName
            );
            const downSpeed = extractSpeedMbps(speedInput);
            const upSpeedValue = getFirstRowValue(row, ['upSpeed', 'Upload Speed (Mbps)']);
            const upSpeed = upSpeedValue !== undefined ? extractSpeedMbps(upSpeedValue) : downSpeed;
            const intUploadValue = getFirstRowValue(row, ['intUpload', 'INT Upload']);
            const firDownloadValue = getFirstRowValue(row, ['firDownload', 'FIR Download']);
            const localUploadValue = getFirstRowValue(row, ['localUpload', 'Local Upload']);
            const localDownloadValue = getFirstRowValue(row, ['localDownload', 'Local Download']);
            const dataLimitValue = getFirstRowValue(row, ['dataLimit', 'Data Limit']);
            const intUpload = intUploadValue !== undefined ? extractSpeedMbps(intUploadValue) : upSpeed;
            const firDownload = firDownloadValue !== undefined ? extractSpeedMbps(firDownloadValue) : downSpeed;
            const localUpload = localUploadValue !== undefined ? extractSpeedMbps(localUploadValue) : upSpeed;
            const localDownload = localDownloadValue !== undefined ? extractSpeedMbps(localDownloadValue) : downSpeed;
            const dataLimit = dataLimitValue !== undefined ? Number(dataLimitValue) || 0 : 0;

            // 3. Technical Parameters & Framed Pool Resolution
            const rawNasType = String(getFirstRowValue(row, ['nasType', 'NAS Type'], 'mikrotik')).toLowerCase();
            const rawNasList = rawNasType.split(/[,;\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
            if (rawNasList.length === 0) rawNasList.push('mikrotik');

            const service = String(getFirstRowValue(row, ['service', 'Service', 'Service Type'], 'Internet')).trim();
            const priority = String(getFirstRowValue(row, ['priority', 'Priority'], '1')).trim();
            const packageType = String(getFirstRowValue(row, ['packageType', 'Package Type'], 'HOME')).trim().toUpperCase();
            const description = String(getFirstRowValue(row, ['description', 'Description'], `${rawPlanName} - ${downSpeed} Mbps High Speed Internet`));
            const allowRename = parseBooleanValue(getFirstRowValue(row, ['allowRename', 'Allow Rename']), false);
            const fupApply = parseBooleanValue(getFirstRowValue(row, ['fupApply', 'FUP Apply']), true);
            const fupLimitGb = Number(getFirstRowValue(row, ['fupLimitGb', 'FUP Limit (GB)'], 0)) || 0;
            const isFupPackage = parseBooleanValue(getFirstRowValue(row, ['isFupPackage', 'Is FUP Package']), false);
            const onlyRenewal = parseBooleanValue(getFirstRowValue(row, ['onlyRenewal', 'Only Renewal']), false);
            const isPopular = parseBooleanValue(getFirstRowValue(row, ['isPopular', 'Popular']), false);
            const highPriority = parseBooleanValue(getFirstRowValue(row, ['highPriority', 'High Priority']), false);

            // Resolve Framed Pool (e.g. 'Pool 2 (pool2)', 'pool2', 'Pool 2')
            const rawApplyPool = getFirstRowValue(row, ['applyFramedPool', 'Apply Framed Pool', 'apply_framed_pool']);
            const rawPoolInput = getFirstRowValue(
                row,
                ['framedPoolValue', 'Framed Pool Value', 'framedPool', 'Framed Pool', 'pool', 'Pool', 'framed_pool_value'],
                ''
            );

            const resolvedPool = await resolveFramedPool(prisma, targetIspId, rawPoolInput, existingRadiusPools);
            const framedPoolValue = resolvedPool.value;
            const applyFramedPool = rawApplyPool !== undefined && rawApplyPool !== ''
                ? (String(rawApplyPool).toLowerCase() === 'true' || String(rawApplyPool) === '1' || String(rawApplyPool).toLowerCase() === 'yes')
                : Boolean(framedPoolValue);

            const maxDiscountPercentage = row.maxDiscountPercentage !== undefined && row.maxDiscountPercentage !== '' ? Number(row.maxDiscountPercentage || row['Max Discount Percentage (%)']) : 100;
            const maxDiscountCount = row.maxDiscountCount !== undefined && row.maxDiscountCount !== '' ? Number(row.maxDiscountCount || row['Max Discount Count Per Month']) : 0;

            // 4. Vendor Profiles & Custom Radius Attributes
            let vendorProfiles = parseVendorProfiles(getFirstRowValue(row, ['vendorProfiles', 'Vendor-Specific Profiles', 'vendor_profiles'], ''));
            const customRadiusAttributes = parseCustomRadiusAttributes(getFirstRowValue(row, ['customRadiusAttributes', 'Custom Radius Attributes', 'custom_radius_attributes'], ''));

            // Auto-populate / sync vendor profiles and NAS list so all selected vendors (e.g. mikrotik, juniper) are preserved
            const nasSet = new Set(rawNasList);
            for (const vp of vendorProfiles) {
                if (vp.vendor) nasSet.add(vp.vendor.toLowerCase());
            }
            if (nasSet.has('juniper') && !vendorProfiles.some(vp => vp.vendor === 'juniper')) {
                vendorProfiles.push({ vendor: 'juniper', profile: 'xFTTH-pp0' });
            }
            if (nasSet.has('nokia') && !vendorProfiles.some(vp => vp.vendor === 'nokia')) {
                vendorProfiles.push({ vendor: 'nokia', profile: `pkg-${downSpeed || 0}mbps` });
            }
            if (nasSet.has('cisco') && !vendorProfiles.some(vp => vp.vendor === 'cisco')) {
                vendorProfiles.push({ vendor: 'cisco', profile: 'cisco-default' });
            }
            const cleanNasType = Array.from(nasSet).join(',');

            // 5. FUP Penalty Plan Resolution
            let fupPenaltyPlanId = null;
            const rawPenaltyPlan = (row.fupPenaltyPlan || row['FUP Penalty Plan'] || row.fupPenaltyPlanId || '').toString().trim();
            if (rawPenaltyPlan) {
                if (!isNaN(rawPenaltyPlan) && Number(rawPenaltyPlan) > 0) {
                    fupPenaltyPlanId = Number(rawPenaltyPlan);
                } else {
                    const penaltyPlanRec = await prisma.PackagePlan.findFirst({
                        where: {
                            OR: [
                                { planName: rawPenaltyPlan },
                                { planCode: rawPenaltyPlan }
                            ],
                            ...(ispId ? { ispId } : {}),
                            isDeleted: false
                        }
                    });
                    if (penaltyPlanRec) fupPenaltyPlanId = penaltyPlanRec.id;
                }
            }

            // 6. Check existing plan
            let plan = await prisma.PackagePlan.findFirst({
                where: {
                    OR: [
                        { planCode },
                        { planName: rawPlanName }
                    ],
                    ...(ispId ? { ispId } : {}),
                    isDeleted: false
                }
            });

            if (plan && skipExisting) {
                logs.push({
                    rowNumber,
                    name: rawPlanName,
                    status: 'skipped',
                    message: `Plan '${rawPlanName}' (${plan.planCode}) already exists in database.`
                });
                skippedCount++;
                continue;
            }

            // Resolve the two hierarchy columns before writing the plan. This
            // prevents partially importing a plan when its parent/child
            // relationship is invalid or ambiguous.
            const rawOrganization = getFirstRowValue(
                row,
                ['organization', 'Organization', 'Organization Name', 'Head Branch', 'org'],
                ''
            );
            const rawBranch = getFirstRowValue(
                row,
                ['branch', 'Branch', 'branches', 'Branches', 'Branch Name', 'Sub-Branches', 'Sub Branches', 'Sub-Branch', 'subBranch'],
                ''
            );
            const branchResolution = await resolvePlanOrganizationBranches(
                prisma,
                targetIspId,
                rawOrganization,
                rawBranch
            );
            const resolvedBranchIds = branchResolution.ids;

            const planPayload = {
                planName: rawPlanName,
                planCode,
                connectionType: connectionTypeId,
                downSpeed,
                upSpeed,
                intUpload,
                firDownload,
                localUpload,
                localDownload,
                dataLimit,
                service,
                nasType: cleanNasType,
                priority,
                packageType,
                allowRename,
                fupApply,
                fupLimitGb,
                fupPenaltyPlanId,
                isFupPackage,
                onlyRenewal,
                isPopular,
                highPriority,
                applyFramedPool,
                framedPoolValue,
                vendorProfiles: vendorProfiles.length > 0 ? vendorProfiles : null,
                customRadiusAttributes: customRadiusAttributes.length > 0 ? customRadiusAttributes : null,
                maxDiscountPercentage,
                maxDiscountCount,
                description,
                isActive: true,
                isDeleted: false,
                ispId: ispId || 1
            };

            if (!plan) {
                plan = await prisma.PackagePlan.create({ data: planPayload });
            } else {
                plan = await prisma.PackagePlan.update({
                    where: { id: plan.id },
                    data: {
                        ...planPayload,
                        updatedAt: new Date()
                    }
                });
            }

            // 7. Link the verified parent organization and only its verified
            // child branch(es). Omitted columns preserve existing mappings.
            if (branchResolution.hasInput) {
                await prisma.PackagePlanBranch.deleteMany({ where: { packagePlanId: plan.id } });
                if (resolvedBranchIds.length > 0) {
                    await prisma.PackagePlanBranch.createMany({
                        data: resolvedBranchIds.map(bId => ({ packagePlanId: plan.id, branchId: Number(bId) })),
                        skipDuplicates: true
                    });
                }
            }

            // 8. FreeRADIUS Multi-Vendor Group Configuration
            let radiusSyncMessage = 'FreeRADIUS not configured';
            if (radiusClient) {
                try {
                    await radiusClient.createRadgroupcheck({
                        groupname: plan.planCode,
                        attribute: 'Auth-Type',
                        op: ':=',
                        value: 'Accept'
                    }).catch(() => null);

                    const nasList = (cleanNasType || '').split(',').map(s => s.trim().toLowerCase());
                    const replyAttributes = [];

                    // MikroTik
                    if (nasList.includes('mikrotik') || nasList.length === 0 || nasType === '') {
                        replyAttributes.push(
                            { attribute: 'Mikrotik-Rate-Limit', op: ':=', value: formatMikrotikRateLimit(upSpeed, downSpeed, priority || 8) },
                            { attribute: 'Framed-Protocol', op: ':=', value: 'PPP' },
                            { attribute: 'Service-Type', op: ':=', value: 'Framed-User' }
                        );
                    }

                    // Juniper
                    if (nasList.includes('juniper') || vendorProfiles.some(vp => (vp.vendor || '').toLowerCase() === 'juniper')) {
                        const burstBytes = calculateJuniperBurstBytes(downSpeed || upSpeed);
                        const jProfile = vendorProfiles.find(vp => (vp.vendor || '').toLowerCase() === 'juniper')?.profile || 'xFTTH-pp0';
                        replyAttributes.push(
                            { attribute: 'ERX-Client-Profile-Name', op: '=', value: jProfile },
                            { attribute: 'ERX-Service-Description', op: '+=', value: `bandwidth=${downSpeed || upSpeed}m` },
                            { attribute: 'ERX-Service-Description', op: '+=', value: `burst=${burstBytes}` },
                            { attribute: 'ERX-IPv6-Delegated-Pool-Name', op: ':=', value: 'v6-default-pd' },
                            { attribute: 'Framed-IPv6-Pool', op: ':=', value: 'v6-ndra' }
                        );
                    }

                    // Nokia
                    if (nasList.includes('nokia') || vendorProfiles.some(vp => (vp.vendor || '').toLowerCase() === 'nokia')) {
                        const egressRate = downSpeed * 1000;
                        const ingressRate = upSpeed * 1000;
                        replyAttributes.push(
                            { attribute: 'Alc-Subscriber-Qos-Override', op: '+=', value: `E:Q:1:pir=${egressRate},cir=${egressRate}` },
                            { attribute: 'Alc-Subscriber-Qos-Override', op: '+=', value: `I:Q:1:pir=${ingressRate},cir=${ingressRate}` }
                        );
                    }

                    // Cisco
                    if (nasList.includes('cisco') || vendorProfiles.some(vp => (vp.vendor || '').toLowerCase() === 'cisco')) {
                        const cProfile = vendorProfiles.find(vp => (vp.vendor || '').toLowerCase() === 'cisco')?.profile || 'cisco-default';
                        replyAttributes.push(
                            { attribute: 'Cisco-AVPair', op: '+=', value: `ip:sub-profile-name=${cProfile}` }
                        );
                    }

                    // Framed-Pool
                    if (applyFramedPool && framedPoolValue) {
                        replyAttributes.push({ attribute: 'Framed-Pool', op: ':=', value: framedPoolValue });
                    }

                    // Custom Radius Attributes (e.g. ERX-IPv6-Delegated-Pool-Name := v6-default-pd, Framed-IPv6-Pool := v6-ndra)
                    if (Array.isArray(customRadiusAttributes)) {
                        for (const customAttr of customRadiusAttributes) {
                            if (customAttr && customAttr.attribute && customAttr.value !== undefined) {
                                replyAttributes.push({
                                    attribute: customAttr.attribute.trim(),
                                    op: customAttr.op ? customAttr.op.trim() : ':=',
                                    value: String(customAttr.value).trim()
                                });
                            }
                        }
                    }

                    let firstReplyId = null;
                    for (const attr of replyAttributes) {
                        try {
                            const res = await radiusClient.createRadgroupreply({
                                groupname: plan.planCode,
                                ...attr
                            });
                            if (!firstReplyId && res?.id) firstReplyId = res.id;
                        } catch (attrErr) {}
                    }

                    if (firstReplyId) {
                        await prisma.PackagePlan.update({
                            where: { id: plan.id },
                            data: { radgroupreplyId: firstReplyId }
                        });
                    }

                    radiusSyncMessage = `FreeRADIUS Synced (Group: ${plan.planCode}, Rate: ${upSpeed}M/${downSpeed}M, NAS: ${nasType})`;
                } catch (rSyncErr) {
                    radiusSyncMessage = `FreeRADIUS Warning: ${rSyncErr.message}`;
                }
            }

            const branchInfo = branchResolution.allOrganizations
                ? `Linked All Organizations${branchResolution.branches.length > 0 ? ' & All Branches' : ''} (${resolvedBranchIds.length})`
                : (branchResolution.organizations && branchResolution.organizations.length > 0)
                    ? `Organizations: ${branchResolution.organizations.length} (${branchResolution.organizations.map(o => o.name).join(', ')}) | Branches: ${branchResolution.branches.length}`
                    : branchResolution.organization
                        ? `Organization: ${branchResolution.organization.name} | Branches: ${branchResolution.branches.length}`
                        : 'Organization/Branch not supplied';
            const poolInfo = framedPoolValue ? `Framed Pool: ${framedPoolValue}` : 'No Pool';

            logs.push({
                rowNumber,
                name: rawPlanName,
                status: 'success',
                message: `✓ Internet Plan '${rawPlanName}' (${plan.planCode}) ensured | Speed: ${downSpeed}M/${upSpeed}M | ${poolInfo} | Type: ${packageType} | ${branchInfo} | ✓ ${radiusSyncMessage}`
            });
            successCount++;

        } catch (err) {
            console.error(`Error importing plan row ${rowNumber}:`, err);
            logs.push({
                rowNumber,
                name: rawPlanName,
                status: 'failed',
                message: `Failed: ${err.message}`
            });
            failedCount++;
        }
    }

    res.json({
        success: true,
        total: items.length,
        successCount,
        skippedCount,
        failedCount,
        logs
    });
}

// ==========================================
// 3. IMPORT PACKAGES & TARIFF RATES (PRICES)
// ==========================================
/**
 * Helper to parse boolean string or value
 */
function parseBooleanValue(val, defaultVal = false) {
    if (val === undefined || val === null || val === '') return defaultVal;
    if (typeof val === 'boolean') return val;
    const str = String(val).trim().toLowerCase();
    if (['true', '1', 'yes', 'enabled', 'active', 'y'].includes(str)) return true;
    if (['false', '0', 'no', 'disabled', 'inactive', 'n'].includes(str)) return false;
    return defaultVal;
}

/**
 * Universal Item Matcher for Package Addon Charges (OneTimeCharge)
 * Matches by ID, Code, ReferenceId, Exact Name, Normalized Name, or Substring
 */
function findMatchingAddon(rawKey, addonList) {
    if (!rawKey || !Array.isArray(addonList) || addonList.length === 0) return null;
    const clean = String(rawKey).trim();
    if (!clean) return null;

    // 1. Direct numeric ID match
    if (/^\d+$/.test(clean)) {
        const byId = addonList.find(a => a.id === Number(clean));
        if (byId) return byId;
    }

    const lower = clean.toLowerCase();

    // 2. Direct match by code, name, or referenceId
    let match = addonList.find(a => 
        (a.code && a.code.toLowerCase() === lower) || 
        (a.name && a.name.toLowerCase() === lower) || 
        (a.referenceId && a.referenceId.toLowerCase() === lower)
    );
    if (match) return match;

    // 3. Normalized alphanumeric match (stripping spaces, symbols, and words like 'charge', 'fee')
    const normalize = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const normKey = normalize(clean);
    if (!normKey) return null;

    match = addonList.find(a => 
        (a.code && normalize(a.code) === normKey) || 
        (a.name && normalize(a.name) === normKey) || 
        (a.referenceId && normalize(a.referenceId) === normKey)
    );
    if (match) return match;

    // 4. Substring / containment match
    match = addonList.find(a => {
        const nName = normalize(a.name);
        const nCode = normalize(a.code);
        return (nName && (normKey.includes(nName) || nName.includes(normKey))) ||
               (nCode && (normKey === nCode || normKey.includes(nCode)));
    });
    if (match) return match;

    return null;
}

/**
 * Helper to parse a list of items from string or object
 * Supports:
 * - "Internet: 500, Support And Maintance: 500, Drop Wire: 0, Douplex Router: 0"
 * - "INT: 500; SM: 500; DW: 0; DR: 0"
 * - "INT=500, SM=500"
 * - { INT: 500, SM: 500 }
 */
function parseItemsList(rawVal, allAddonCharges) {
    const items = [];
    if (!rawVal) return items;

    if (typeof rawVal === 'object') {
        for (const [k, v] of Object.entries(rawVal)) {
            const matched = findMatchingAddon(k, allAddonCharges);
            if (matched) {
                const amt = parseFloat(v);
                items.push({ addon: matched, amount: isNaN(amt) ? (matched.amount || 0) : amt });
            }
        }
        return items;
    }

    const str = String(rawVal).trim();
    if (!str) return items;

    // Split by commas, semicolons, pipes, or newlines
    const entries = str.split(/[\n\r,;|]+/).map(s => s.trim()).filter(Boolean);
    for (const entry of entries) {
        let k = '', v = '0';
        if (entry.includes(':') || entry.includes('=')) {
            const parts = entry.split(/[:=]+/);
            k = parts[0]?.trim() || '';
            v = parts.slice(1).join(':').trim();
        } else {
            const numMatch = entry.match(/^(.*?)\s+([\d.]+)$/);
            if (numMatch) {
                k = numMatch[1].trim();
                v = numMatch[2].trim();
            } else {
                k = entry;
                v = '0';
            }
        }

        if (k) {
            const matched = findMatchingAddon(k, allAddonCharges);
            if (matched) {
                const parsedAmt = parseFloat(v);
                const finalAmt = isNaN(parsedAmt) ? (matched.amount || 0) : parsedAmt;
                items.push({ addon: matched, amount: finalAmt });
            }
        }
    }

    return items;
}

/**
 * Ensure standard master OneTimeCharge items exist for Package Creation
 */
async function ensureMasterPackageCharges(prisma, ispId) {
    const defaultCharges = [
        { name: 'INTERNET', code: 'INT', isTaxable: true, isTscApplicable: true, isRenewal: true, forPackageCreation: true },
        { name: 'Support and Maintenance', code: 'SM', isTaxable: true, isTscApplicable: false, isRenewal: true, forPackageCreation: true },
        { name: 'Drop Wire', code: 'DW', isTaxable: true, isTscApplicable: false, isRenewal: false, forPackageCreation: true },
        { name: 'Douplex Router', code: 'DR', isTaxable: true, isTscApplicable: false, isRenewal: false, forPackageCreation: true }
    ];

    const results = [];
    for (const def of defaultCharges) {
        let charge = await prisma.OneTimeCharge.findFirst({
            where: {
                OR: [
                    { code: def.code },
                    { name: { contains: def.name } },
                    { referenceId: `INT-${def.code}` }
                ],
                forPackageCreation: true,
                ...(ispId ? { ispId: Number(ispId) } : {}),
                isDeleted: false
            }
        });

        if (!charge) {
            // Check if exists as catalog without forPackageCreation flag
            charge = await prisma.OneTimeCharge.findFirst({
                where: {
                    OR: [
                        { code: def.code },
                        { name: { contains: def.name } },
                        { referenceId: `INT-${def.code}` }
                    ],
                    ...(ispId ? { ispId: Number(ispId) } : {}),
                    isDeleted: false
                }
            });

            if (charge) {
                charge = await prisma.OneTimeCharge.update({
                    where: { id: charge.id },
                    data: {
                        forPackageCreation: true,
                        isRenewal: def.isRenewal,
                        isTaxable: def.isTaxable,
                        isTscApplicable: def.isTscApplicable
                    }
                });
            } else {
                charge = await prisma.OneTimeCharge.create({
                    data: {
                        name: def.name,
                        code: def.code,
                        referenceId: `INT-${def.code}`,
                        amount: 0,
                        isTaxable: def.isTaxable,
                        isTscApplicable: def.isTscApplicable,
                        forPackageCreation: true,
                        isRenewal: def.isRenewal,
                        isActive: true,
                        isDeleted: false,
                        ispId: ispId || 1
                    }
                });
            }
        }
        results.push(charge);
    }
    return results;
}

// ==========================================
// 3. IMPORT PACKAGES & TARIFFS (PackagePrice with dynamic duration tiers and DB items)
// ==========================================
async function importPackages(req, res, next) {
    const prisma = req.prisma;
    const ispId = req.ispId ? Number(req.ispId) : null;
    const { items = [], syncRadius = true, targetPlanId } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'No package items provided for import' });
    }

    let radiusClient = null;
    if (syncRadius && ispId) {
        try {
            radiusClient = await ServiceFactory.getClient(SERVICE_CODES.RADIUS, ispId);
        } catch (rErr) {
            console.warn('[IMPORT PACKAGES] FreeRADIUS client not available:', rErr.message);
        }
    }

    // Ensure default Connection Type
    let defaultConnectionType = await prisma.ConnectionType.findFirst({
        where: {
            isDeleted: false,
            ...(ispId ? { OR: [{ ispId }, { ispId: null }] } : {})
        }
    });

    if (!defaultConnectionType) {
        defaultConnectionType = await prisma.ConnectionType.create({
            data: {
                name: 'Fiber',
                code: 'FIBER',
                isActive: true,
                isDeleted: false,
                ispId: ispId || 1
            }
        });
    }

    // Ensure default master charges exist if DB is fresh
    await ensureMasterPackageCharges(prisma, ispId);

    // Fetch ALL active OneTimeCharges (Inventory Items for Package Addon Charges)
    const allAddonCharges = await prisma.OneTimeCharge.findMany({
        where: {
            isDeleted: false,
            ...(ispId ? { ispId: Number(ispId) } : {})
        }
    });

    // Fetch dynamic TSC percentage from ISP Settings (default: 10%)
    let tscPercentage = 10;
    try {
        const tscSetting = await prisma.iSPSettings.findFirst({
            where: {
                ...(ispId ? { ispId: Number(ispId) } : {}),
                key: 'tscPercentage'
            }
        });
        if (tscSetting && tscSetting.value) {
            tscPercentage = parseFloat(tscSetting.value) || 10;
        }
    } catch (e) {
        tscPercentage = 10;
    }

    // Optional target plan if specified in request body
    let targetPlan = null;
    if (targetPlanId) {
        targetPlan = await prisma.PackagePlan.findUnique({
            where: { id: Number(targetPlanId) }
        });
    }

    const DURATIONS_CONFIG = [
        { duration: '1 Month', prefixes: ['1m', '1 month', '1_month', '1month', '1_m'] },
        { duration: '3 Months', prefixes: ['3m', '3 months', '3_months', '3months', '3 month', '3_m'] },
        { duration: '6 Months', prefixes: ['6m', '6 months', '6_months', '6months', '6 month', '6_m'] },
        { duration: '12 Months', prefixes: ['12m', '12 months', '12_months', '12months', '1 year', '1_year', '1year', '12 month', '12_m'] }
    ];

    const logs = [];
    let successCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (let i = 0; i < items.length; i++) {
        const rowNumber = i + 1;
        const row = items[i] || {};

        const rawPlanName = (row.planName || row['Plan Name'] || row['Internet Speed Plan'] || row.packageName || row['Package Name'] || row.name || row.package || (targetPlan ? targetPlan.planName : '') || '').toString().trim();
        const packageReferenceName = (row.packageReferenceName || row['Package Reference Name'] || row.packageName || row['Package Name'] || rawPlanName || (targetPlan ? targetPlan.planName : '')).toString().trim();

        if (!rawPlanName && !targetPlan) {
            logs.push({
                rowNumber,
                name: 'Empty Plan Name',
                status: 'skipped',
                message: 'Row skipped: Plan Name or Package Reference Name is required.'
            });
            skippedCount++;
            continue;
        }

        try {
            let plan = targetPlan;
            const speedInput = row.speed || row.bandwidth || row.downSpeed || row.speedMbps || row['Speed (Mbps)'] || row.Speed || rawPlanName;
            const speedMbps = extractSpeedMbps(speedInput);
            const downSpeed = row.downSpeed ? Number(row.downSpeed) : speedMbps;
            const upSpeed = row.upSpeed ? Number(row.upSpeed) : speedMbps;

            if (!plan) {
                const rawPlanCode = (row.planCode || row.code || row['Plan Code'] || '').toString().trim();
                const planCode = rawPlanCode ? slugify(rawPlanCode) : await generateUniquePlanCode(prisma, ispId, rawPlanName);

                plan = await prisma.PackagePlan.findFirst({
                    where: {
                        OR: [
                            { planCode },
                            { planName: rawPlanName }
                        ],
                        ...(ispId ? { ispId } : {}),
                        isDeleted: false
                    }
                });

                if (!plan) {
                    plan = await prisma.PackagePlan.create({
                        data: {
                            planName: rawPlanName,
                            planCode,
                            connectionType: defaultConnectionType.id,
                            downSpeed,
                            upSpeed,
                            dataLimit: row.dataLimit ? Number(row.dataLimit) : 0,
                            deviceLimit: row.deviceLimit ? Number(row.deviceLimit) : 1,
                            nasType: (row.nasType || row['NAS Type'] || 'mikrotik').toLowerCase(),
                            isPopular: Boolean(row.isPopular),
                            description: row.description || `${rawPlanName} - High Speed ${speedMbps} Mbps Internet`,
                            fupApply: row.fupApply !== undefined ? Boolean(row.fupApply) : true,
                            fupLimitGb: row.fupLimitGb ? Number(row.fupLimitGb) : null,
                            isActive: true,
                            isDeleted: false,
                            ispId: ispId || 1
                        }
                    });
                } else {
                    plan = await prisma.PackagePlan.update({
                        where: { id: plan.id },
                        data: {
                            downSpeed,
                            upSpeed,
                            updatedAt: new Date()
                        }
                    });
                }
            }

            let radiusSyncMessage = 'FreeRADIUS not configured';
            if (radiusClient) {
                try {
                    await radiusClient.createRadgroupcheck({
                        groupname: plan.planCode,
                        attribute: 'Auth-Type',
                        op: ':=',
                        value: 'Accept'
                    }).catch(() => null);

                    const mikrotikRateLimit = formatMikrotikRateLimit(upSpeed, downSpeed, row.priority || 8);
                    const replyAttributes = [
                        { attribute: 'Mikrotik-Rate-Limit', op: ':=', value: mikrotikRateLimit },
                        { attribute: 'Framed-Protocol', op: ':=', value: 'PPP' },
                        { attribute: 'Service-Type', op: ':=', value: 'Framed-User' }
                    ];

                    let firstReplyId = null;
                    for (const attr of replyAttributes) {
                        try {
                            const res = await radiusClient.createRadgroupreply({
                                groupname: plan.planCode,
                                ...attr
                            });
                            if (!firstReplyId && res?.id) firstReplyId = res.id;
                        } catch (attrErr) {}
                    }

                    if (firstReplyId) {
                        await prisma.PackagePlan.update({
                            where: { id: plan.id },
                            data: { radgroupreplyId: firstReplyId }
                        });
                    }

                    radiusSyncMessage = `FreeRADIUS Synced (Group: ${plan.planCode}, Rate: ${upSpeed}M/${downSpeed}M)`;
                } catch (rSyncErr) {
                    radiusSyncMessage = `FreeRADIUS Sync Warning: ${rSyncErr.message}`;
                }
            }

            // Dynamically parse duration tiers from row
            const parsedDurationTiers = [];

            // Case A: Check if the row has an explicit single Duration column (e.g. "Duration": "1 Month")
            const rowDurationRaw = (row.duration || row['Duration'] || row.period || row['Period'] || row.tier || row['Tier'] || '').toString().trim();
            if (rowDurationRaw) {
                const matchedDurConf = DURATIONS_CONFIG.find(dc => {
                    const normD = rowDurationRaw.toLowerCase().replace(/[^a-z0-9]/g, '');
                    return dc.prefixes.some(p => normD === p.replace(/[^a-z0-9]/g, '') || normD.startsWith(p.replace(/[^a-z0-9]/g, '')));
                }) || DURATIONS_CONFIG[0];

                const tierActive = parseBooleanValue(row.enabled ?? row['Enabled'] ?? row.active ?? row['Active'] ?? row.status ?? row['Status'], true);
                const tierOnline = parseBooleanValue(row.online ?? row['Online'] ?? row.isOnline ?? row['Is Online'], false);
                const fallbackTotal = parseFloat(row.total || row['Total'] || row.price || row['Price'] || row.initialTotal || row['Initial Total with Tax (Rs.)'] || row['Total (Rs.)'] || row['Renew Amount with Tax (Rs.)']) || null;

                // Parse items from Package Items column
                const rawItems = row.packageItems || row['Package Items'] || row.items || row['Items'] || row.addons || row['Addon Charges'] || row['Item Charges'] || row.itemList;
                const tierItems = parseItemsList(rawItems, allAddonCharges);

                // Also check if any standalone item column exists on this row (e.g. "Internet": 500)
                for (const [rawColKey, rawVal] of Object.entries(row)) {
                    if (rawVal === undefined || rawVal === null || rawVal === '') continue;
                    const colKey = rawColKey.trim();
                    const matchedAddon = findMatchingAddon(colKey, allAddonCharges);
                    if (matchedAddon && !tierItems.some(ti => ti.addon.id === matchedAddon.id)) {
                        tierItems.push({ addon: matchedAddon, amount: parseFloat(rawVal) || 0 });
                    }
                }

                parsedDurationTiers.push({
                    duration: matchedDurConf.duration,
                    active: tierActive,
                    online: tierOnline,
                    items: tierItems,
                    fallbackTotal
                });
            } else {
                // Case B: Multi-duration columns on a single row (1M Enabled, 1M Items, 3M Enabled, 3M Items, etc.)
                for (const durConf of DURATIONS_CONFIG) {
                    let tierActive = true;
                    let tierOnline = false;
                    let tierHasExplicitData = false;
                    let fallbackTotal = null;
                    const tierItems = [];

                    for (const [rawColKey, rawVal] of Object.entries(row)) {
                        if (rawVal === undefined || rawVal === null || rawVal === '') continue;
                        const colKey = rawColKey.trim();
                        const colKeyLower = colKey.toLowerCase();

                        // Find if colKey starts with any prefix for this duration
                        let matchedPrefix = null;
                        for (const p of durConf.prefixes) {
                            if (colKeyLower.startsWith(p)) {
                                const rem = colKey.slice(p.length);
                                if (!rem || /^[\s_:-]/.test(rem)) {
                                    matchedPrefix = p;
                                    break;
                                }
                            }
                        }

                        if (!matchedPrefix) continue;

                        const suffix = colKey.slice(matchedPrefix.length).replace(/^[\s_:-]+/, '').trim();
                        const normSuffix = suffix.toLowerCase().replace(/[^a-z0-9]/g, '');

                        // Enabled / Active flag
                        if (['enabled', 'active', 'isactive', 'isenabled', 'status'].includes(normSuffix)) {
                            tierActive = parseBooleanValue(rawVal, true);
                            tierHasExplicitData = true;
                            continue;
                        }

                        // Online flag
                        if (['online', 'isonline', 'live', 'portal'].includes(normSuffix)) {
                            tierOnline = parseBooleanValue(rawVal, false);
                            tierHasExplicitData = true;
                            continue;
                        }

                        // Fallback Total column
                        if (['total', 'price', 'totalamount', 'amountwithtax'].includes(normSuffix)) {
                            fallbackTotal = parseFloat(rawVal) || 0;
                            tierHasExplicitData = true;
                            continue;
                        }

                        // Items list string (e.g. "INT: 500; SM: 500; DW: 0") or JSON
                        if (['items', 'addons', 'charges', 'itemlist', 'packageitems'].includes(normSuffix)) {
                            tierHasExplicitData = true;
                            const parsed = parseItemsList(rawVal, allAddonCharges);
                            for (const itm of parsed) {
                                if (!tierItems.some(ti => ti.addon.id === itm.addon.id)) {
                                    tierItems.push(itm);
                                }
                            }
                            continue;
                        }

                        // Match suffix against any active OneTimeCharge item in the database
                        const matchedAddon = findMatchingAddon(suffix, allAddonCharges);
                        if (matchedAddon) {
                            const amt = parseFloat(rawVal) || 0;
                            tierItems.push({ addon: matchedAddon, amount: amt });
                            tierHasExplicitData = true;
                        }
                    }

                    if (tierHasExplicitData || tierItems.length > 0 || fallbackTotal !== null) {
                        parsedDurationTiers.push({
                            duration: durConf.duration,
                            active: tierActive,
                            online: tierOnline,
                            items: tierItems,
                            fallbackTotal
                        });
                    }
                }
            }

            const createdPrices = [];

            if (parsedDurationTiers.length > 0) {
                for (const tier of parsedDurationTiers) {
                    const addonPricesMap = {};
                    const selectedAddonIds = [];
                    let initialTaxableSum = 0;
                    let initialNonTaxableSum = 0;
                    let renewTaxableSum = 0;
                    let renewNonTaxableSum = 0;
                    let recurringBasePrice = 0;
                    let hasTsc = false;

                    // Deduplicate items by addon ID
                    const uniqueItems = new Map();
                    for (const item of tier.items) {
                        uniqueItems.set(item.addon.id, item);
                    }

                    for (const [addonId, { addon, amount }] of uniqueItems.entries()) {
                        addonPricesMap[String(addonId)] = amount;
                        selectedAddonIds.push(addon.id);

                        // Use actual database properties of the addon charge
                        const tscAmt = addon.isTscApplicable ? (amount * tscPercentage) / 100 : 0;
                        if (tscAmt > 0) hasTsc = true;

                        const taxableAmt = addon.isTaxable ? (amount + tscAmt) : 0;
                        const nonTaxableAmt = !addon.isTaxable ? (amount + tscAmt) : 0;

                        initialTaxableSum += taxableAmt;
                        initialNonTaxableSum += nonTaxableAmt;

                        if (addon.isRenewal) {
                            recurringBasePrice += amount;
                            renewTaxableSum += taxableAmt;
                            renewNonTaxableSum += nonTaxableAmt;
                        }
                    }

                    // If fallback total provided with no specific item breakdown
                    if (uniqueItems.size === 0 && tier.fallbackTotal !== null && tier.fallbackTotal > 0) {
                        const defaultInt = allAddonCharges.find(a => a.code === 'INT' || a.name.toUpperCase().includes('INTERNET'));
                        const defaultSm = allAddonCharges.find(a => a.code === 'SM' || a.name.toUpperCase().includes('SUPPORT'));
                        const halfVal = tier.fallbackTotal / 2;

                        if (defaultInt) {
                            addonPricesMap[String(defaultInt.id)] = halfVal;
                            selectedAddonIds.push(defaultInt.id);
                        }
                        if (defaultSm) {
                            addonPricesMap[String(defaultSm.id)] = halfVal;
                            selectedAddonIds.push(defaultSm.id);
                        }

                        recurringBasePrice = tier.fallbackTotal;
                        const tscAmt = (halfVal * tscPercentage) / 100;
                        hasTsc = true;
                        initialTaxableSum = tier.fallbackTotal + tscAmt;
                        renewTaxableSum = tier.fallbackTotal + tscAmt;
                    }

                    const initialTotalWithTax = Math.round((initialTaxableSum * 1.13 + initialNonTaxableSum) * 100) / 100;
                    const renewAmountWithTax = Math.round((renewTaxableSum * 1.13 + renewNonTaxableSum) * 100) / 100;
                    const basePrice = recurringBasePrice > 0 ? recurringBasePrice : Array.from(uniqueItems.values()).reduce((s, i) => s + i.amount, 0);

                    if (basePrice > 0 || initialTotalWithTax > 0 || selectedAddonIds.length > 0) {
                        const cleanPlanCode = String(plan.planCode).replace(/[\s-]/g, '');
                        const cleanDuration = String(tier.duration).replace(/[\s-]/g, '');
                        const baseRefId = `INT-${cleanPlanCode}${cleanDuration}`;
                        const addonPricesJson = Object.keys(addonPricesMap).length > 0 ? JSON.stringify(addonPricesMap) : null;

                        let existingPrice = await prisma.PackagePrice.findFirst({
                            where: {
                                planId: plan.id,
                                packageDuration: tier.duration,
                                ...(ispId ? { ispId } : {})
                            }
                        });

                        const cleanPackageName = packageReferenceName.endsWith(tier.duration)
                            ? packageReferenceName
                            : `${packageReferenceName} - ${tier.duration}`;

                        let record;
                        if (existingPrice) {
                            const finalRefId = await generateUniqueReferenceId(prisma, existingPrice.referenceId || baseRefId, existingPrice.id);
                            record = await prisma.PackagePrice.update({
                                where: { id: existingPrice.id },
                                data: {
                                    price: basePrice,
                                    initialTotalWithTax: initialTotalWithTax || basePrice,
                                    renewAmountWithTax: renewAmountWithTax || initialTotalWithTax || basePrice,
                                    isTscApplicable: hasTsc,
                                    packageName: cleanPackageName,
                                    isActive: tier.active,
                                    isOnline: tier.online,
                                    isDeleted: false,
                                    referenceId: finalRefId,
                                    addonPricesJson,
                                    updatedAt: new Date()
                                }
                            });
                        } else {
                            const finalRefId = await generateUniqueReferenceId(prisma, baseRefId);
                            record = await prisma.PackagePrice.create({
                                data: {
                                    planId: plan.id,
                                    price: basePrice,
                                    initialTotalWithTax: initialTotalWithTax || basePrice,
                                    renewAmountWithTax: renewAmountWithTax || initialTotalWithTax || basePrice,
                                    packageDuration: tier.duration,
                                    packageName: cleanPackageName,
                                    referenceId: finalRefId,
                                    isTscApplicable: hasTsc,
                                    isActive: tier.active,
                                    isOnline: tier.online,
                                    isDeleted: false,
                                    addonPricesJson,
                                    ispId: ispId || 1,
                                    updatedAt: new Date()
                                }
                            });
                        }

                        // Re-link packageonetimecharges join table
                        await prisma.packageonetimecharges.deleteMany({ where: { A: record.id } }).catch(() => {});
                        if (selectedAddonIds.length > 0) {
                            await prisma.packageonetimecharges.createMany({
                                data: selectedAddonIds.map(cid => ({ A: record.id, B: Number(cid) })),
                                skipDuplicates: true
                            }).catch(() => {});
                        }

                        createdPrices.push(`${tier.duration}: Base Rs. ${basePrice} | Renew Rs. ${renewAmountWithTax} | Initial Rs. ${initialTotalWithTax} (${selectedAddonIds.length} items linked)`);
                    }
                }
            } else if (row.price !== undefined || row.amount !== undefined || row.total !== undefined) {
                // Flat Single Price Row Fallback
                const duration = (row.duration || row.packageDuration || row['Duration'] || '1 Month').toString().trim();
                const flatPrice = parseFloat(row.price || row.amount || row.total || 0);
                const isOnline = row['Is Online'] !== undefined ? parseBooleanValue(row['Is Online']) : parseBooleanValue(row.isOnline, false);
                const isActive = row['Is Active'] !== undefined ? parseBooleanValue(row['Is Active']) : parseBooleanValue(row.isActive, true);

                const cleanPlanCode = String(plan.planCode).replace(/[\s-]/g, '');
                const cleanDuration = String(duration).replace(/[\s-]/g, '');
                const baseRefId = `INT-${cleanPlanCode}${cleanDuration}`;

                const addonPricesMap = {};
                const selectedAddonIds = [];
                const defaultInt = allAddonCharges.find(a => a.code === 'INT' || a.name.toUpperCase().includes('INTERNET'));
                const defaultSm = allAddonCharges.find(a => a.code === 'SM' || a.name.toUpperCase().includes('SUPPORT'));

                if (defaultInt) {
                    addonPricesMap[String(defaultInt.id)] = flatPrice / 2;
                    selectedAddonIds.push(defaultInt.id);
                }
                if (defaultSm) {
                    addonPricesMap[String(defaultSm.id)] = flatPrice / 2;
                    selectedAddonIds.push(defaultSm.id);
                }

                const tscAmt = (flatPrice / 2) * (tscPercentage / 100);
                const taxableBase = flatPrice + tscAmt;
                const totalWithTax = Math.round((taxableBase * 1.13) * 100) / 100;
                const addonPricesJson = Object.keys(addonPricesMap).length > 0 ? JSON.stringify(addonPricesMap) : null;

                const cleanPackageName = packageReferenceName.endsWith(duration)
                    ? packageReferenceName
                    : `${packageReferenceName} - ${duration}`;

                let existingPrice = await prisma.PackagePrice.findFirst({
                    where: {
                        planId: plan.id,
                        packageDuration: duration,
                        ...(ispId ? { ispId } : {})
                    }
                });

                let record;
                if (existingPrice) {
                    const finalRefId = await generateUniqueReferenceId(prisma, existingPrice.referenceId || baseRefId, existingPrice.id);
                    record = await prisma.PackagePrice.update({
                        where: { id: existingPrice.id },
                        data: {
                            price: flatPrice,
                            initialTotalWithTax: totalWithTax,
                            renewAmountWithTax: totalWithTax,
                            packageName: cleanPackageName,
                            isTscApplicable: true,
                            isActive,
                            isOnline,
                            isDeleted: false,
                            referenceId: finalRefId,
                            addonPricesJson,
                            updatedAt: new Date()
                        }
                    });
                } else {
                    const refId = await generateUniqueReferenceId(prisma, baseRefId);
                    record = await prisma.PackagePrice.create({
                        data: {
                            planId: plan.id,
                            price: flatPrice,
                            initialTotalWithTax: totalWithTax,
                            renewAmountWithTax: totalWithTax,
                            packageDuration: duration,
                            packageName: cleanPackageName,
                            referenceId: refId,
                            isTscApplicable: true,
                            isActive,
                            isOnline,
                            isDeleted: false,
                            addonPricesJson,
                            ispId: ispId || 1,
                            updatedAt: new Date()
                        }
                    });
                }

                await prisma.packageonetimecharges.deleteMany({ where: { A: record.id } }).catch(() => {});
                if (selectedAddonIds.length > 0) {
                    await prisma.packageonetimecharges.createMany({
                        data: selectedAddonIds.map(cid => ({ A: record.id, B: Number(cid) })),
                        skipDuplicates: true
                    }).catch(() => {});
                }

                createdPrices.push(`${duration}: Rs. ${flatPrice} (Total with Tax: Rs. ${totalWithTax})`);
            }

            const priceSummary = createdPrices.length > 0 ? `Durations configured: [${createdPrices.join('; ')}]` : 'No durations attached';

            logs.push({
                rowNumber,
                name: packageReferenceName || rawPlanName,
                status: 'success',
                message: `✓ CMS Plan: ${plan.planName} (ID: ${plan.id}) | ✓ ${radiusSyncMessage} | ✓ ${priceSummary}`
            });
            successCount++;

        } catch (err) {
            console.error(`Error importing package row ${rowNumber}:`, err);
            logs.push({
                rowNumber,
                name: packageReferenceName || rawPlanName,
                status: 'failed',
                message: `Failed: ${err.message}`
            });
            failedCount++;
        }
    }

    res.json({
        success: true,
        total: items.length,
        successCount,
        skippedCount,
        failedCount,
        logs
    });
}

// ==========================================
// 4. IMPORT LEADS (CRM)
// ==========================================
async function importLeads(req, res, next) {
    const prisma = req.prisma;
    const ispId = req.ispId ? Number(req.ispId) : null;
    const { items = [], skipExisting = false } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'No lead items provided for import' });
    }

    const logs = [];
    let successCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    const branchCache = new Map();
    const packageCache = new Map();

    for (let i = 0; i < items.length; i++) {
        const rowNumber = i + 1;
        const row = items[i] || {};

        let firstName = (row.firstName || row.first_name || row['First Name'] || '').toString().trim();
        let middleName = (row.middleName || row.middle_name || row['Middle Name'] || '').toString().trim() || null;
        let lastName = (row.lastName || row.last_name || row['Last Name'] || '').toString().trim();
        const fullName = (row.name || row.fullName || row.leadName || row['Full Name'] || row['Lead Name'] || '').toString().trim();

        if (!firstName && !lastName && fullName) {
            const split = splitFullName(fullName);
            firstName = split.firstName;
            middleName = split.middleName;
            lastName = split.lastName;
        }

        if (!firstName && !lastName) {
            firstName = `Lead-${rowNumber}`;
            lastName = 'Prospect';
        }

        const phone = (row.phoneNumber || row.phone || row.mobile || row.contact || row['Phone Number'] || row['Mobile'] || '').toString().trim();
        const rawEmail = (row.email || row['Email'] || row['Email Address'] || '').toString().trim().toLowerCase();
        const cleanEmail = rawEmail || null;

        if (!phone && !cleanEmail) {
            logs.push({
                rowNumber,
                name: `${firstName} ${lastName}`,
                status: 'skipped',
                message: 'Row skipped: Both Phone Number and Email are missing.'
            });
            skippedCount++;
            continue;
        }

        try {
            const branchName = (row.branch || row.branchName || row['Branch Name'] || row.HeadBranch || '').toString().trim();
            const subBranchName = (row.subBranch || row.subBranchName || row['Sub-Branch Name'] || '').toString().trim();

            let branchId = row.branchId ? Number(row.branchId) : null;
            let subBranchId = row.subBranchId ? Number(row.subBranchId) : null;

            if (branchName && !branchId) {
                const bKey = branchName.toLowerCase();
                if (!branchCache.has(bKey)) {
                    const br = await prisma.Branch.findFirst({
                        where: {
                            name: branchName,
                            parentId: null,
                            ...(ispId ? { ispId } : {}),
                            isDeleted: false
                        }
                    });
                    branchCache.set(bKey, br ? br.id : null);
                }
                branchId = branchCache.get(bKey);
            }

            if (subBranchName && !subBranchId) {
                const sbKey = `${branchName}>${subBranchName}`.toLowerCase();
                if (!branchCache.has(sbKey)) {
                    const sbr = await prisma.Branch.findFirst({
                        where: {
                            name: subBranchName,
                            ...(branchId ? { parentId: branchId } : {}),
                            ...(ispId ? { ispId } : {}),
                            isDeleted: false
                        }
                    });
                    branchCache.set(sbKey, sbr ? sbr.id : null);
                }
                subBranchId = branchCache.get(sbKey);
            }

            const pkgName = (row.interestedPackage || row.packageName || row.package || row['Interested Package'] || row['Package Name'] || '').toString().trim();
            let interestedPackageId = row.interestedPackageId ? Number(row.interestedPackageId) : null;

            if (pkgName && !interestedPackageId) {
                const pKey = pkgName.toLowerCase();
                if (!packageCache.has(pKey)) {
                    const p = await prisma.PackagePrice.findFirst({
                        where: {
                            OR: [
                                { packageName: { contains: pkgName } },
                                { referenceId: { contains: pkgName } },
                                { packagePlanDetails: { planName: { contains: pkgName } } }
                            ],
                            ...(ispId ? { ispId } : {}),
                            isDeleted: false
                        }
                    });
                    packageCache.set(pKey, p ? p.id : null);
                }
                interestedPackageId = packageCache.get(pKey);
            }

            const duplicateCheck = await prisma.Lead.findFirst({
                where: {
                    OR: [
                        ...(cleanEmail ? [{ email: cleanEmail }] : []),
                        ...(phone ? [{ phoneNumber: phone }] : [])
                    ],
                    ...(ispId ? { ispId } : {}),
                    isDeleted: false
                }
            });

            if (duplicateCheck) {
                if (skipExisting) {
                    logs.push({
                        rowNumber,
                        name: `${firstName} ${lastName}`,
                        status: 'skipped',
                        message: `Lead with ${cleanEmail ? `email '${cleanEmail}'` : `phone '${phone}'`} already exists (Lead ID: ${duplicateCheck.id}).`
                    });
                    skippedCount++;
                    continue;
                } else {
                    await prisma.Lead.update({
                        where: { id: duplicateCheck.id },
                        data: {
                            firstName: firstName || duplicateCheck.firstName,
                            middleName: middleName || duplicateCheck.middleName,
                            lastName: lastName || duplicateCheck.lastName,
                            address: (row.address || row['Address'] || duplicateCheck.address || '').toString().trim() || null,
                            district: (row.district || row.city || row['District'] || row['City'] || duplicateCheck.district || '').toString().trim() || null,
                            province: (row.province || row.state || row['Province'] || row['State'] || duplicateCheck.province || '').toString().trim() || null,
                            notes: (row.notes || row['Notes'] || duplicateCheck.notes || '').toString().trim() || null,
                            branchId: branchId || duplicateCheck.branchId,
                            subBranchId: subBranchId || duplicateCheck.subBranchId,
                            interestedPackageId: interestedPackageId || duplicateCheck.interestedPackageId,
                            updatedAt: new Date()
                        }
                    });

                    logs.push({
                        rowNumber,
                        name: `${firstName} ${lastName}`,
                        status: 'success',
                        message: `✓ Updated existing Lead (ID: ${duplicateCheck.id}, Phone: ${phone || 'N/A'}).`
                    });
                    successCount++;
                    continue;
                }
            }

            const validStatus = ['new', 'contacted', 'qualified', 'unqualified', 'converted'].includes(String(row.status || '').toLowerCase())
                ? String(row.status).toLowerCase()
                : 'new';

            const createdLead = await prisma.Lead.create({
                data: {
                    firstName,
                    middleName,
                    lastName,
                    email: cleanEmail,
                    phoneNumber: phone || null,
                    secondaryContactNumber: (row.secondaryContactNumber || row['Secondary Contact'] || row.altPhone || '').toString().trim() || null,
                    gender: (row.gender || row['Gender'] || '').toString().trim() || null,
                    address: (row.address || row['Address'] || '').toString().trim() || null,
                    street: (row.street || row['Street'] || '').toString().trim() || null,
                    district: (row.district || row.city || row['District'] || row['City'] || '').toString().trim() || null,
                    province: (row.province || row.state || row['Province'] || row['State'] || '').toString().trim() || null,
                    source: (row.source || row['Source'] || 'import').toString().trim(),
                    status: validStatus,
                    notes: (row.notes || row['Notes'] || '').toString().trim() || null,
                    branchId: branchId || null,
                    subBranchId: subBranchId || null,
                    ispId: ispId || 1,
                    interestedPackageId: interestedPackageId || null,
                    assignedUserId: row.assignedUserId ? Number(row.assignedUserId) : null,
                    isActive: true,
                    isDeleted: false,
                    metadata: {
                        age: row.age || row['Age'] || null,
                        importDate: new Date().toISOString()
                    }
                }
            });

            logs.push({
                rowNumber,
                name: `${firstName} ${lastName}`,
                status: 'success',
                message: `✓ Created Lead #${createdLead.id} | Status: ${createdLead.status} | Phone: ${phone || 'N/A'}${branchName ? ` | Branch: ${branchName}` : ''}`
            });
            successCount++;

        } catch (err) {
            console.error(`Error importing lead row ${rowNumber}:`, err);
            logs.push({
                rowNumber,
                name: `${firstName} ${lastName}`,
                status: 'failed',
                message: `Failed: ${err.message}`
            });
            failedCount++;
        }
    }

    res.json({
        success: true,
        total: items.length,
        successCount,
        skippedCount,
        failedCount,
        logs
    });
}
async function importCustomers(req, res, next) {
    const prisma = req.prisma;
    const ispId = req.ispId ? Number(req.ispId) : null;
    const { items = [], skipExisting = false, syncRadius = true } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'No customer items provided for import' });
    }

    let radiusClient = null;
    if (syncRadius && ispId) {
        try {
            const { RadiusClient } = require('../services/radiusClient');
            radiusClient = await RadiusClient.create(ispId);
        } catch (rErr) {
            console.warn('[IMPORT CUSTOMERS] FreeRADIUS client not available:', rErr.message);
        }
    }

    let customerRole = null;
    try {
        customerRole = await prisma.Role.findFirst({ where: { name: 'Customer' } });
        if (!customerRole) {
            customerRole = await prisma.Role.create({ data: { name: 'Customer', isActive: true } });
        }
    } catch (e) {
        console.warn('[IMPORT CUSTOMERS] Could not ensure Customer role:', e.message);
    }

    let nettvService = null;
    try {
        nettvService = await prisma.Service.findFirst({
            where: {
                OR: [
                    { code: 'NETTV' },
                    { name: { contains: 'NetTV' } },
                    { category: 'STREAMING' }
                ],
                isDeleted: false
            }
        });
    } catch (e) {
        console.warn('[IMPORT CUSTOMERS] NetTV service lookup note:', e.message);
    }

    const logs = [];
    let successCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    const branchCache = new Map();
    const packageCache = new Map();
    const customerTypeCache = new Map();
    const oltCache = new Map();
    const splitterCache = new Map();
    const nasCache = new Map();

    for (let i = 0; i < items.length; i++) {
        const rowNumber = i + 1;
        const row = items[i] || {};

        const rawLeadId = row.leadId || row.lead_id || row['Lead ID'] || row['Lead'] || row.Lead || '';
        const parsedLeadId = rawLeadId ? parseInt(String(rawLeadId).replace(/[^0-9]/g, ''), 10) : null;

        let lead = null;
        let leadLoadedFromDb = false;

        if (parsedLeadId && !isNaN(parsedLeadId)) {
            lead = await prisma.Lead.findFirst({
                where: {
                    id: parsedLeadId,
                    ...(ispId ? { ispId } : {}),
                    isDeleted: false
                }
            });
            if (lead) {
                leadLoadedFromDb = true;
            } else {
                console.warn(`[CUSTOMER IMPORT] Specified Lead ID #${parsedLeadId} not found in database.`);
            }
        }

        let firstName = (lead?.firstName || row.firstName || row.first_name || row['First Name'] || '').toString().trim();
        let middleName = (lead?.middleName || row.middleName || row.middle_name || row['Middle Name'] || '').toString().trim() || null;
        let lastName = (lead?.lastName || row.lastName || row.last_name || row['Last Name'] || '').toString().trim();
        const fullName = (row.name || row.Name || row.fullName || row['Full Name'] || row.customerName || row['Customer Name'] || '').toString().trim();

        if (!firstName && !lastName && fullName) {
            const split = splitFullName(fullName);
            firstName = split.firstName;
            middleName = split.middleName;
            lastName = split.lastName;
        }

        if (!firstName && !lastName) {
            firstName = `Customer`;
            lastName = `${rowNumber}`;
        }

        const phone = (lead?.phoneNumber || row.phoneNumber || row.phone || row.Mobile || row.mobile || row.contact || row['Phone Number'] || row['Mobile'] || '').toString().trim();
        const altPhone = (lead?.secondaryContactNumber || row.alternativePhone || row.altPhone || row['Alternative Phone Number'] || row['Secondary Contact Number'] || '').toString().trim();
        const rawEmail = (lead?.email || row.email || row.Email || row['Email'] || row['Email Address'] || '').toString().trim().toLowerCase();
        const cleanEmail = rawEmail || null;

        const panNo = (row.panNo || row.pan || row.panNumber || row['PAN No'] || row['PAN Number'] || row['PAN'] || '').toString().trim() || null;
        const customCode = (row.customerCode || row['Customer Code'] || row.customerUniqueId || row.customerId || row['Customer ID'] || row['Customer Id'] || '').toString().trim();
        const idNumber = (row.idNumber || customCode || row.citizenshipNo || row.citizenshipNumber || row['Citizenship Number'] || row['ID Number'] || row['Citizenship'] || (phone ? `ID-${phone}` : `ID-${Date.now() + i}`)).toString().trim();

        try {
            const orgName = (row.organization || row.Organization || row['Organization'] || '').toString().trim();
            let branchName = (row.branch || row.Branch || row.branchName || row['Branch Name'] || row.HeadBranch || orgName || '').toString().trim();
            let subBranchName = (row.subBranch || row.subBranchName || row['Sub-Branch Name'] || '').toString().trim();

            if (orgName && branchName && orgName.toLowerCase() !== branchName.toLowerCase() && !subBranchName) {
                subBranchName = branchName;
                branchName = orgName;
            }

            let branchId = row.branchId ? Number(row.branchId) : (lead?.branchId || null);
            let subBranchId = row.subBranchId ? Number(row.subBranchId) : (lead?.subBranchId || null);

            if (branchName && !branchId) {
                const bKey = branchName.toLowerCase();
                if (!branchCache.has(bKey)) {
                    let br = await prisma.Branch.findFirst({
                        where: {
                            name: branchName,
                            parentId: null,
                            ...(ispId ? { ispId } : {}),
                            isDeleted: false
                        }
                    });
                    if (!br) {
                        const bCode = await generateUniqueBranchCode(prisma, ispId, branchName, false);
                        br = await prisma.Branch.create({
                            data: {
                                name: branchName,
                                code: bCode,
                                isActive: true,
                                isDeleted: false,
                                ispId: ispId || 1
                            }
                        });
                    }
                    branchCache.set(bKey, br ? br.id : null);
                }
                branchId = branchCache.get(bKey);
            }

            if (subBranchName && !subBranchId) {
                const sbKey = `${branchName}>${subBranchName}`.toLowerCase();
                if (!branchCache.has(sbKey)) {
                    let sbr = await prisma.Branch.findFirst({
                        where: {
                            name: subBranchName,
                            ...(branchId ? { parentId: branchId } : {}),
                            ...(ispId ? { ispId } : {}),
                            isDeleted: false
                        }
                    });
                    if (!sbr && branchId) {
                        const sbCode = await generateUniqueBranchCode(prisma, ispId, subBranchName, true);
                        sbr = await prisma.Branch.create({
                            data: {
                                name: subBranchName,
                                code: sbCode,
                                parentId: branchId,
                                isActive: true,
                                isDeleted: false,
                                ispId: ispId || 1
                            }
                        });
                    }
                    branchCache.set(sbKey, sbr ? sbr.id : null);
                }
                subBranchId = branchCache.get(sbKey);
            }

            const typeName = (row.customerType || row.type || row['Customer Type'] || 'Home').toString().trim();
            let customerTypeId = row.customerTypeId ? Number(row.customerTypeId) : null;
            if (typeName && !customerTypeId) {
                const tKey = typeName.toLowerCase();
                if (!customerTypeCache.has(tKey)) {
                    let ct = await prisma.CustomerType.findFirst({
                        where: {
                            name: { contains: typeName }
                        }
                    });
                    if (!ct) {
                        try {
                            ct = await prisma.CustomerType.create({
                                data: { name: typeName }
                            });
                        } catch (e) {
                            ct = await prisma.CustomerType.findFirst();
                        }
                    }
                    customerTypeCache.set(tKey, ct ? ct.id : null);
                }
                customerTypeId = customerTypeCache.get(tKey);
            }

            const rawDuration = (row.duration || row.Duration || row.packageDuration || row.period || row.Period || row['Period'] || row['Duration'] || '1 Month').toString().trim();
            const durationStr = normalizeDurationString(rawDuration);
            const pkgName = (row.packageName || row.package || row.Package || row.plan || row.planName || row['Package'] || row['Package Name'] || row['Plan Name'] || row['Internet Plan'] || row.planCode || '').toString().trim();
            let packagePrice = null;

            if (pkgName) {
                const pKey = `${pkgName}_${durationStr}`.toLowerCase();
                if (packageCache.has(pKey)) {
                    packagePrice = packageCache.get(pKey);
                } else {
                    // 1. Try matching with duration
                    if (durationStr) {
                        packagePrice = await prisma.PackagePrice.findFirst({
                            where: {
                                OR: [
                                    { packageName: { contains: pkgName } },
                                    { referenceId: { contains: pkgName } },
                                    { packagePlanDetails: { planName: { contains: pkgName } } },
                                    { packagePlanDetails: { planCode: { contains: pkgName } } }
                                ],
                                packageDuration: { contains: durationStr },
                                ...(ispId ? { ispId } : {}),
                                isDeleted: false
                            },
                            include: {
                                packagePlanDetails: true
                            }
                        });
                    }

                    // 2. Fallback matching without duration
                    if (!packagePrice) {
                        packagePrice = await prisma.PackagePrice.findFirst({
                            where: {
                                OR: [
                                    { packageName: { contains: pkgName } },
                                    { referenceId: { contains: pkgName } },
                                    { packagePlanDetails: { planName: { contains: pkgName } } },
                                    { packagePlanDetails: { planCode: { contains: pkgName } } }
                                ],
                                ...(ispId ? { ispId } : {}),
                                isDeleted: false
                            },
                            include: {
                                packagePlanDetails: true
                            }
                        });
                    }

                    // 3. Auto-create Plan & PackagePrice if missing so exact package & duration are created
                    if (!packagePrice) {
                        let plan = await prisma.PackagePlan.findFirst({
                            where: {
                                OR: [
                                    { planName: { contains: pkgName } },
                                    { planCode: { contains: pkgName } }
                                ],
                                ...(ispId ? { ispId } : {}),
                                isDeleted: false
                            }
                        });

                        if (!plan) {
                            const planCode = slugify(pkgName).replace(/[^A-Z0-9]/g, '').substring(0, 16) || `PLAN${Date.now()}`;
                            const speedMbps = extractSpeedMbps(pkgName) || 100;
                            plan = await prisma.PackagePlan.create({
                                data: {
                                    planName: pkgName,
                                    planCode,
                                    serviceType: (row.serviceType || 'fiber').toString().trim().toLowerCase(),
                                    downloadSpeed: `${speedMbps} Mbps`,
                                    uploadSpeed: `${speedMbps} Mbps`,
                                    volume: 'Unlimited',
                                    validity: durationStr || '1 Month',
                                    nasType: (row.nas || 'juniper').toString().trim().toLowerCase(),
                                    isActive: true,
                                    isDeleted: false,
                                    ispId: ispId || 1
                                }
                            });
                        }

                        const baseRefId = `INT-${slugify(plan.planCode)}${slugify(durationStr)}`.replace(/[^A-Z0-9]/g, '');
                        const finalRefId = await generateUniqueReferenceId(prisma, baseRefId);
                        const rawPrice = parseFloat(row.price || row.packagePrice || row.amount || row['Package Price'] || row['Price'] || 0);

                        packagePrice = await prisma.PackagePrice.create({
                            data: {
                                planId: plan.id,
                                packageName: `${plan.planName} - ${durationStr}`,
                                packageDuration: durationStr,
                                price: rawPrice,
                                initialTotalWithTax: rawPrice ? Math.round(rawPrice * 1.13 * 100) / 100 : 0,
                                renewAmountWithTax: rawPrice ? Math.round(rawPrice * 1.13 * 100) / 100 : 0,
                                referenceId: finalRefId,
                                isActive: true,
                                isDeleted: false,
                                ispId: ispId || 1
                            },
                            include: {
                                packagePlanDetails: true
                            }
                        });
                    }

                    packageCache.set(pKey, packagePrice);
                }
            }

            if (!packagePrice && lead?.interestedPackageId) {
                packagePrice = await prisma.PackagePrice.findUnique({
                    where: { id: lead.interestedPackageId },
                    include: { packagePlanDetails: true }
                });
            }

            if (!packagePrice) {
                packagePrice = await prisma.PackagePrice.findFirst({
                    where: {
                        isActive: true,
                        isDeleted: false,
                        ...(ispId ? { ispId } : {})
                    },
                    include: {
                        packagePlanDetails: true
                    }
                });
            }

            const rawUsername = (row.username || row.Username || row.radiusUsername || row.pppoeUsername || row['PPPoE Username'] || row['Radius Username'] || row['Username'] || '').toString().trim();
            const rawPassword = (row.password || row.Password || row.radiusPassword || row.pppoePassword || row['PPPoE Password'] || row['Radius Password'] || row['Password'] || '').toString().trim();

            let existingCustomer = null;

            if (rawUsername) {
                const connUser = await prisma.ConnectionUser.findFirst({
                    where: { username: rawUsername, isDeleted: false },
                    include: { customer: true }
                });
                if (connUser && connUser.customer) {
                    existingCustomer = connUser.customer;
                }
            }

            const rawCustomId = (row.customerUniqueId || row.customerId || row.customerCode || row['Customer Code'] || row['Customer ID'] || row['Customer Id'] || '').toString().trim();
            if (!existingCustomer && rawCustomId) {
                existingCustomer = await prisma.Customer.findFirst({
                    where: { customerUniqueId: rawCustomId, ...(ispId ? { ispId } : {}) }
                });
            }

            if (!existingCustomer && panNo) {
                existingCustomer = await prisma.Customer.findFirst({
                    where: { panNo, ...(ispId ? { ispId } : {}) }
                });
            }

            if (!existingCustomer && idNumber && !idNumber.startsWith('ID-')) {
                existingCustomer = await prisma.Customer.findFirst({
                    where: { idNumber, ...(ispId ? { ispId } : {}) }
                });
            }

            if (!existingCustomer && (cleanEmail || phone)) {
                const candidateLead = await prisma.Lead.findFirst({
                    where: {
                        OR: [
                            ...(cleanEmail ? [{ email: cleanEmail }] : []),
                            ...(phone ? [{ phoneNumber: phone }] : [])
                        ],
                        ...(ispId ? { ispId } : {}),
                        isDeleted: false
                    },
                    include: { customers: true }
                });
                if (candidateLead && candidateLead.customers && candidateLead.customers.length > 0) {
                    existingCustomer = candidateLead.customers[0];
                    lead = candidateLead;
                }
            }

            if (existingCustomer) {
                if (skipExisting) {
                    logs.push({
                        rowNumber,
                        name: `${firstName} ${lastName} (${existingCustomer.customerUniqueId})`,
                        status: 'skipped',
                        message: `Customer '${existingCustomer.customerUniqueId}' already exists in CMS database.`
                    });
                    skippedCount++;
                    continue;
                }
                if (!lead && existingCustomer.leadId) {
                    lead = await prisma.Lead.findUnique({ where: { id: existingCustomer.leadId } });
                }
            }

            if (lead) {
                const otherCustomer = await prisma.Customer.findUnique({ where: { leadId: lead.id } });
                if (otherCustomer && (!existingCustomer || otherCustomer.id !== existingCustomer.id)) {
                    lead = null;
                }
            }

            if (!lead) {
                if (cleanEmail || phone) {
                    const candidate = await prisma.Lead.findFirst({
                        where: {
                            OR: [
                                ...(cleanEmail ? [{ email: cleanEmail }] : []),
                                ...(phone ? [{ phoneNumber: phone }] : [])
                            ],
                            ...(ispId ? { ispId } : {}),
                            isDeleted: false
                        }
                    });
                    if (candidate) {
                        const existingOtherCustomer = await prisma.Customer.findUnique({ where: { leadId: candidate.id } });
                        if (!existingOtherCustomer || (existingCustomer && existingOtherCustomer.id === existingCustomer.id)) {
                            lead = candidate;
                        }
                    }
                }
            }

            const rawRegisteredOn = row['Registered On'] || row['Registered on'] || row['Registration Date'] || row.registeredOn || row.createdAt || row['Created At'];
            const registeredAt = parseAnyDate(rawRegisteredOn);

            const addressVal = (row.address || row['Address'] || '').toString().trim() || null;
            const streetVal = (row.street || row['Street'] || '').toString().trim() || null;
            const cityVal = (row.district || row.city || row['District'] || row['City'] || '').toString().trim() || null;
            const provinceVal = (row.province || row.state || row['Province'] || row['State'] || '').toString().trim() || null;
            const sourceVal = (row.source || row['Source'] || 'customer_import').toString().trim();
            const notesVal = (row.notes || row['Notes'] || '').toString().trim() || null;

            if (!lead) {
                lead = await prisma.Lead.create({
                    data: {
                        firstName,
                        middleName,
                        lastName,
                        email: cleanEmail,
                        phoneNumber: phone || null,
                        secondaryContactNumber: altPhone || null,
                        address: addressVal,
                        street: streetVal,
                        district: cityVal,
                        province: provinceVal,
                        status: 'converted',
                        convertedToCustomer: true,
                        convertedAt: registeredAt || new Date(),
                        convertedById: req.user?.id || null,
                        branchId: branchId || null,
                        subBranchId: subBranchId || null,
                        ispId: ispId || 1,
                        source: sourceVal,
                        notes: notesVal,
                        interestedPackageId: packagePrice ? packagePrice.id : null,
                        isActive: true,
                        isDeleted: false,
                        createdAt: registeredAt || new Date()
                    }
                });
            } else {
                await prisma.Lead.update({
                    where: { id: lead.id },
                    data: {
                        firstName: firstName || lead.firstName,
                        middleName: middleName !== undefined ? middleName : lead.middleName,
                        lastName: lastName || lead.lastName,
                        email: cleanEmail || lead.email,
                        phoneNumber: phone || lead.phoneNumber,
                        status: 'converted',
                        convertedToCustomer: true,
                        convertedAt: lead.convertedAt || registeredAt || new Date(),
                        convertedById: lead.convertedById || req.user?.id || null,
                        secondaryContactNumber: altPhone || lead.secondaryContactNumber,
                        address: addressVal || lead.address,
                        district: cityVal || lead.district,
                        province: provinceVal || lead.province,
                        interestedPackageId: packagePrice ? packagePrice.id : lead.interestedPackageId,
                        ...(registeredAt ? { createdAt: registeredAt } : {})
                    }
                });
            }

            let customer = existingCustomer;

            if (!customer) {
                customer = await prisma.Customer.create({
                    data: {
                        leadId: lead.id,
                        panNo,
                        idNumber,
                        branchId: branchId || null,
                        subBranchId: subBranchId || null,
                        subscribedPkgId: packagePrice ? packagePrice.id : null,
                        customerTypeId: customerTypeId || null,
                        status: (row.status || row['Status'] || 'active').toString().trim().toLowerCase(),
                        onboardStatus: (row.onboardStatus || row['Onboard Status'] || 'fully_onboarded').toString().trim().toLowerCase(),
                        isRechargeable: row.isRechargeable !== undefined ? Boolean(row.isRechargeable) : true,
                        isFree: Boolean(row.isFree),
                        ispId: ispId || 1,
                        createdAt: registeredAt || new Date()
                    }
                });

                const generatedUniqueId = await generateCustomerUniqueId(
                    prisma,
                    customer.id,
                    firstName,
                    lastName,
                    'GEN',
                    branchId,
                    subBranchId,
                    ispId
                );

                let customerUniqueIdToUse = generatedUniqueId;
                if (rawCustomId) {
                    const alreadyTaken = await prisma.Customer.findFirst({
                        where: { customerUniqueId: rawCustomId, ...(ispId ? { ispId } : {}) }
                    });
                    if (!alreadyTaken) {
                        customerUniqueIdToUse = rawCustomId;
                    }
                }

                customer = await prisma.Customer.update({
                    where: { id: customer.id },
                    data: { customerUniqueId: customerUniqueIdToUse }
                });
            } else {
                customer = await prisma.Customer.update({
                    where: { id: customer.id },
                    data: {
                        branchId: branchId || customer.branchId,
                        subBranchId: subBranchId || customer.subBranchId,
                        subscribedPkgId: packagePrice ? packagePrice.id : customer.subscribedPkgId,
                        customerTypeId: customerTypeId || customer.customerTypeId,
                        status: (row.status || customer.status).toString().trim().toLowerCase(),
                        onboardStatus: 'fully_onboarded',
                        ...(panNo ? { panNo } : {}),
                        ...(idNumber && !idNumber.startsWith('ID-') ? { idNumber } : {}),
                        ...(registeredAt ? { createdAt: registeredAt } : {}),
                        updatedAt: new Date()
                    }
                });
            }

            const finalUsername = rawUsername || String(customer.customerUniqueId).toLowerCase().replace(/[^a-z0-9_.-]/g, '');
            const finalPassword = rawPassword || generateSecurePassword(10);

            let connectionUser = await prisma.ConnectionUser.findFirst({
                where: { customerId: customer.id, isDeleted: false }
            });

            if (connectionUser) {
                connectionUser = await prisma.ConnectionUser.update({
                    where: { id: connectionUser.id },
                    data: {
                        username: finalUsername,
                        password: finalPassword,
                        branchId: branchId || connectionUser.branchId,
                        updatedAt: new Date()
                    }
                });
            } else {
                connectionUser = await prisma.ConnectionUser.create({
                    data: {
                        customerId: customer.id,
                        username: finalUsername,
                        password: finalPassword,
                        branchId: branchId || null,
                        ispId: ispId || 1,
                        isActive: true,
                        isDeleted: false
                    }
                });
            }

            try {
                const loginEmail = cleanEmail || `${finalUsername.toLowerCase()}@customer.portal`;
                const passwordHash = await bcrypt.hash(finalPassword, 10);
                const customerName = `${firstName} ${lastName}`.trim() || customer.customerUniqueId;

                const existingPortalUser = await prisma.User.findFirst({
                    where: {
                        OR: [
                            { customerId: customer.id },
                            { email: loginEmail }
                        ]
                    }
                });

                if (existingPortalUser) {
                    await prisma.User.update({
                        where: { id: existingPortalUser.id },
                        data: {
                            customerId: customer.id,
                            name: customerName,
                            passwordHash,
                            branchId: branchId || existingPortalUser.branchId,
                            status: 'active',
                            updatedAt: new Date()
                        }
                    });
                } else {
                    await prisma.User.create({
                        data: {
                            email: loginEmail,
                            passwordHash,
                            name: customerName,
                            roleId: customerRole ? customerRole.id : null,
                            status: 'active',
                            ispId: ispId || 1,
                            branchId: branchId || null,
                            customerId: customer.id
                        }
                    });
                }
            } catch (usrErr) {
                console.warn(`[CUSTOMER IMPORT] User portal account note for row ${rowNumber}:`, usrErr.message);
            }

            if (nettvService) {
                try {
                    await prisma.CustomerSubscribedService.upsert({
                        where: {
                            customerId_serviceId: {
                                customerId: customer.id,
                                serviceId: nettvService.id
                            }
                        },
                        update: {
                            status: 'active',
                            externalUsername: finalUsername,
                            serviceData: {
                                username: finalUsername,
                                pppoeUsername: finalUsername,
                                syncedAt: new Date().toISOString()
                            }
                        },
                        create: {
                            customerId: customer.id,
                            serviceId: nettvService.id,
                            status: 'active',
                            externalUsername: finalUsername,
                            serviceData: {
                                username: finalUsername,
                                pppoeUsername: finalUsername,
                                syncedAt: new Date().toISOString()
                            }
                        }
                    });
                } catch (ntvErr) {
                    console.warn(`[CUSTOMER IMPORT] NetTV service mapping note for row ${rowNumber}:`, ntvErr.message);
                }
            }

            const rawPlanStart = row.planStart || row.startDate || row['Plan Start Date'] || row['Plan Start'] || row['Start Date'];
            const rawPlanEnd = row.planEnd || row.endDate || row.expiration || row.Expiration || row['Expiration'] || row['Plan End Date'] || row.expiryDate || row['Expiry Date'] || row['Plan End'] || row['End Date'];

            const parsedPlanStart = parseAnyDate(rawPlanStart);
            const parsedPlanEnd = parseAnyDate(rawPlanEnd);

            let planStart;
            if (parsedPlanStart) {
                planStart = atPlanBoundary(parsedPlanStart);
            } else if (parsedPlanEnd) {
                const computedStart = computeStartFromExpiry(parsedPlanEnd, durationStr);
                planStart = computedStart ? atPlanBoundary(computedStart) : atPlanBoundary(new Date());
            } else {
                planStart = atPlanBoundary(new Date());
            }

            let planEnd = parsedPlanEnd ? atPlanBoundary(parsedPlanEnd) : computeExpiryFromBase(planStart, durationStr);

            if (isNaN(planEnd.getTime())) {
                planEnd = computeExpiryFromBase(planStart, '1 Month');
            }

            let subscription = null;
            if (packagePrice) {
                subscription = await prisma.CustomerSubscription.findFirst({
                    where: { customerId: customer.id }
                });

                const isCustomerActive = (row.status || customer.status).toString().trim().toLowerCase() === 'active';

                if (subscription) {
                    subscription = await prisma.CustomerSubscription.update({
                        where: { id: subscription.id },
                        data: {
                            package: packagePrice.id,
                            planStart,
                            planEnd,
                            isActive: isCustomerActive,
                            isTrial: false,
                            isInvoicing: true,
                            updatedAt: new Date()
                        }
                    });
                } else {
                    subscription = await prisma.CustomerSubscription.create({
                        data: {
                            customerId: customer.id,
                            package: packagePrice.id,
                            planStart,
                            planEnd,
                            isActive: isCustomerActive,
                            isTrial: false,
                            isInvoicing: true
                        }
                    });
                }

                try {
                    const orderTotal = packagePrice.initialTotalWithTax || packagePrice.price || 0;
                    const existingOrder = await prisma.CustomerOrderManagement.findFirst({
                        where: { customerId: customer.id, subscriptionId: subscription.id, isDeleted: false },
                        orderBy: { id: 'desc' }
                    });

                    if (existingOrder) {
                        await prisma.CustomerOrderManagement.update({
                            where: { id: existingOrder.id },
                            data: {
                                package: packagePrice.id,
                                packageStart: planStart,
                                packageEnd: planEnd,
                                totalAmount: orderTotal,
                                updatedAt: new Date()
                            }
                        });
                        const existingDetail = await prisma.OrderDetail.findFirst({
                            where: { orderId: existingOrder.id }
                        });
                        if (existingDetail) {
                            await prisma.OrderDetail.update({
                                where: { id: existingDetail.id },
                                data: {
                                    itemName: packagePrice.packageName || 'Internet Subscription',
                                    referenceId: packagePrice.referenceId || null,
                                    itemPrice: packagePrice.price || 0
                                }
                            });
                        }
                    } else {
                        const order = await prisma.CustomerOrderManagement.create({
                            data: {
                                customerId: customer.id,
                                subscriptionId: subscription.id,
                                package: packagePrice.id,
                                orderDate: new Date(),
                                packageStart: planStart,
                                packageEnd: planEnd,
                                totalAmount: orderTotal,
                                isPaid: true,
                                isActive: true,
                                isDeleted: false
                            }
                        });

                        await prisma.OrderDetail.create({
                            data: {
                                orderId: order.id,
                                itemName: packagePrice.packageName || 'Internet Subscription',
                                referenceId: packagePrice.referenceId || null,
                                itemPrice: packagePrice.price || 0
                            }
                        });
                    }
                } catch (ordErr) {
                    console.warn(`[CUSTOMER IMPORT] Order record note for row ${rowNumber}:`, ordErr.message);
                }
            }

            let radiusSyncMsg = 'Radius sync skipped';
            if (radiusClient && finalUsername && finalPassword) {
                try {
                    const radiusGroupName = packagePrice?.packagePlanDetails?.planCode ||
                        packagePrice?.packagePlanDetails?.planName ||
                        packagePrice?.packageName ||
                        '';

                    const attributes = {
                        'Simultaneous-Use': '1'
                    };

                    if (planEnd && !isNaN(planEnd.getTime())) {
                        attributes.Expiration = formatRadiusExpiration(planEnd);
                    }

                    const groups = radiusGroupName ? [radiusGroupName] : [];
                    await radiusClient.createUser(finalUsername, finalPassword, attributes, groups);
                    await radiusClient.sendCoA(finalUsername, { action: 'disconnect' }).catch(() => null);

                    radiusSyncMsg = `FreeRADIUS Synced (User: ${finalUsername}, Group: ${radiusGroupName || 'Default'})`;
                } catch (rErr) {
                    radiusSyncMsg = `FreeRADIUS Sync Warning: ${rErr.message}`;
                }
            }

            const rawNas = (row.nas || row.nasName || row.nasIp || row['NAS'] || row['NAS Name'] || '').toString().trim();
            let resolvedNasId = row.nasId && !isNaN(row.nasId) ? Number(row.nasId) : null;
            if (rawNas && !resolvedNasId) {
                const nasKey = rawNas.toLowerCase();
                if (nasCache.has(nasKey)) {
                    resolvedNasId = nasCache.get(nasKey);
                } else {
                    const nasRec = await prisma.nas.findFirst({
                        where: {
                            OR: [
                                { nasname: { contains: rawNas } },
                                { shortname: { contains: rawNas } },
                                { server: { contains: rawNas } }
                            ],
                            ...(ispId ? { ispId } : {}),
                            isDeleted: false
                        }
                    });
                    resolvedNasId = nasRec ? nasRec.id : null;
                    nasCache.set(nasKey, resolvedNasId);
                }
            }

            const rawOlt = (row.olt || row.oltName || row.oltId || row['OLT Name'] || row['OLT'] || '').toString().trim();
            let resolvedOltId = row.oltId && !isNaN(row.oltId) ? Number(row.oltId) : null;
            if (rawOlt && !resolvedOltId) {
                const oltKey = rawOlt.toLowerCase();
                if (oltCache.has(oltKey)) {
                    resolvedOltId = oltCache.get(oltKey);
                } else {
                    const oltRec = await (prisma.oLT || prisma.OLT).findFirst({
                        where: {
                            OR: [
                                { name: { contains: rawOlt } },
                                { ipAddress: { contains: rawOlt } }
                            ],
                            ...(ispId ? { ispId } : {}),
                            isDeleted: false
                        }
                    });
                    resolvedOltId = oltRec ? oltRec.id : null;
                    oltCache.set(oltKey, resolvedOltId);
                }
            }

            const rawSplitter = (row.splitter || row.splitterName || row.splitterId || row['Splitter Name'] || row['Splitter'] || '').toString().trim();
            let resolvedSplitterId = row.splitterId && !isNaN(row.splitterId) ? Number(row.splitterId) : null;
            if (rawSplitter && !resolvedSplitterId) {
                const splitKey = rawSplitter.toLowerCase();
                if (splitterCache.has(splitKey)) {
                    resolvedSplitterId = splitterCache.get(splitKey);
                } else {
                    const splitRec = await prisma.Splitter.findFirst({
                        where: {
                            OR: [
                                { name: { contains: rawSplitter } },
                                { splitterId: { contains: rawSplitter } }
                            ],
                            ...(ispId ? { ispId } : {})
                        }
                    });
                    resolvedSplitterId = splitRec ? splitRec.id : null;
                    splitterCache.set(splitKey, resolvedSplitterId);
                }
            }

            const vlanRaw = (row.vlanId || row.vlan || row.vlans || row['VLAN ID'] || row['VLANs'] || row['Vlan'] || '').toString().trim();
            const parsedVlans = parseVlanList(vlanRaw);
            const oltVlanConfigs = parseOltVlans(row);

            // Auto-provision VLANs, Line Profile, and Service Profile into OLT if missing (strictly in local DB, no device push)
            if (resolvedOltId && (parsedVlans.length > 0 || oltVlanConfigs.length > 0)) {
                try {
                    const vlansToProcess = oltVlanConfigs.length > 0 ? oltVlanConfigs : parsedVlans.map((v, idx) => ({
                        vlanId: v,
                        name: row.vlanName || row['VLAN Name'] || `VLAN ${v}`,
                        gemIndex: !isNaN(parseInt(row.gemIndex || row.gemPort, 10)) ? parseInt(row.gemIndex || row.gemPort, 10) : v,
                        vlanType: (row.vlanType || row['VLAN Type'] || 'standard').toString().trim(),
                        description: (row.vlanDescription || row['VLAN Description'] || `Auto-provisioned for customer ${customer.customerUniqueId}`).toString().trim()
                    }));

                    for (const vObj of vlansToProcess) {
                        const existingVlan = await (prisma.oLTVLAN || prisma.OLTVLAN).findFirst({
                            where: {
                                oltId: resolvedOltId,
                                vlanId: vObj.vlanId
                            }
                        });

                        if (!existingVlan) {
                            await (prisma.oLTVLAN || prisma.OLTVLAN).create({
                                data: {
                                    oltId: resolvedOltId,
                                    vlanId: vObj.vlanId,
                                    name: vObj.name || `VLAN ${vObj.vlanId}`,
                                    description: vObj.description || `Auto-provisioned for customer ${customer.customerUniqueId}`,
                                    gemIndex: vObj.gemIndex || vObj.vlanId,
                                    vlanType: vObj.vlanType || 'standard',
                                    priority: 0,
                                    status: 'active'
                                }
                            });
                        }
                    }

                    // Line & Service Profiles
                    const parsedProfiles = parseOltProfiles(row, vlansToProcess.map(v => v.vlanId));
                    if (parsedProfiles.lineProfiles.length === 0 && (row.lineProfile || row.lineProfileName || pkgName)) {
                        const speedMbps = extractSpeedMbps(pkgName);
                        const lineProfName = (row.lineProfile || row.lineProfileName || row['Line Profile'] || row['Line Profile Name'] || (pkgName ? `LineProfile_${slugify(pkgName).substring(0, 20)}` : `LineProfile_${vlansToProcess[0]?.vlanId || 100}`)).toString().trim();
                        const lineProfId = (row.profileId || row['Profile ID'] || row.lineProfileId || row['Line Profile ID'] || lineProfName).toString().trim();
                        parsedProfiles.lineProfiles.push({
                            profileId: lineProfId,
                            name: lineProfName,
                            type: 'line',
                            description: `Auto-provisioned Line Profile for ${pkgName || 'Internet Plan'}`,
                            upstreamBandwidth: `${speedMbps}M`,
                            downstreamBandwidth: `${speedMbps}M`,
                            tcontType: 'type4'
                        });
                    }

                    if (parsedProfiles.serviceProfiles.length === 0 && (row.serviceProfile || row.serviceProfileName || vlansToProcess.length > 0)) {
                        const servProfName = (row.serviceProfile || row.serviceProfileName || row['Service Profile'] || row['Service Profile Name'] || `ServiceProfile_VLAN_${vlansToProcess[0]?.vlanId || 100}`).toString().trim();
                        const servProfId = (row.profileId || row['Profile ID'] || row.serviceProfileId || row['Service Profile ID'] || servProfName).toString().trim();
                        parsedProfiles.serviceProfiles.push({
                            profileId: servProfId,
                            name: servProfName,
                            type: 'service',
                            description: `Auto-provisioned Service Profile for VLAN(s) ${vlansToProcess.map(v => v.vlanId).join(', ')}`,
                            vlans: vlansToProcess.map(v => v.vlanId),
                            services: ['internet', 'voice', 'iptv', 'management'],
                            qosProfile: 'default'
                        });
                    }

                    for (const lp of parsedProfiles.lineProfiles) {
                        const existingLineProf = await (prisma.oLTProfile || prisma.OLTProfile).findFirst({
                            where: {
                                oltId: resolvedOltId,
                                type: 'line',
                                OR: [
                                    { profileId: lp.profileId },
                                    { name: lp.name }
                                ]
                            }
                        });

                        if (!existingLineProf) {
                            await (prisma.oLTProfile || prisma.OLTProfile).create({
                                data: {
                                    oltId: resolvedOltId,
                                    profileId: lp.profileId,
                                    name: lp.name,
                                    type: 'line',
                                    description: lp.description,
                                    upstreamBandwidth: lp.upstreamBandwidth,
                                    downstreamBandwidth: lp.downstreamBandwidth,
                                    tcontType: lp.tcontType || 'type4'
                                }
                            });
                        }
                    }

                    for (const sp of parsedProfiles.serviceProfiles) {
                        const existingServProf = await (prisma.oLTProfile || prisma.OLTProfile).findFirst({
                            where: {
                                oltId: resolvedOltId,
                                type: 'service',
                                OR: [
                                    { profileId: sp.profileId },
                                    { name: sp.name }
                                ]
                            }
                        });

                        if (!existingServProf) {
                            await (prisma.oLTProfile || prisma.OLTProfile).create({
                                data: {
                                    oltId: resolvedOltId,
                                    profileId: sp.profileId,
                                    name: sp.name,
                                    type: 'service',
                                    description: sp.description,
                                    vlans: JSON.stringify(sp.vlans),
                                    services: JSON.stringify(sp.services),
                                    qosProfile: sp.qosProfile || 'default'
                                }
                            });
                        }
                    }
                } catch (oltProvErr) {
                    console.warn(`[CUSTOMER IMPORT] OLT VLAN/Profile auto-provision note for row ${rowNumber}:`, oltProvErr.message);
                }
            }

            const oltPort = (row.oltPort || row.oltPonNumber || row['OLT Port'] || row['OLT PON Number'] || row.port || '').toString().trim();
            const splitterPort = (row.splitterPort || row['Splitter Port'] || '').toString().trim();
            const connType = (row.serviceType || row.connectionType || row['Service Type'] || row['Connection Type'] || 'fiber').toString().trim().toLowerCase();
            const vlanString = parsedVlans.length > 0 ? parsedVlans.join(', ') : (vlanRaw || null);

            if (resolvedOltId || resolvedSplitterId || vlanString || oltPort || splitterPort || connType) {
                try {
                    const existingConn = await prisma.CustomerServiceConnection.findFirst({
                        where: { customerId: customer.id }
                    });
                    if (existingConn) {
                        await prisma.CustomerServiceConnection.update({
                            where: { id: existingConn.id },
                            data: {
                                oltId: resolvedOltId || existingConn.oltId,
                                splitterId: resolvedSplitterId || existingConn.splitterId,
                                oltPort: oltPort || existingConn.oltPort,
                                splitterPort: splitterPort || existingConn.splitterPort,
                                vlanId: vlanString || existingConn.vlanId,
                                connectionType: connType || existingConn.connectionType || 'fiber',
                                status: 'active'
                            }
                        });
                    } else {
                        await prisma.CustomerServiceConnection.create({
                            data: {
                                customerId: customer.id,
                                oltId: resolvedOltId || null,
                                splitterId: resolvedSplitterId || null,
                                oltPort: oltPort || null,
                                splitterPort: splitterPort || null,
                                vlanId: vlanString,
                                connectionType: connType || 'fiber',
                                status: 'active'
                            }
                        });
                    }

                    if (resolvedOltId || resolvedSplitterId) {
                        await prisma.Customer.update({
                            where: { id: customer.id },
                            data: {
                                oltId: resolvedOltId || customer.oltId,
                                splitterId: resolvedSplitterId || customer.splitterId
                            }
                        });
                    }
                } catch (connErr) {}
            }

            const serialNumber = (row.serialNumber || row.ontSerial || row['ONT Serial'] || row.deviceSerial || row['Device Serial Number'] || row['Serial Number'] || row.ponSerial || row['PON Serial'] || '').toString().trim();
            const ponSerial = (row.ponSerial || row['PON Serial'] || serialNumber || '').toString().trim() || null;
            const finalSerial = serialNumber || ponSerial || null;
            const finalPonSerial = ponSerial || serialNumber || null;

            const rawMac = (row.macAddress || row['MAC Address'] || row.mac || '').toString().trim();
            const macAddress = formatMacToDotNotation(rawMac);

            const brand = (row.brand || row.deviceBrand || row['Device Brand'] || row['Brand'] || '').toString().trim() || null;
            const model = (row.model || row.deviceModel || row['Device Model'] || row['Model'] || '').toString().trim() || null;
            const rawDevType = (row.deviceType || row['Device Type'] || 'ONT').toString().trim().toUpperCase();

            let devTypeEnum = 'ONT';
            if (rawDevType.includes('ROUT')) devTypeEnum = 'ROUTE';
            else if (rawDevType.includes('STB') || rawDevType.includes('BOX') || rawDevType.includes('TV')) devTypeEnum = 'STB';
            else devTypeEnum = 'ONT';

            if (finalSerial || macAddress) {
                try {
                    const existingDev = await prisma.CustomerDevice.findFirst({
                        where: { customerId: customer.id }
                    });
                    if (existingDev) {
                        await prisma.CustomerDevice.update({
                            where: { id: existingDev.id },
                            data: {
                                serialNumber: finalSerial || existingDev.serialNumber,
                                macAddress: macAddress || existingDev.macAddress,
                                brand: brand || existingDev.brand,
                                model: model || existingDev.model,
                                ponSerial: finalPonSerial || existingDev.ponSerial,
                                deviceType: devTypeEnum,
                                provisioningStatus: 'active'
                            }
                        });
                    } else {
                        await prisma.CustomerDevice.create({
                            data: {
                                customerId: customer.id,
                                deviceType: devTypeEnum,
                                serialNumber: finalSerial || null,
                                macAddress: macAddress || null,
                                brand,
                                model,
                                ponSerial: finalPonSerial || null,
                                provisioningStatus: 'active'
                            }
                        });
                    }

                    let invItem = null;
                    if (finalSerial) {
                        invItem = await prisma.InventoryItem.findFirst({
                            where: {
                                OR: [
                                    { serialNumber: finalSerial },
                                    { ponSerialNumber: finalSerial }
                                ],
                                ...(ispId ? { ispId } : {})
                            }
                        });
                    }
                    if (!invItem && macAddress) {
                        invItem = await prisma.InventoryItem.findFirst({
                            where: {
                                macAddress: macAddress,
                                ...(ispId ? { ispId } : {})
                            }
                        });
                    }

                    if (invItem) {
                        const prevStatus = invItem.status;
                        await prisma.InventoryItem.update({
                            where: { id: invItem.id },
                            data: {
                                status: 'ASSIGNED_TO_CUSTOMER',
                                customerId: customer.id,
                                userId: null,
                                branchId: branchId || invItem.branchId,
                                updatedAt: new Date()
                            }
                        });
                        await prisma.InventoryLog.create({
                            data: {
                                inventoryItemId: invItem.id,
                                fromStatus: prevStatus,
                                toStatus: 'ASSIGNED_TO_CUSTOMER',
                                entityType: 'CUSTOMER',
                                toEntityId: customer.id,
                                actionByUserId: req.user?.id || null,
                                note: `Auto-assigned to customer ${customer.customerUniqueId || customer.id} during import`
                            }
                        });
                    } else {
                        const newInv = await prisma.InventoryItem.create({
                            data: {
                                type: devTypeEnum,
                                name: model || brand || `${devTypeEnum} Device`,
                                serialNumber: finalSerial || null,
                                ponSerialNumber: finalPonSerial || finalSerial || null,
                                macAddress: macAddress || null,
                                model: model || null,
                                status: 'ASSIGNED_TO_CUSTOMER',
                                customerId: customer.id,
                                branchId: branchId || null,
                                ispId: ispId || 1,
                                qty: 1,
                                availableQty: 0,
                                updatedAt: new Date()
                            }
                        });
                        await prisma.InventoryLog.create({
                            data: {
                                inventoryItemId: newInv.id,
                                fromStatus: 'IN_STOCK',
                                toStatus: 'ASSIGNED_TO_CUSTOMER',
                                entityType: 'CUSTOMER',
                                toEntityId: customer.id,
                                actionByUserId: req.user?.id || null,
                                note: `Auto-created and assigned to customer ${customer.customerUniqueId || customer.id} during import`
                            }
                        });
                    }
                } catch (devErr) {
                    console.warn(`[CUSTOMER IMPORT] Device auto-provisioning note for row ${rowNumber}:`, devErr.message);
                }
            }

            const expDateFormatted = (!isNaN(planEnd?.getTime()))
                ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kathmandu' }).format(planEnd)
                : 'N/A';
            logs.push({
                rowNumber,
                name: `${customer.customerUniqueId} (${firstName} ${lastName})`,
                status: 'success',
                message: `✓ Customer ensured | Lead #${lead.id}${leadLoadedFromDb ? ' (Loaded from Lead)' : ''} | PPPoE: ${finalUsername} | Plan: ${packagePrice ? packagePrice.packageName : 'Standard'} (Exp: ${expDateFormatted}) | ${radiusSyncMsg}`
            });
            successCount++;

        } catch (err) {
            console.error(`Error importing customer row ${rowNumber}:`, err);
            logs.push({
                rowNumber,
                name: `${firstName} ${lastName}`,
                status: 'failed',
                message: `Failed: ${err.message}`
            });
            failedCount++;
        }
    }

    res.json({
        success: true,
        total: items.length,
        successCount,
        skippedCount,
        failedCount,
        logs
    });
}

// ==========================================
// 6. SAMPLE TEMPLATE EXPORT (XLSX, CSV, JSON)
// ==========================================
async function getSampleTemplate(req, res, next) {
    try {
        const { type } = req.params; // 'branches' | 'plans' | 'packages' | 'leads' | 'customers'
        const format = (req.query.format || 'xlsx').toLowerCase(); // 'xlsx' | 'csv' | 'json'

        let sampleRows = [];
        let filename = `sample_${type}_import`;

        if (type === 'branches') {
            filename = 'sample_branches_import';
            sampleRows = [
                {
                    'Branch Name': 'Arrownet',
                    'Code': 'ARN-HEAD',
                    'Sub-Branch Name': 'Arrownet',
                    'Sub-Branch Code': 'ARN-HQ',
                    'Address': 'Kathmandu Main Road',
                    'Phone': '9801191325',
                    'Email': 'head@arrownet.com.np',
                    'Status': 'active'
                },
                {
                    'Branch Name': 'Charikot',
                    'Code': 'CHK-01',
                    'Sub-Branch Name': 'Bhimeshwor',
                    'Sub-Branch Code': 'BHM-01',
                    'Address': 'Charikot Bazar, Dolakha',
                    'Phone': '9801198711',
                    'Email': 'charikot@arrownet.com.np',
                    'Status': 'active'
                },
                {
                    'Branch Name': 'Khadichaur',
                    'Code': 'KDC-01',
                    'Sub-Branch Name': 'Barhabisa Municipality Sindhupalchok',
                    'Sub-Branch Code': 'BRB-01',
                    'Address': 'Barhabise Chowk, Sindhupalchok',
                    'Phone': '9802022610',
                    'Email': 'khadichaur@arrownet.com.np',
                    'Status': 'active'
                }
            ];
        } else if (type === 'plans' || type === 'package-plans') {
            filename = 'sample_speed_plans_import';
            sampleRows = [
                {
                    'Plan Name': '155 Mbps',
                    'Plan Code': '155 MBPS',
                    'Service': '155 Mbps',
                    'NAS Type': 'cisco, juniper, mikrotik, nokia',
                    'Priority': 1,
                    'Package Type': 'HOME',
                    'Connection Type': 'FTTH',
                    'Download Speed (Mbps)': 155,
                    'Upload Speed (Mbps)': 155,
                    'INT Upload': 155,
                    'FIR Download': 155,
                    'Local Upload': 155,
                    'Local Download': 155,
                    'Organization': 'ARROWNET Pvt. Ltd.',
                    'Branch': 'ARROWNET Pvt. Ltd.',
                    'Allow Rename': 'FALSE',
                    'FUP Apply': 'TRUE',
                    'Is FUP Package': 'FALSE',
                    'Only Renewal': 'FALSE',
                    'Popular': 'TRUE',
                    'High Priority': 'TRUE',
                    'FUP Limit (GB)': 0,
                    'Apply Framed Pool': 'TRUE',
                    'Framed Pool Value': 'Pool 2 (pool2)',
                    'Vendor-Specific Profiles': 'JUNIPER:xFTTH-pp0',
                    'Custom Radius Attributes': 'ERX-IPv6-Delegated-Pool-Name := v6-default-pd\nFramed-IPv6-Pool := v6-ndra',
                    'Description': 'Ultra High Speed 155 Mbps FTTH Internet'
                },
                {
                    'Plan Name': '100 Mbps',
                    'Plan Code': '100 MBPS',
                    'Service': 'Internet',
                    'NAS Type': 'mikrotik, juniper',
                    'Priority': 1,
                    'Package Type': 'HOME',
                    'Connection Type': 'Fiber',
                    'Download Speed (Mbps)': 100,
                    'Upload Speed (Mbps)': 100,
                    'INT Upload': 100,
                    'FIR Download': 100,
                    'Local Upload': 100,
                    'Local Download': 100,
                    'Organization': 'ARROWNET Pvt. Ltd.',
                    'Branch': 'Arrownet RTC',
                    'Allow Rename': 'FALSE',
                    'FUP Apply': 'TRUE',
                    'Is FUP Package': 'FALSE',
                    'Only Renewal': 'FALSE',
                    'Popular': 'TRUE',
                    'High Priority': 'FALSE',
                    'FUP Limit (GB)': 0,
                    'Apply Framed Pool': 'FALSE',
                    'Framed Pool Value': '',
                    'Vendor-Specific Profiles': '',
                    'Custom Radius Attributes': '',
                    'Description': 'Standard 100 Mbps Unlimited Fiber Internet'
                }
            ];
        } else if (type === 'packages' || type === 'tariffs') {
            filename = 'sample_packages_and_tariffs';
            sampleRows = [
                {
                    'Plan Name': '100 Mbps',
                    'Package Reference Name': 'Premium Fiber 100M',
                    'Duration': '1 Month',
                    'Enabled': 'TRUE',
                    'Online': 'FALSE',
                    'Package Items': 'Internet: 500, Support And Maintance: 500, Drop Wire: 0, Douplex Router: 0'
                },
                {
                    'Plan Name': '100 Mbps',
                    'Package Reference Name': 'Premium Fiber 100M',
                    'Duration': '3 Months',
                    'Enabled': 'TRUE',
                    'Online': 'FALSE',
                    'Package Items': 'Internet: 1400, Support And Maintance: 1400, Drop Wire: 0, Douplex Router: 0'
                },
                {
                    'Plan Name': '100 Mbps',
                    'Package Reference Name': 'Premium Fiber 100M',
                    'Duration': '6 Months',
                    'Enabled': 'TRUE',
                    'Online': 'FALSE',
                    'Package Items': 'Internet: 2700, Support And Maintance: 2700, Drop Wire: 0, Douplex Router: 0'
                },
                {
                    'Plan Name': '100 Mbps',
                    'Package Reference Name': 'Premium Fiber 100M',
                    'Duration': '12 Months',
                    'Enabled': 'TRUE',
                    'Online': 'TRUE',
                    'Package Items': 'Internet: 5200, Support And Maintance: 5200, Drop Wire: 0, Douplex Router: 0'
                },
                {
                    'Plan Name': '50 Mbps',
                    'Package Reference Name': 'Standard Fiber 50M',
                    'Duration': '1 Month',
                    'Enabled': 'TRUE',
                    'Online': 'FALSE',
                    'Package Items': 'Internet: 250, Support And Maintance: 250, Drop Wire: 0, Douplex Router: 0'
                }
            ];
        } else if (type === 'leads') {
            filename = 'sample_leads_crm';
            sampleRows = [
                {
                    'First Name': 'Bikash',
                    'Middle Name': '',
                    'Last Name': 'Shrestha',
                    'Phone Number': '9841234567',
                    'Email': 'bikash.shrestha@example.com',
                    'Address': 'Main Chowk',
                    'City': 'Kathmandu',
                    'Province': 'Bagmati',
                    'Branch Name': 'Arrownet',
                    'Sub-Branch Name': 'Arrownet',
                    'Interested Package': '100 Mbps',
                    'Status': 'qualified',
                    'Source': 'Website Inquiry',
                    'Notes': 'High speed fiber requested for office setup'
                },
                {
                    'First Name': 'Prakash',
                    'Middle Name': '',
                    'Last Name': 'Dahal',
                    'Phone Number': '9801191325',
                    'Email': 'prakash.dahal@example.com',
                    'Address': 'Bhimeshwor Main Road',
                    'City': 'Charikot',
                    'Province': 'Bagmati',
                    'Branch Name': 'Charikot',
                    'Sub-Branch Name': 'Bhimeshwor',
                    'Interested Package': '50 Mbps',
                    'Status': 'qualified',
                    'Source': 'Walk-in',
                    'Notes': 'Ready for fiber installation tomorrow'
                }
            ];
        } else if (type === 'customers') {
            filename = 'sample_customers_complete';
            sampleRows = [
                {
                    'First Name': 'Prakash',
                    'Middle Name': '',
                    'Last Name': 'Dahal',
                    'Phone Number': '9801191325',
                    'Alternative Phone Number': '9841234567',
                    'Email': 'prakash.dahal@example.com',
                    'Address': 'Bhimeshwor Main Road',
                    'City': 'Charikot',
                    'Province': 'Bagmati',
                    'Branch Name': 'Charikot',
                    'Sub-Branch Name': 'Bhimeshwor',
                    'PAN Number': '',
                    'Citizenship Number': '24-02-72-98765',
                    'Customer Type': 'Home',
                    'Service Type': 'Fiber',
                    'NAS': 'Mikrotik-Charikot-01',
                    'Package Name': '50 Mbps',
                    'Duration': '3 Months',
                    'Plan Start Date': new Date().toISOString().split('T')[0],
                    'Plan End Date': new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
                    'PPPoE Username': 'prakash_chk50',
                    'PPPoE Password': 'User@12345',
                    'OLT Name': 'OLT-Charikot-01',
                    'OLT Port': '0/1/2',
                    'Splitter Name': 'SPL-02',
                    'Splitter Port': 'Port 2',
                    'VLAN IDs': '527, 528',
                    'VLAN Names': '527_ACS, 528_INTERNET',
                    'GEM Indices': '6, 7',
                    'Line Profile ID': '12',
                    'Line Profile Name': 'KISAN_LINE_100M',
                    'Service Profile ID': '12',
                    'Service Profile Name': 'KISAN_SERV_FTTH',
                    'Services': 'internet, voice, iptv, management',
                    'Upstream Bandwidth': '100M',
                    'Downstream Bandwidth': '1G',
                    'Device Type': 'ONT',
                    'Device Brand': 'Huawei',
                    'Device Model': 'HG8145V5',
                    'Device Serial Number': 'HWTC782103',
                    'PON Serial': 'HWTC782103',
                    'MAC Address': '744d.2890.1234',
                    'Status': 'active',
                    'Source': 'customer_import',
                    'Notes': 'Installed via Splitter SPL-02 Port 2 with multiple VLANs',
                    'Lead ID': ''
                },
                {
                    'First Name': 'Sunil',
                    'Middle Name': 'Bahadur',
                    'Last Name': 'Khadka',
                    'Phone Number': '9802022610',
                    'Alternative Phone Number': '9812345678',
                    'Email': 'sunil.khadka@example.com',
                    'Address': 'Barhabise Chowk',
                    'City': 'Sindhupalchok',
                    'Province': 'Bagmati',
                    'Branch Name': 'Khadichaur',
                    'Sub-Branch Name': 'Barhabisa Municipality Sindhupalchok',
                    'PAN Number': '609876543',
                    'Citizenship Number': '22-01-68-55443',
                    'Customer Type': 'Enterprise',
                    'Service Type': 'Fiber',
                    'NAS': 'Mikrotik-Khadichaur-01',
                    'Package Name': '100 Mbps',
                    'Duration': '12 Months',
                    'Plan Start Date': new Date().toISOString().split('T')[0],
                    'Plan End Date': new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
                    'PPPoE Username': 'sunil_ent100',
                    'PPPoE Password': 'User@12345',
                    'OLT Name': 'OLT-Khadichaur-01',
                    'OLT Port': '0/1/3',
                    'Splitter Name': 'SPL-03',
                    'Splitter Port': 'Port 1',
                    'VLAN IDs': '103, 104',
                    'VLAN Names': '103_ENT, 104_MGMT',
                    'GEM Indices': '3, 4',
                    'Line Profile ID': '14',
                    'Line Profile Name': 'ENT_LINE_1G',
                    'Service Profile ID': '14',
                    'Service Profile Name': 'ENT_SERV_1G',
                    'Services': 'internet, management',
                    'Upstream Bandwidth': '100M',
                    'Downstream Bandwidth': '1G',
                    'Device Type': 'ONT',
                    'Device Brand': 'ZTE',
                    'Device Model': 'F670L',
                    'Device Serial Number': 'ZTEGC901234',
                    'PON Serial': 'ZTEGC901234',
                    'MAC Address': '9000.4e55.6677',
                    'Status': 'active',
                    'Source': 'Direct Sale',
                    'Notes': 'Direct Enterprise Fiber Connection with multi-vlan trunk',
                    'Lead ID': ''
                },
                {
                    'First Name': 'Bikash',
                    'Middle Name': '',
                    'Last Name': 'Shrestha',
                    'Phone Number': '9841234567',
                    'Alternative Phone Number': '',
                    'Email': 'bikash.shrestha@example.com',
                    'Address': 'Main Chowk',
                    'City': 'Kathmandu',
                    'Province': 'Bagmati',
                    'Branch Name': 'Arrownet',
                    'Sub-Branch Name': 'Arrownet',
                    'PAN Number': '601234567',
                    'Citizenship Number': '27-01-70-12345',
                    'Customer Type': 'Home',
                    'Service Type': 'Fiber',
                    'NAS': 'Mikrotik-Main-01',
                    'Package Name': '100 Mbps',
                    'Duration': '1 Month',
                    'Plan Start Date': new Date().toISOString().split('T')[0],
                    'Plan End Date': new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
                    'PPPoE Username': 'bikash_arn1001',
                    'PPPoE Password': 'User@12345',
                    'OLT Name': 'OLT-Akar-01',
                    'OLT Port': '0/1/1',
                    'Splitter Name': 'SPL-01',
                    'Splitter Port': 'Port 1',
                    'VLAN IDs': '101, 102',
                    'VLAN Names': '101_DEFAULT, 102_IPTV',
                    'GEM Indices': '1, 2',
                    'Line Profile ID': '10',
                    'Line Profile Name': 'HOME_LINE_100M',
                    'Service Profile ID': '10',
                    'Service Profile Name': 'HOME_SERV_FTTH',
                    'Services': 'internet, iptv',
                    'Upstream Bandwidth': '100M',
                    'Downstream Bandwidth': '1G',
                    'Device Type': 'ONT',
                    'Device Brand': 'Nokia',
                    'Device Model': 'G-2425G-A',
                    'Device Serial Number': 'ALCLB892109',
                    'PON Serial': 'ALCLB892109',
                    'MAC Address': '488f.5a12.3456',
                    'Status': 'active',
                    'Source': 'CRM Lead Conversion',
                    'Notes': 'Converted from Lead #21048',
                    'Lead ID': '21048'
                }
            ];
        } else if (type === 'olts' || type === 'olt') {
            filename = 'sample_olts_complete';
            sampleRows = [
                {
                    'OLT Name': 'OLT-Charikot-01',
                    'IP Address': '192.168.10.10',
                    'Vendor': 'Huawei',
                    'Model': 'MA5608T',
                    'Status': 'online',
                    'Branch Name': 'Charikot',
                    'Username': 'admin',
                    'Password': 'Admin@12345',
                    'Default Transport': 'ssh',
                    'SSH Port': 22,
                    'Telnet Port': 23,
                    'Telnet Enabled': true,
                    'SNMP Community': 'public',
                    'Number of Service Boards': 2,
                    'Board Type': 'GPON',
                    'Ports per Board': 16,
                    'Service Boards': '[{"slot": 1, "type": "GPON", "portCount": 16}, {"slot": 2, "type": "GPON", "portCount": 16}]',
                    'VLAN ID': '527',
                    'VLAN Name': '527_ACS',
                    'GEM Index': '6',
                    'VLANs': '527, 101, 102',
                    'Profile ID': '12',
                    'Profile Name': 'KISAN_FTTH',
                    'Services': 'internet, voice, iptv, management',
                    'Upstream Bandwidth': '100M',
                    'Downstream Bandwidth': '1G',
                    'Line Profiles': '12:KISAN_FTTH:100M:1G',
                    'Service Profiles': '12:KISAN_FTTH',
                    'Region': 'Bagmati',
                    'Site': 'Charikot POP',
                    'Rack': 1,
                    'Position': 1,
                    'Latitude': 27.6710,
                    'Longitude': 85.3240,
                    'Notes': 'Main GPON distribution OLT for Charikot area'
                },
                {
                    'OLT Name': 'OLT-Khadichaur-01',
                    'IP Address': '192.168.20.10',
                    'Vendor': 'ZTE',
                    'Model': 'C320',
                    'Status': 'online',
                    'Branch Name': 'Khadichaur',
                    'Username': 'admin',
                    'Password': 'Admin@12345',
                    'Default Transport': 'ssh',
                    'SSH Port': 22,
                    'Telnet Port': 23,
                    'Telnet Enabled': false,
                    'SNMP Community': 'public',
                    'Number of Service Boards': 1,
                    'Board Type': 'GPON',
                    'Ports per Board': 16,
                    'Service Boards': '[{"slot": 1, "type": "GPON", "portCount": 16}]',
                    'VLAN ID': '103',
                    'VLAN Name': '103_INTERNET',
                    'GEM Index': '3',
                    'VLANs': '101, 102, 103',
                    'Profile ID': '14',
                    'Profile Name': 'ENT_PROFILE',
                    'Services': 'internet, management',
                    'Upstream Bandwidth': '100M',
                    'Downstream Bandwidth': '1G',
                    'Line Profiles': '14:ENT_PROFILE:100M:1G',
                    'Service Profiles': '14:ENT_PROFILE',
                    'Region': 'Bagmati',
                    'Site': 'Khadichaur POP',
                    'Rack': 1,
                    'Position': 2,
                    'Latitude': 27.7500,
                    'Longitude': 85.8000,
                    'Notes': 'Distribution OLT for Khadichaur Branch'
                },
                {
                    'OLT Name': 'OLT-Akar-01',
                    'IP Address': '192.168.30.10',
                    'Vendor': 'VSOL',
                    'Model': 'V1600G',
                    'Status': 'online',
                    'Branch Name': 'Arrownet',
                    'Username': 'admin',
                    'Password': 'Admin@12345',
                    'Default Transport': 'ssh',
                    'SSH Port': 22,
                    'Telnet Port': 23,
                    'Telnet Enabled': false,
                    'SNMP Community': 'public',
                    'Number of Service Boards': 1,
                    'Board Type': 'EPON',
                    'Ports per Board': 8,
                    'Service Boards': '[{"slot": 1, "type": "EPON", "portCount": 8}]',
                    'VLAN ID': '101',
                    'VLAN Name': '101_DEFAULT',
                    'GEM Index': '1',
                    'VLANs': '101',
                    'Profile ID': '10',
                    'Profile Name': 'HOME_FIBER',
                    'Services': 'internet, iptv',
                    'Upstream Bandwidth': '100M',
                    'Downstream Bandwidth': '1G',
                    'Line Profiles': '10:HOME_FIBER:50M:50M',
                    'Service Profiles': '10:HOME_FIBER',
                    'Region': 'Bagmati',
                    'Site': 'Head Office Akar',
                    'Rack': 2,
                    'Position': 1,
                    'Latitude': 27.7172,
                    'Longitude': 85.3240,
                    'Notes': 'Core OLT at Arrownet HQ'
                }
            ];
        } else {
            return res.status(400).json({ error: 'Invalid template type. Supported types: branches, plans, packages, leads, customers, olts' });
        }

        if (format === 'json') {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}.json"`);
            return res.json(sampleRows);
        }

        if (format === 'csv') {
            const worksheet = xlsx.utils.json_to_sheet(sampleRows);
            const csvOutput = xlsx.utils.sheet_to_csv(worksheet);
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
            return res.send(csvOutput);
        }

        const worksheet = xlsx.utils.json_to_sheet(sampleRows);
        const workbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(workbook, worksheet, 'Sample Data');
        const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
        return res.send(buffer);

    } catch (err) {
        next(err);
    }
}

/**
 * Import OLTs
 */
async function importOlts(req, res, next) {
    const prisma = req.prisma;
    const ispId = req.ispId || (req.user && req.user.ispId) || 1;
    const logs = [];
    let importedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    try {
        let rows = [];
        if (req.file) {
            const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
            const sheetName = workbook.SheetNames[0];
            rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
        } else if (Array.isArray(req.body.rows)) {
            rows = req.body.rows;
        } else if (Array.isArray(req.body)) {
            rows = req.body;
        }

        if (!rows || rows.length === 0) {
            return res.status(400).json({ error: 'No OLT data rows found in uploaded payload.' });
        }

        const skipExisting = req.body.skipExisting === true || req.body.skipExisting === 'true';
        const branchCache = new Map();

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const rowNumber = i + 1;

            const name = (row.name || row.oltName || row['OLT Name'] || row['Name'] || '').toString().trim();
            const ipAddress = (row.ipAddress || row.ip || row['IP Address'] || row['IP'] || '').toString().trim();

            if (!name || !ipAddress) {
                logs.push({
                    rowNumber,
                    name: name || `Row ${rowNumber}`,
                    status: 'failed',
                    message: 'Missing required OLT Name or IP Address.'
                });
                failedCount++;
                continue;
            }

            const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
            if (!ipRegex.test(ipAddress)) {
                logs.push({
                    rowNumber,
                    name,
                    status: 'failed',
                    message: `Invalid IP address format: '${ipAddress}'.`
                });
                failedCount++;
                continue;
            }

            const vendor = (row.vendor || row.brand || row['Vendor'] || row['Brand'] || 'Huawei').toString().trim();
            const model = (row.model || row['Model'] || 'MA5608T').toString().trim();
            const status = (row.status || row['Status'] || 'offline').toString().trim().toLowerCase();
            const serialNumber = (row.serialNumber || row['Serial Number'] || '').toString().trim() || null;
            const firmwareVersion = (row.firmwareVersion || row['Firmware Version'] || '').toString().trim() || null;

            // Credentials & Transport: use same password for all password fields (sshPassword, sshEnablePassword, telnetPassword)
            const rawUsername = (row.username || row.sshUsername || row.telnetUsername || row['Username'] || row['SSH Username'] || row['Telnet Username'] || 'admin').toString().trim();
            const rawPassword = (row.password || row.sshPassword || row.telnetPassword || row.enablePassword || row['Password'] || row['SSH Password'] || row['Telnet Password'] || row['Enable Password'] || '').toString().trim();
            const defaultTransport = (row.transport || row.defaultTransport || row['Transport'] || row['Default Transport'] || 'ssh').toString().trim().toLowerCase() === 'telnet' ? 'telnet' : 'ssh';

            const sshPort = parseInt(row.sshPort || row['SSH Port'] || '22', 10) || 22;
            const telnetPort = parseInt(row.telnetPort || row['Telnet Port'] || '23', 10) || 23;
            const telnetEnabled = row.telnetEnabled !== undefined ? Boolean(row.telnetEnabled) : (defaultTransport === 'telnet');

            // Branch mapping
            const branchName = (row.branch || row.branchName || row['Branch Name'] || row['Branch'] || '').toString().trim();
            let branchId = row.branchId && !isNaN(row.branchId) ? Number(row.branchId) : null;
            if (branchName && !branchId) {
                const bKey = branchName.toLowerCase();
                if (branchCache.has(bKey)) {
                    branchId = branchCache.get(bKey);
                } else {
                    const br = await prisma.Branch.findFirst({
                        where: {
                            name: branchName,
                            ...(ispId ? { ispId: Number(ispId) } : {}),
                            isDeleted: false
                        }
                    });
                    branchId = br ? br.id : null;
                    branchCache.set(bKey, branchId);
                }
            }

            // Location & Management
            const region = (row.region || row['Region'] || '').toString().trim();
            const site = (row.site || row['Site'] || '').toString().trim();
            const rack = parseInt(row.rack || row['Rack'] || '1', 10) || 1;
            const position = parseInt(row.position || row['Position'] || '1', 10) || 1;
            const latitude = parseFloat(row.latitude || row['Latitude'] || 0) || 0;
            const longitude = parseFloat(row.longitude || row['Longitude'] || 0) || 0;
            const locationNotes = (row.locationNotes || row['Location Notes'] || '').toString().trim();
            const notes = (row.notes || row['Notes'] || '').toString().trim();

            const snmpCommunity = (row.snmpCommunity || row['SNMP Community'] || 'public').toString().trim();
            const snmpVersion = (row.snmpVersion || row['SNMP Version'] || 'v2c').toString().trim();

            // Service boards: array or number of boards, types, and ports
            const serviceBoards = parseServiceBoardsFromRow(row);
            const totalPorts = serviceBoards.reduce((sum, b) => sum + (b.portCount || 0), 0);
            const usedPorts = serviceBoards.reduce((sum, b) => sum + (b.usedPorts || 0), 0);
            const availablePorts = totalPorts - usedPorts;

            try {
                const existingOlt = await (prisma.oLT || prisma.OLT).findFirst({
                    where: {
                        OR: [
                            { ipAddress },
                            { name }
                        ],
                        ...(ispId ? { ispId: Number(ispId) } : {}),
                        isDeleted: false
                    },
                    include: {
                        serviceBoards: true
                    }
                });

                let oltRecord = null;

                if (existingOlt) {
                    if (skipExisting) {
                        logs.push({
                            rowNumber,
                            name: `${name} (${ipAddress})`,
                            status: 'skipped',
                            message: `OLT with IP ${ipAddress} or name '${name}' already exists in database.`
                        });
                        skippedCount++;
                        continue;
                    }

                    // Update existing OLT
                    oltRecord = await (prisma.oLT || prisma.OLT).update({
                        where: { id: existingOlt.id },
                        data: {
                            name,
                            ipAddress,
                            vendor,
                            model,
                            status: status || existingOlt.status,
                            serialNumber: serialNumber || existingOlt.serialNumber,
                            firmwareVersion: firmwareVersion || existingOlt.firmwareVersion,
                            totalPorts,
                            usedPorts,
                            availablePorts,
                            sshHost: ipAddress,
                            sshPort,
                            sshUsername: rawUsername,
                            sshPassword: rawPassword || existingOlt.sshPassword,
                            sshEnablePassword: rawPassword || existingOlt.sshEnablePassword,
                            telnetEnabled,
                            telnetPort,
                            telnetUsername: rawUsername,
                            telnetPassword: rawPassword || existingOlt.telnetPassword,
                            defaultTransport,
                            snmpCommunity,
                            snmpVersion,
                            region: region || existingOlt.region,
                            site: site || existingOlt.site,
                            rack: rack || existingOlt.rack,
                            position: position || existingOlt.position,
                            latitude: latitude || existingOlt.latitude,
                            longitude: longitude || existingOlt.longitude,
                            locationNotes: locationNotes || existingOlt.locationNotes,
                            notes: notes || existingOlt.notes,
                            branchId: branchId || existingOlt.branchId,
                            updatedAt: new Date()
                        }
                    });

                    // Sync service boards: create or update slots
                    for (const board of serviceBoards) {
                        const existingBoard = await (prisma.serviceBoard || prisma.ServiceBoard).findFirst({
                            where: { oltId: oltRecord.id, slot: board.slot }
                        });
                        if (existingBoard) {
                            await (prisma.serviceBoard || prisma.ServiceBoard).update({
                                where: { id: existingBoard.id },
                                data: {
                                    type: board.type,
                                    portCount: board.portCount,
                                    availablePorts: board.portCount - existingBoard.usedPorts,
                                    status: board.status || 'active'
                                }
                            });
                        } else {
                            await (prisma.serviceBoard || prisma.ServiceBoard).create({
                                data: {
                                    oltId: oltRecord.id,
                                    slot: board.slot,
                                    type: board.type,
                                    portCount: board.portCount,
                                    usedPorts: 0,
                                    availablePorts: board.portCount,
                                    status: 'active'
                                }
                            });
                        }
                    }

                    updatedCount++;
                } else {
                    // Create new OLT with nested serviceBoards
                    oltRecord = await (prisma.oLT || prisma.OLT).create({
                        data: {
                            name,
                            ipAddress,
                            vendor,
                            model,
                            status,
                            serialNumber,
                            firmwareVersion,
                            totalPorts,
                            usedPorts,
                            availablePorts,
                            sshHost: ipAddress,
                            sshPort,
                            sshUsername: rawUsername,
                            sshPassword: rawPassword,
                            sshEnablePassword: rawPassword,
                            telnetEnabled,
                            telnetPort,
                            telnetUsername: rawUsername,
                            telnetPassword: rawPassword,
                            defaultTransport,
                            snmpEnabled: true,
                            snmpCommunity,
                            snmpVersion,
                            webInterface: true,
                            webPort: 80,
                            region,
                            site,
                            rack,
                            position,
                            latitude,
                            longitude,
                            locationNotes,
                            notes,
                            ispId: Number(ispId),
                            branchId,
                            serviceBoards: {
                                create: serviceBoards.map(board => ({
                                    slot: board.slot,
                                    type: board.type,
                                    portCount: board.portCount,
                                    usedPorts: 0,
                                    availablePorts: board.portCount,
                                    status: 'active'
                                }))
                            }
                        }
                    });

                    importedCount++;
                }

                // VLANs provisioning
                const parsedOltVlans = parseOltVlans(row);
                for (const vlanObj of parsedOltVlans) {
                    const existingVlan = await (prisma.oLTVLAN || prisma.OLTVLAN).findFirst({
                        where: { oltId: oltRecord.id, vlanId: vlanObj.vlanId }
                    });
                    if (!existingVlan) {
                        await (prisma.oLTVLAN || prisma.OLTVLAN).create({
                            data: {
                                oltId: oltRecord.id,
                                vlanId: vlanObj.vlanId,
                                name: vlanObj.name,
                                description: vlanObj.description || `Imported VLAN for ${oltRecord.name}`,
                                gemIndex: vlanObj.gemIndex,
                                vlanType: vlanObj.vlanType || 'standard',
                                priority: 0,
                                status: 'active'
                            }
                        });
                    }
                }

                // Line & Service Profiles provisioning
                const parsedProfiles = parseOltProfiles(row, parsedOltVlans.map(v => v.vlanId));
                for (const lp of parsedProfiles.lineProfiles) {
                    const existingProf = await (prisma.oLTProfile || prisma.OLTProfile).findFirst({
                        where: {
                            oltId: oltRecord.id,
                            type: 'line',
                            OR: [
                                { profileId: lp.profileId },
                                { name: lp.name }
                            ]
                        }
                    });
                    if (!existingProf) {
                        await (prisma.oLTProfile || prisma.OLTProfile).create({
                            data: {
                                oltId: oltRecord.id,
                                profileId: lp.profileId,
                                name: lp.name,
                                type: 'line',
                                description: lp.description || `Line Profile ${lp.name}`,
                                upstreamBandwidth: lp.upstreamBandwidth || '100M',
                                downstreamBandwidth: lp.downstreamBandwidth || '1G',
                                tcontType: lp.tcontType || 'type4'
                            }
                        });
                    }
                }

                for (const sp of parsedProfiles.serviceProfiles) {
                    const existingSProf = await (prisma.oLTProfile || prisma.OLTProfile).findFirst({
                        where: {
                            oltId: oltRecord.id,
                            type: 'service',
                            OR: [
                                { profileId: sp.profileId },
                                { name: sp.name }
                            ]
                        }
                    });
                    if (!existingSProf) {
                        await (prisma.oLTProfile || prisma.OLTProfile).create({
                            data: {
                                oltId: oltRecord.id,
                                profileId: sp.profileId,
                                name: sp.name,
                                type: 'service',
                                description: sp.description || `Service Profile ${sp.name}`,
                                vlans: JSON.stringify(sp.vlans || []),
                                services: JSON.stringify(sp.services || ['internet', 'voice', 'iptv', 'management']),
                                qosProfile: sp.qosProfile || 'default'
                            }
                        });
                    }
                }

                logs.push({
                    rowNumber,
                    name: `${name} (${ipAddress})`,
                    status: existingOlt ? 'updated' : 'success',
                    message: `${existingOlt ? 'Updated' : 'Imported'} OLT '${name}' with ${serviceBoards.length} board(s), ${totalPorts} total ports, and credentials configured.`
                });

            } catch (rowErr) {
                logs.push({
                    rowNumber,
                    name,
                    status: 'failed',
                    message: `Error importing OLT '${name}': ${rowErr.message}`
                });
                failedCount++;
            }
        }

        return res.status(200).json({
            success: true,
            summary: {
                totalRows: rows.length,
                importedCount,
                updatedCount,
                skippedCount,
                failedCount
            },
            logs
        });

    } catch (err) {
        next(err);
    }
}

module.exports = {
    importBranches,
    importPlans,
    importPackages,
    importLeads,
    importCustomers,
    importOlts,
    getSampleTemplate
};
