const test = require('node:test');
const assert = require('node:assert/strict');
const HuaweiOLTDriver = require('../src/drivers/huawei/HuaweiOLTDriver');
const BdcomOLTDriver = require('../src/drivers/bdcom/BdcomOLTDriver');
const { normalizeMac } = require('../src/utils/macAddress');
const { normalizeWanConnections } = require('../src/services/tr069-wan-adapter.service');
const { GenieACSClient } = require('../src/services/genieacs.service');
const { generateRawToken, hashToken, validateScopes, validateIpRestrictions } = require('../src/controllers/apiToken.controller');
const { EXTERNAL_API_ROUTES } = require('../src/lib/externalApiCatalog');
const {
  ServiceController,
  collectTR069ParameterMetadata,
  extractWifiPassword,
  mergeWifiSnapshotPasswords,
  mergeConnectedDeviceRecords,
  normalizeReportedSignal
} = require('../src/controllers/services.controller');

const v = value => ({ _value: value, _type: typeof value });

test('MAC normalization accepts supported separators and rejects non-hex input', () => {
  assert.equal(normalizeMac('78:4F:24:62:FD:2F', 'huawei'), '784f-2462-fd2f');
  assert.equal(normalizeMac('784f-2462-fd2f', 'dotted'), '784f.2462.fd2f');
  assert.equal(normalizeMac('784f.2462.fd2f', 'colon'), '78:4f:24:62:fd:2f');
  assert.throws(() => normalizeMac('784f-2462-fd2z'), error => error.code === 'INVALID_MAC_ADDRESS');
  assert.throws(() => normalizeMac('784f2462fd2f;reboot'), error => error.code === 'INVALID_MAC_ADDRESS');
});

test('Huawei parser returns service port, F/S/P, ONT, GEM and VLAN', () => {
  const driver = new HuaweiOLTDriver({});
  const result = driver.parseMacAddressTable(`
 SRV-P BUNDLE TYPE MAC            MAC TYPE F /S /P   VPI  VCI VLAN ID
 12    -      gpon 784f-2462-fd2f dynamic  0 /5 /0   3    6   527
 `, '784f-2462-fd2f');
  assert.equal(result.length, 1);
  assert.deepEqual({
    servicePortIndex: result[0].servicePortIndex, frame: result[0].frame, slot: result[0].slot,
    port: result[0].port, ontId: result[0].ontId, gemIndex: result[0].gemIndex, vlan: result[0].vlan,
  }, { servicePortIndex: 12, frame: 0, slot: 5, port: 0, ontId: 3, gemIndex: 6, vlan: 527 });
  assert.match(result[0].rawMatchedLine, /784f-2462-fd2f/);
});

test('OLT parsers report no-match, malformed output and multiple matches safely', () => {
  const huawei = new HuaweiOLTDriver({});
  assert.deepEqual(huawei.parseMacAddressTable('No matching record'), []);
  assert.deepEqual(huawei.parseMacAddressTable('12 ??? malformed'), []);
  assert.equal(huawei.parseMacAddressTable(`
 12 - gpon 784f-2462-fd2f dynamic 0/5/0 3 6 527
 13 - gpon 784f-2462-fd2f dynamic 0/5/1 4 7 528
 `, '784f-2462-fd2f').length, 2);
});

test('BDCOM parser handles PON interface, ONU and dotted MAC', () => {
  const driver = new BdcomOLTDriver({});
  const result = driver.parseMacAddressTable('527 784f.2462.fd2f DYNAMIC EPON0/5:3', '784f.2462.fd2f');
  assert.equal(result.length, 1);
  assert.deepEqual({
    frame: result[0].frame, slot: result[0].slot, port: result[0].port,
    ontId: result[0].ontId, vlan: result[0].vlan,
  }, { frame: 0, slot: 0, port: 5, ontId: 3, vlan: 527 });
});

