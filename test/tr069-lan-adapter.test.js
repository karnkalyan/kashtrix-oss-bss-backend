const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeLanConfiguration,
  validateLanConfiguration,
  buildLanParameterValues
} = require('../src/services/tr069-lan-adapter.service');

const leaf = value => ({ _value: value });

test('TR-069 LAN adapter normalizes TR-098 LAN and DHCP parameters', () => {
  const device = {
    InternetGatewayDevice: {
      LANDevice: {
        1: {
          LANHostConfigManagement: {
            DHCPServerEnable: leaf(true),
            MinAddress: leaf('192.168.1.10'),
            MaxAddress: leaf('192.168.1.200'),
            DHCPLeaseTime: leaf(86400),
            IPRouters: leaf('192.168.1.1'),
            DNSServers: leaf('1.1.1.1,8.8.8.8'),
            DomainName: leaf('lan'),
            IPInterface: {
              1: {
                IPInterfaceIPAddress: leaf('192.168.1.1'),
                IPInterfaceSubnetMask: leaf('255.255.255.0')
              }
            }
          }
        }
      }
    }
  };
  const result = normalizeLanConfiguration(device);
  assert.equal(result.supported, true);
  assert.equal(result.dataModel, 'TR-098');
  assert.equal(result.parameters.lanIpAddress, '192.168.1.1');
  assert.equal(result.parameters.minAddress, '192.168.1.10');
  assert.equal(result.parameters.dhcpEnabled, true);
});

test('TR-069 LAN adapter normalizes TR-181 DHCP pool and matching LAN IPv4 address', () => {
  const device = {
    Device: {
      DHCPv4: {
        Server: {
          Pool: {
            1: {
              Enable: leaf(true),
              MinAddress: leaf('10.0.0.10'),
              MaxAddress: leaf('10.0.0.100'),
              SubnetMask: leaf('255.255.255.0'),
              IPRouters: leaf('10.0.0.1'),
              LeaseTime: leaf(3600)
            }
          }
        }
      },
      IP: {
        Interface: {
          3: {
            IPv4Address: {
              1: {
                IPAddress: leaf('10.0.0.1'),
                AddressingType: leaf('Static')
              }
            }
          }
        }
      }
    }
  };
  const result = normalizeLanConfiguration(device);
  assert.equal(result.dataModel, 'TR-181');
  assert.equal(result.parameters.lanIpAddress, '10.0.0.1');
  assert.equal(result.paths.lanIpAddress, 'Device.IP.Interface.3.IPv4Address.1.IPAddress');
});

test('TR-069 LAN adapter rejects a DHCP pool outside the LAN subnet', () => {
  const errors = validateLanConfiguration({
    lanIpAddress: '192.168.1.1',
    subnetMask: '255.255.255.0',
    minAddress: '192.168.2.10',
    maxAddress: '192.168.2.20',
    leaseTime: 3600
  });
  assert.ok(errors.includes('DHCP pool must be in the same subnet as the LAN IP'));
});

test('TR-069 LAN adapter builds typed GenieACS parameter values', () => {
  const values = buildLanParameterValues({
    paths: {
      lanIpAddress: 'root.ip',
      subnetMask: 'root.mask',
      dhcpEnabled: 'root.enable',
      minAddress: 'root.min',
      maxAddress: 'root.max',
      leaseTime: 'root.lease'
    }
  }, {
    lanIpAddress: '192.168.1.1',
    subnetMask: '255.255.255.0',
    dhcpEnabled: true,
    minAddress: '192.168.1.10',
    maxAddress: '192.168.1.200',
    leaseTime: 86400
  });
  assert.ok(values.some(value => JSON.stringify(value) === JSON.stringify(['root.enable', true, 'xsd:boolean'])));
  assert.ok(values.some(value => JSON.stringify(value) === JSON.stringify(['root.lease', 86400, 'xsd:int'])));
});

test('TR-069 LAN adapter can disable DHCP when a CPE does not report a pool', () => {
  const values = buildLanParameterValues({
    paths: {
      lanIpAddress: 'root.ip',
      subnetMask: 'root.mask',
      dhcpEnabled: 'root.enable',
      minAddress: 'root.min',
      maxAddress: 'root.max',
      leaseTime: 'root.lease'
    }
  }, {
    lanIpAddress: '192.168.1.1',
    subnetMask: '255.255.255.0',
    dhcpEnabled: false,
    minAddress: '',
    maxAddress: '',
    leaseTime: 0
  });
  assert.deepEqual(values, [
    ['root.ip', '192.168.1.1', 'xsd:string'],
    ['root.mask', '255.255.255.0', 'xsd:string'],
    ['root.enable', false, 'xsd:boolean']
  ]);
});
