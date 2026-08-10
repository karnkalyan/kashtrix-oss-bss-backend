const { flattenParameters } = require('./tr069-wan-adapter.service');

const present = value => value !== undefined && value !== null && value !== '' && value !== 'N/A';
const booleanValue = value => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (/^(?:true|1|yes|on|enabled)$/i.test(String(value || ''))) return true;
  if (/^(?:false|0|no|off|disabled)$/i.test(String(value || ''))) return false;
  return null;
};

function firstPath(parameters, candidates, fallback) {
  for (const candidate of candidates) {
    if (Object.prototype.hasOwnProperty.call(parameters, candidate)) return candidate;
  }
  return fallback;
}

function ipv4ToNumber(value) {
  const parts = String(value || '').trim().split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((result, part) => ((result << 8) | Number(part)) >>> 0, 0);
}

function isValidIpv4(value) {
  return ipv4ToNumber(value) !== null;
}

function isContiguousMask(value) {
  const mask = ipv4ToNumber(value);
  if (mask === null) return false;
  const inverted = (~mask) >>> 0;
  return (inverted & (inverted + 1)) === 0;
}

function normalizeLanConfiguration(device) {
  const parameters = flattenParameters(device);
  const keys = Object.keys(parameters);
  const tr098Root = keys.find(path => /^InternetGatewayDevice\.LANDevice\.\d+\.LANHostConfigManagement\./.test(path))
    ?.match(/^(InternetGatewayDevice\.LANDevice\.\d+\.LANHostConfigManagement)/)?.[1];
  const poolRoot = keys.find(path => /^Device\.DHCPv4\.Server\.Pool\.\d+\./.test(path))
    ?.match(/^(Device\.DHCPv4\.Server\.Pool\.\d+)/)?.[1];
  const dataModel = tr098Root ? 'TR-098' : poolRoot ? 'TR-181' : 'unknown';

  if (dataModel === 'unknown') {
    return {
      supported: false,
      dataModel,
      message: 'This CPE did not expose a supported LAN DHCP parameter tree.',
      parameters: {},
      paths: {}
    };
  }

  if (dataModel === 'TR-098') {
    const ipInterfaceRoot = keys.find(path => path.startsWith(`${tr098Root}.IPInterface.`))
      ?.match(new RegExp(`^(${tr098Root.replace(/\./g, '\\.')}\\.IPInterface\\.\\d+)`))?.[1]
      || `${tr098Root}.IPInterface.1`;
    const paths = {
      lanIpAddress: firstPath(parameters, [
        `${ipInterfaceRoot}.IPInterfaceIPAddress`,
        `${ipInterfaceRoot}.IPAddress`
      ], `${ipInterfaceRoot}.IPInterfaceIPAddress`),
      subnetMask: firstPath(parameters, [
        `${ipInterfaceRoot}.IPInterfaceSubnetMask`,
        `${ipInterfaceRoot}.SubnetMask`,
        `${tr098Root}.SubnetMask`
      ], `${ipInterfaceRoot}.IPInterfaceSubnetMask`),
      dhcpEnabled: `${tr098Root}.DHCPServerEnable`,
      minAddress: `${tr098Root}.MinAddress`,
      maxAddress: `${tr098Root}.MaxAddress`,
      leaseTime: firstPath(parameters, [`${tr098Root}.DHCPLeaseTime`, `${tr098Root}.LeaseTime`], `${tr098Root}.DHCPLeaseTime`),
      gateway: `${tr098Root}.IPRouters`,
      dnsServers: `${tr098Root}.DNSServers`,
      domainName: `${tr098Root}.DomainName`
    };
    return buildNormalized(parameters, paths, dataModel, tr098Root);
  }

  const routerValue = parameters[`${poolRoot}.IPRouters`];
  const routerIp = String(routerValue || '').split(/[,\s]+/)[0];
  const ipv4Roots = keys
    .filter(path => /^Device\.IP\.Interface\.\d+\.IPv4Address\.\d+\.IPAddress$/.test(path))
    .map(path => path.replace(/\.IPAddress$/, ''));
  const lanIpv4Root = ipv4Roots.find(root => parameters[`${root}.IPAddress`] === routerIp)
    || ipv4Roots.find(root => String(parameters[`${root}.AddressingType`] || '').toLowerCase() === 'static')
    || ipv4Roots[0]
    || 'Device.IP.Interface.1.IPv4Address.1';
  const paths = {
    lanIpAddress: `${lanIpv4Root}.IPAddress`,
    subnetMask: firstPath(parameters, [`${poolRoot}.SubnetMask`, `${lanIpv4Root}.SubnetMask`], `${poolRoot}.SubnetMask`),
    dhcpEnabled: firstPath(parameters, [`${poolRoot}.Enable`, 'Device.DHCPv4.Server.Enable'], `${poolRoot}.Enable`),
    minAddress: `${poolRoot}.MinAddress`,
    maxAddress: `${poolRoot}.MaxAddress`,
    leaseTime: `${poolRoot}.LeaseTime`,
    gateway: `${poolRoot}.IPRouters`,
    dnsServers: `${poolRoot}.DNSServers`,
    domainName: `${poolRoot}.DomainName`
  };
  return buildNormalized(parameters, paths, dataModel, poolRoot);
}