test('TR-098 PPP adapter preserves false, zero and nested WAN fields', () => {
  const device = { InternetGatewayDevice: { WANDevice: { 1: { WANConnectionDevice: { 1: {
    WANPPPConnection: { 1: {
      Enable: v(false), ConnectionStatus: v('Connected'), Name: v('1_INTERNET_R_VID_528'),
      Username: v('subscriber'), MACAddress: v('78:4f:24:62:fd:2e'),
      DNSServers: v('8.8.8.8,1.1.1.1'), CurrentMRUSize: v(1492), MaxMRUSize: v(1500),
      PPPAuthenticationProtocol: v('AUTO_AUTH'), PPPoEACName: v('Kisan-BNG'), PPPoESessionID: v(1),
      PPPLCPEcho: v(150), PPPLCPEchoRetry: v(3), NATEnabled: v(false), ShapingBurstSize: v(0),
      Stats: { BytesReceived: v(0), PacketsReceived: v(165431), X_ALU_PacketsReceivedBroadcast: v(7) },
      'X_ALU-COM_WanAccessCfg': { HttpDisabled: v(false), SshDisabled: v(true), HttpTrusted: v(false) },
      Password: v('must-not-leak'),
    } },
  } } } } } };
  const [wan] = normalizeWanConnections(device);
  assert.equal(wan.enabled, false);
  assert.equal(wan.natEnabled, false);
  assert.equal(wan.shapingBurstSize, 0);
  assert.equal(wan.currentMRU, 1492);
  assert.equal(wan.maximumMRU, 1500);
  assert.equal(wan.authenticationProtocol, 'AUTO_AUTH');
  assert.equal(wan.pppoeAcName, 'Kisan-BNG');
  assert.equal(wan.pppoeSessionId, 1);
  assert.deepEqual(wan.dnsServers, ['8.8.8.8', '1.1.1.1']);
  assert.equal(wan.vlan, 528);
  assert.equal(wan.stats.bytesReceived, 0);
  assert.equal(wan.stats.packetsReceived, 165431);
  assert.equal(wan.accessControl.http.enabled, true);
  assert.equal(wan.accessControl.ssh.enabled, false);
  assert.equal(Object.values(wan.parameters).includes('must-not-leak'), false);
});

test('TR-098 IP and TR-181 interfaces normalize without model-specific hardcoding', () => {
  const device = {
    InternetGatewayDevice: { WANDevice: { 1: { WANConnectionDevice: { 2: { WANIPConnection: { 1: {
      Enable: v(true), AddressingType: v('DHCP'), ExternalIPAddress: v('10.0.0.2'),
      SubnetMask: v('255.255.255.0'), DefaultGateway: v('10.0.0.1'), DNSServers: v('9.9.9.9'),
    } } } } } } },
    Device: { PPP: { Interface: { 3: { Enable: v(true), Status: v('Up'), Username: v('tr181-user'), MTU: v(1492) } } } },
  };
  const result = normalizeWanConnections(device);
  assert.equal(result.length, 2);
  assert.equal(result.find(item => item.modelRoot === 'TR-098').externalIPAddress, '10.0.0.2');
  assert.equal(result.find(item => item.modelRoot === 'TR-181').username, 'tr181-user');
});

test('GenieACS refresh tasks honor a short caller-specific request timeout', async () => {
  const client = Object.create(GenieACSClient.prototype);
  let getConfig;
  let postRequest;
  client.client = {
    get: async (_url, config) => {
      getConfig = config;
      return { data: [{ _id: 'cpe-timeout', _deviceId: { _SerialNumber: 'SERIAL-TIMEOUT' } }] };
    },
    post: async (url, task, config) => {
      postRequest = { url, task, config };
      return { status: 202, data: { _id: 'task-timeout' } };
    }
  };

  const result = await client.refreshObject('SERIAL-TIMEOUT', 'Device.Hosts', {
    requestTimeoutMs: 8000,
    connectionRequestTimeoutMs: 3000
  });

  assert.equal(getConfig.timeout, 8000);
  assert.equal(postRequest.config.timeout, 8000);
  assert.match(postRequest.url, /timeout=3000&connection_request=true$/);
  assert.deepEqual(postRequest.task, { name: 'refreshObject', objectName: 'Device.Hosts' });
  assert.equal(result.taskId, 'task-timeout');
});

test('TR-069 diagnostics queue real TR-181 parameters with DiagnosticsState last', async () => {
  const client = Object.create(GenieACSClient.prototype);
  client.getDeviceBySerial = async () => ({ _id: 'cpe-1', Device: { IP: { Diagnostics: {} } } });
  let queued;
  client.createTask = async (_serial, task) => {
    queued = task;
    return { status: 'queued', taskId: 'task-1' };
  };
  const result = await client.runDiagnostic('SERIAL-1', { type: 'ping', target: '1.1.1.1', repetitions: 3 });
  assert.equal(result.dataModel, 'TR-181');
  assert.deepEqual(queued.parameterValues, [
    ['Device.IP.Diagnostics.IPPing.Host', '1.1.1.1', 'xsd:string'],
    ['Device.IP.Diagnostics.IPPing.NumberOfRepetitions', '3', 'xsd:unsignedInt'],
    ['Device.IP.Diagnostics.IPPing.Timeout', '5000', 'xsd:unsignedInt'],
    ['Device.IP.Diagnostics.IPPing.DiagnosticsState', 'Requested', 'xsd:string']
  ]);
});

test('WAN quick diagnostic binds ping to the selected profile interface', async () => {
  const client = Object.create(GenieACSClient.prototype);
  client.getDeviceBySerial = async () => ({ _id: 'cpe-wan', InternetGatewayDevice: { IPPingDiagnostics: {} } });
  let queued;
  client.createTask = async (_serial, task) => {
    queued = task;
    return { status: 'queued', taskId: 'task-wan' };
  };
  const interfacePath = 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANIPConnection.1';
  await client.runDiagnostic('SERIAL-WAN', {
    type: 'ping',
    target: '10.64.0.1',
    repetitions: 4,
    timeout: 5000,
    interfacePath
  });
  assert.deepEqual(queued.parameterValues, [
    ['InternetGatewayDevice.IPPingDiagnostics.Host', '10.64.0.1', 'xsd:string'],
    ['InternetGatewayDevice.IPPingDiagnostics.Interface', interfacePath, 'xsd:string'],
    ['InternetGatewayDevice.IPPingDiagnostics.NumberOfRepetitions', '4', 'xsd:unsignedInt'],
    ['InternetGatewayDevice.IPPingDiagnostics.Timeout', '5000', 'xsd:unsignedInt'],
    ['InternetGatewayDevice.IPPingDiagnostics.DiagnosticsState', 'Requested', 'xsd:string']
  ]);
});

test('TR-069 diagnostics fall back to TR-098 without fabricating output', async () => {
  const client = Object.create(GenieACSClient.prototype);
  client.getDeviceBySerial = async () => ({ _id: 'cpe-2', InternetGatewayDevice: { TraceRouteDiagnostics: {} } });
  client.createTask = async (_serial, task) => ({ status: 'queued', taskId: 'task-2', submitted: task });
  const result = await client.runDiagnostic('SERIAL-2', { type: 'traceroute', target: 'example.com', repetitions: 4 });
  assert.equal(result.dataModel, 'TR-098');
  assert.equal(result.resultPath, 'InternetGatewayDevice.TraceRouteDiagnostics');
  assert.equal(result.status, 'queued');
  assert.equal('hops' in result, false);
});