function buildNormalized(parameters, paths, dataModel, root) {
  const value = key => parameters[paths[key]];
  return {
    supported: true,
    dataModel,
    root,
    parameters: {
      lanIpAddress: present(value('lanIpAddress')) ? String(value('lanIpAddress')) : '',
      subnetMask: present(value('subnetMask')) ? String(value('subnetMask')) : '',
      dhcpEnabled: booleanValue(value('dhcpEnabled')),
      minAddress: present(value('minAddress')) ? String(value('minAddress')) : '',
      maxAddress: present(value('maxAddress')) ? String(value('maxAddress')) : '',
      leaseTime: present(value('leaseTime')) ? Number(value('leaseTime')) : 86400,
      gateway: present(value('gateway')) ? String(value('gateway')) : '',
      dnsServers: present(value('dnsServers')) ? String(value('dnsServers')) : '',
      domainName: present(value('domainName')) ? String(value('domainName')) : ''
    },
    paths
  };
}

function validateLanConfiguration(input) {
  const errors = [];
  const fields = ['lanIpAddress', 'subnetMask'];
  if (input.dhcpEnabled || input.minAddress || input.maxAddress) fields.push('minAddress', 'maxAddress');
  for (const field of fields) {
    if (!isValidIpv4(input[field])) errors.push(`${field} must be a valid IPv4 address`);
  }
  if (isValidIpv4(input.subnetMask) && !isContiguousMask(input.subnetMask)) {
    errors.push('subnetMask must be a contiguous IPv4 netmask');
  }
  const lan = ipv4ToNumber(input.lanIpAddress);
  const mask = ipv4ToNumber(input.subnetMask);
  const min = ipv4ToNumber(input.minAddress);
  const max = ipv4ToNumber(input.maxAddress);
  if (min !== null && max !== null && min > max) errors.push('minAddress must not be greater than maxAddress');
  if (lan !== null && mask !== null && min !== null && max !== null) {
    const network = (lan & mask) >>> 0;
    if (((min & mask) >>> 0) !== network || ((max & mask) >>> 0) !== network) {
      errors.push('DHCP pool must be in the same subnet as the LAN IP');
    }
    if (lan >= min && lan <= max) errors.push('LAN IP must not be inside the DHCP allocation pool');
  }
  const leaseTime = Number(input.leaseTime);
  if (input.dhcpEnabled && (!Number.isInteger(leaseTime) || leaseTime < 60 || leaseTime > 31536000)) {
    errors.push('leaseTime must be between 60 and 31536000 seconds');
  }
  if (input.gateway) {
    const routers = String(input.gateway).split(/[,\s]+/).filter(Boolean);
    if (routers.some(router => !isValidIpv4(router))) errors.push('gateway must contain valid IPv4 addresses');
  }
  if (input.dnsServers) {
    const dns = String(input.dnsServers).split(/[,\s]+/).filter(Boolean);
    if (dns.some(server => !isValidIpv4(server))) errors.push('dnsServers must contain valid IPv4 addresses');
  }
  return errors;
}

function buildLanParameterValues(configuration, input) {
  const errors = validateLanConfiguration(input);
  if (errors.length) {
    const error = new Error(errors.join('. '));
    error.statusCode = 400;
    throw error;
  }
  const { paths } = configuration;
  const values = [
    [paths.lanIpAddress, String(input.lanIpAddress), 'xsd:string'],
    [paths.subnetMask, String(input.subnetMask), 'xsd:string'],
    [paths.dhcpEnabled, Boolean(input.dhcpEnabled), 'xsd:boolean']
  ];
  if (input.minAddress && input.maxAddress) {
    values.push(
      [paths.minAddress, String(input.minAddress), 'xsd:string'],
      [paths.maxAddress, String(input.maxAddress), 'xsd:string']
    );
  }
  if (Number.isInteger(Number(input.leaseTime)) && Number(input.leaseTime) > 0) {
    values.push([paths.leaseTime, Number(input.leaseTime), 'xsd:int']);
  }
  if (paths.gateway && input.gateway !== undefined) values.push([paths.gateway, String(input.gateway || ''), 'xsd:string']);
  if (paths.dnsServers && input.dnsServers !== undefined) values.push([paths.dnsServers, String(input.dnsServers || ''), 'xsd:string']);
  if (paths.domainName && input.domainName !== undefined) values.push([paths.domainName, String(input.domainName || ''), 'xsd:string']);
  return values;
}

module.exports = {
  normalizeLanConfiguration,
  validateLanConfiguration,
  buildLanParameterValues,
  isValidIpv4
};