test('TR-069 diagnostic results distinguish task completion from CPE failure', async () => {
  const client = Object.create(GenieACSClient.prototype);
  client.getDeviceBySerial = async () => ({
    InternetGatewayDevice: {
      NSLookupDiagnostics: {
        DiagnosticsState: v('Error_Other'),
        HostName: v('google.com'),
        SuccessCount: v(0),
        ResultNumberOfEntries: v(0)
      }
    }
  });
  const result = await client.getDiagnosticResult('SERIAL-3', {
    type: 'dns',
    dataModel: 'TR-098',
    refresh: false
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.diagnosticsState, 'Error_Other');
  assert.equal(result.target, 'google.com');
  assert.equal(result.summary.successCount, 0);
  assert.deepEqual(result.results, []);
});

test('TR-069 diagnostic result reports an unconsumed GenieACS task as queued', async () => {
  const client = Object.create(GenieACSClient.prototype);
  let refreshCalls = 0;
  client.refreshObject = async () => {
    refreshCalls += 1;
  };
  client.getTask = async () => ({
    _id: '6a6929c636a32939a9d01ac4',
    timestamp: '2026-07-28T22:14:30.947Z'
  });
  client.getDeviceBySerial = async () => ({
    InternetGatewayDevice: {
      TraceRouteDiagnostics: {
        DiagnosticsState: v('None'),
        Host: v(''),
        RouteHopsNumberOfEntries: v(0)
      }
    }
  });
  const result = await client.getDiagnosticResult('SERIAL-QUEUED', {
    type: 'traceroute',
    dataModel: 'TR-098',
    refresh: false,
    taskId: '6a6929c636a32939a9d01ac4'
  });
  assert.equal(result.status, 'queued');
  assert.equal(result.taskStatus, 'queued');
  assert.equal(result.queuedAt, '2026-07-28T22:14:30.947Z');
  assert.match(result.message, /has not consumed/i);
  assert.equal(refreshCalls, 0);
});

test('TR-069 diagnostic result throttles refresh tasks after the diagnostic is consumed', async () => {
  const client = Object.create(GenieACSClient.prototype);
  client.diagnosticRefreshAt = new Map();
  let refreshCalls = 0;
  client.getTask = async () => null;
  client.refreshObject = async () => {
    refreshCalls += 1;
    return { status: 'queued', taskId: `refresh-${refreshCalls}` };
  };
  client.getDeviceBySerial = async () => ({
    InternetGatewayDevice: {
      TraceRouteDiagnostics: {
        DiagnosticsState: v('Requested'),
        Host: v('google.com'),
        RouteHopsNumberOfEntries: v(0)
      }
    }
  });

  const options = {
    type: 'traceroute',
    dataModel: 'TR-098',
    refresh: true,
    taskId: '6a6929c636a32939a9d01ac4'
  };
  const first = await client.getDiagnosticResult('SERIAL-REFRESH', options);
  const second = await client.getDiagnosticResult('SERIAL-REFRESH', options);

  assert.equal(first.status, 'pending');
  assert.equal(first.refreshTask.taskId, 'refresh-1');
  assert.equal(second.refreshTask, null);
  assert.equal(refreshCalls, 1);
});

test('TR-069 ping result prefers detailed microsecond latency and returns milliseconds', async () => {
  const client = Object.create(GenieACSClient.prototype);
  client.getDeviceBySerial = async () => ({
    InternetGatewayDevice: {
      IPPingDiagnostics: {
        DiagnosticsState: v('Complete'),
        Host: v('8.8.8.8'),
        SuccessCount: v(4),
        FailureCount: v(0),
        MinimumResponseTime: v(22),
        AverageResponseTime: v(22),
        MaximumResponseTime: v(22),
        MinimumResponseTimeDetailed: v(22073),
        AverageResponseTimeDetailed: v(22247),
        MaximumResponseTimeDetailed: v(22442)
      }
    }
  });
  const result = await client.getDiagnosticResult('SERIAL-PING', {
    type: 'ping',
    dataModel: 'TR-098',
    refresh: false
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.target, '8.8.8.8');
  assert.deepEqual(
    [
      result.summary.minimumResponseTime,
      result.summary.averageResponseTime,
      result.summary.maximumResponseTime
    ],
    [22.073, 22.247, 22.442]
  );
});

test('TR-069 WiFi client merge treats zero and positive signal values as unknown', () => {
  assert.equal(normalizeReportedSignal(0), null);
  assert.equal(normalizeReportedSignal(5), null);
  assert.equal(normalizeReportedSignal(-61), -61);

  const clients = mergeConnectedDeviceRecords([
    {
      macAddress: 'DE:B0:A0:D8:C6:CB',
      hostName: 'Galaxy-A36-5G',
      ipAddress: '192.168.1.83',
      active: false,
      type: 'LAN'
    },
    {
      macAddress: 'de:b0:a0:d8:c6:cb',
      hostName: 'Unknown',
      ipAddress: 'fe80::old',
      active: true,
      type: 'WiFi',
      ssid: 'HOME_4G',
      band: '2.4 GHz',
      authenticated: false,
      signalStrength: 0
    },
    {
      macAddress: 'de:b0:a0:d8:c6:cb',
      hostName: 'Unknown',
      ipAddress: 'fe80::current',
      active: true,
      type: 'WiFi',
      ssid: '12345678',
      band: '5 GHz',
      authenticated: true,
      signalStrength: -61
    }
  ]);

  assert.equal(clients.length, 1);
  assert.equal(clients[0].hostName, 'Galaxy-A36-5G');
  assert.equal(clients[0].ipAddress, '192.168.1.83');
  assert.equal(clients[0].ssid, '12345678');
  assert.equal(clients[0].band, '5 GHz');
  assert.equal(clients[0].signalStrength, -61);
});

test('TR-181 WiFi topology exposes associated-client RSSI, rates, band and channel', async () => {
  const controller = Object.create(ServiceController.prototype);
  const clients = await controller.getConnectedDevices({
    Device: {
      WiFi: {
        Radio: {
          2: {
            OperatingFrequencyBand: v('5GHz'),
            Channel: v(44)
          }
        },
        SSID: {
          2: {
            SSID: v('Bhawani'),
            LowerLayers: v('Device.WiFi.Radio.2')
          }
        },
        AccessPoint: {
          2: {
            SSIDReference: v('Device.WiFi.SSID.2'),
            AssociatedDevice: {
              1: {
                MACAddress: v('f6:74:79:b1:e0:0b'),
                SignalStrength: v(-63),
                AuthenticationState: v(true),
                LastDataUplinkRate: v(433000),
                LastDataDownlinkRate: v(866000),
                Retransmissions: v(3)
              }
            }
          }
        }
      }
    }
  }, 'SERIAL-WIFI-MAP', null);

  assert.equal(clients.length, 1);
  assert.equal(clients[0].ssid, 'Bhawani');
  assert.equal(clients[0].band, '5 GHz');
  assert.equal(clients[0].channel, 44);
  assert.equal(clients[0].signalStrength, -63);
  assert.equal(clients[0].authenticated, true);
  assert.equal(clients[0].lastDataDownlinkRate, 866000);
});

test('TR-069 WiFi snapshots preserve a real database password when ACS masks it', () => {
  const stored = [{
    source: 'TR-098',
    instance: 'LANDevice.1.WLANConfiguration.1',
    ssid: 'HOME',
    keyPassphrase: 'LocalSecret123'
  }];
  const fresh = [{
    source: 'TR-098',
    instance: 'LANDevice.1.WLANConfiguration.1',
    ssid: 'HOME',
    keyPassphrase: '[MASKED]',
    parameters: { KeyPassphrase: '********' }
  }];
  const [merged] = mergeWifiSnapshotPasswords(fresh, stored);
  assert.equal(extractWifiPassword(fresh[0]), '');
  assert.equal(merged.keyPassphrase, 'LocalSecret123');
  assert.equal(merged.passwordSource, 'database');
});

test('TR-181 WiFi AccessPoint security is joined to its SSID profile', async () => {
  const controller = Object.create(ServiceController.prototype);
  const device = {
    Device: {
      WiFi: {
        SSID: {
          1: { SSID: v('Office-5G'), Enable: v(true), BSSID: v('aa:bb:cc:dd:ee:ff') }
        },
        AccessPoint: {
          1: {
            Enable: v(true),
            SSIDReference: v('Device.WiFi.SSID.1'),
            Security: { ModeEnabled: v('WPA2-Personal'), KeyPassphrase: v('TR181Secret') }
          }
        }
      }
    }
  };
  const ssids = await controller.getSSIDDetails(device, 'SERIAL-WIFI', null);
  assert.equal(ssids.length, 1);
  assert.equal(ssids[0].ssid, 'Office-5G');
  assert.equal(ssids[0].keyPassphrase, 'TR181Secret');
});

test('TR-069 parameter metadata preserves native type, access, and timestamp', () => {
  const parameters = collectTR069ParameterMetadata({
    InternetGatewayDevice: {
      DeviceInfo: {
        SoftwareVersion: {
          _value: '3FE49362JJIJ50',
          _type: 'xsd:string',
          _writable: false,
          _timestamp: '2026-07-29T01:00:00.000Z'
        },
        ProvisioningCode: {
          _value: 'ALCL',
          _type: 'xsd:string',
          _writable: true
        }
      }
    }
  });

  assert.deepEqual(parameters, [
    {
      path: 'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
      value: '3FE49362JJIJ50',
      type: 'string',
      writable: false,
      updatedAt: '2026-07-29T01:00:00.000Z'
    },
    {
      path: 'InternetGatewayDevice.DeviceInfo.ProvisioningCode',
      value: 'ALCL',
      type: 'string',
      writable: true,
      updatedAt: null
    }
  ]);
});

test('GenieACS full parameter snapshot refreshes every supported model root', async () => {
  const client = Object.create(GenieACSClient.prototype);
  let reads = 0;
  client.getDeviceBySerial = async () => {
    reads += 1;
    return {
      InternetGatewayDevice: { DeviceInfo: {} },
      Device: { DeviceInfo: {} },
      VirtualParameters: { uptime: {} }
    };
  };
  const refreshed = [];
  client.refreshObject = async (_serial, objectName) => {
    refreshed.push(objectName);
    return { status: 'completed', taskId: `task-${objectName}` };
  };
  const snapshot = await client.getDeviceParameterSnapshot('SERIAL-SNAPSHOT', { refresh: true });
  assert.deepEqual(refreshed, ['InternetGatewayDevice', 'Device', 'VirtualParameters']);
  assert.equal(snapshot.refreshTasks.length, 3);
  assert.equal(reads, 2);
});

test('API tokens use one-way hashes, supported scopes, and strict IP restrictions', () => {
  const raw = generateRawToken();
  assert.match(raw, /^ks_live_[a-f0-9]{64}$/);
  assert.equal(hashToken(raw).length, 64);
  assert.notEqual(hashToken(raw), raw);
  assert.deepEqual(validateScopes(['customers:read', 'customers:read', 'devices:read']).scopes, ['customers:read', 'devices:read']);
  assert.match(validateScopes(['unknown:write']).error, /Unsupported API scopes/);
  assert.equal(validateIpRestrictions('127.0.0.1, 203.0.113.10').normalized, '127.0.0.1,203.0.113.10');
  assert.match(validateIpRestrictions('not-an-ip').error, /Invalid allowed IP/);
});

test('external API catalog exposes discoverable versioned customer and device routes', () => {
  const paths = EXTERNAL_API_ROUTES.map(route => `${route.method} ${route.path}`);
  assert.ok(paths.includes('GET /api/v1/routes'));
  assert.ok(paths.includes('GET /api/v1/customers'));
  assert.ok(paths.includes('GET /api/v1/customers/:id'));
  assert.ok(paths.includes('GET /api/v1/devices'));
  assert.ok(paths.includes('GET /api/v1/devices/:id'));
});
