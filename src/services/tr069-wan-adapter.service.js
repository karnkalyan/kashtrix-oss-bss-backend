const SECRET_PATH = /(?:password|passphrase|secret|privatekey|psk|pre.?shared.?key)$/i;

function unwrap(value) {
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, '_value')) {
    return value._value;
  }
  return value;
}

function flattenParameters(value, prefix = '', output = {}) {
  if (!value || typeof value !== 'object') return output;
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith('_')) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const leaf = unwrap(child);
    if (child && typeof child === 'object' && !Object.prototype.hasOwnProperty.call(child, '_value')) {
      flattenParameters(child, path, output);
    } else {
      output[path] = SECRET_PATH.test(path) ? '[MASKED]' : leaf;
    }
  }
  return output;
}

function present(value) {
  return value !== undefined && value !== null && value !== '' && value !== 'N/A';
}

function first(...values) {
  return values.find(present);
}

function leaf(parameters, ...aliases) {
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(parameters, alias) && present(parameters[alias])) return parameters[alias];
    const key = Object.keys(parameters).find(path => path.endsWith(`.${alias}`));
    if (key && present(parameters[key])) return parameters[key];
  }
  return undefined;
}

function bool(value) {
  if (!present(value)) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (/^(true|1|yes|on|enabled)$/i.test(String(value).trim())) return true;
  if (/^(false|0|no|off|disabled)$/i.test(String(value).trim())) return false;
  return undefined;
}

function number(value) {
  if (!present(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function dns(value) {
  value = unwrap(value);
  if (!present(value)) return [];
  if (Array.isArray(value)) return value.flatMap(dns);
  if (value && typeof value === 'object') return Object.values(value).flatMap(dns);
  return String(value).split(/[\s,;]+/).map(item => item.trim()).filter(Boolean);
}

function vlan(parameters) {
  const explicit = number(leaf(parameters,
    'VLANIDMark', 'VLANID', 'VlanId', 'X_ALU-COM_VLANIDMark',
    'X_CT-COM_VLANIDMark', 'X_BROADCOM_COM_VLANIDMark'));
  if (explicit !== undefined) return explicit;
  const name = String(leaf(parameters, 'Name', 'Alias') || '');
  const match = name.match(/(?:^|_)VID_(\d+)(?:_|$)/i);
  return match ? Number(match[1]) : undefined;
}

function stats(parameters) {
  const aliases = {
    bytesReceived: ['Stats.EthernetBytesReceived', 'Stats.BytesReceived', 'BytesReceived'],
    bytesSent: ['Stats.EthernetBytesSent', 'Stats.BytesSent', 'BytesSent'],
    packetsReceived: ['Stats.EthernetPacketsReceived', 'Stats.PacketsReceived', 'PacketsReceived'],
    packetsSent: ['Stats.EthernetPacketsSent', 'Stats.PacketsSent', 'PacketsSent'],
    errorsReceived: ['Stats.EthernetErrorsReceived', 'Stats.ErrorsReceived', 'ErrorsReceived', 'Stats.X_ALU_PacketsErrored'],
    errorsSent: ['Stats.EthernetErrorsSent', 'Stats.ErrorsSent', 'ErrorsSent'],
    discardsReceived: ['Stats.EthernetDiscardPacketsReceived', 'Stats.DiscardPacketsReceived', 'DiscardPacketsReceived'],
    discardsSent: ['Stats.EthernetDiscardPacketsSent', 'Stats.DiscardPacketsSent', 'DiscardPacketsSent'],
    unicastReceived: ['Stats.EthernetUnicastPacketsReceived', 'Stats.X_ALU_PacketsReceivedUnicast'],
    unicastSent: ['Stats.EthernetUnicastPacketsSent', 'Stats.X_ALU_PacketsSentUnicast'],
    broadcastReceived: ['Stats.EthernetBroadcastPacketsReceived', 'Stats.X_ALU_PacketsReceivedBroadcast'],
    broadcastSent: ['Stats.EthernetBroadcastPacketsSent', 'Stats.X_ALU_PacketsSentBroadcast'],
    multicastReceived: ['Stats.EthernetMulticastPacketsReceived', 'Stats.X_ALU_PacketsReceivedMulticast'],
    multicastSent: ['Stats.EthernetMulticastPacketsSent', 'Stats.X_ALU_PacketsSentMulticast'],
    crcErrors: ['Stats.CRCErrors', 'Stats.X_ALU-COM_CRCError'],
    fragments: ['Stats.Fragments', 'Stats.X_ALU-COM_UpStreamFragments'],
    jabbers: ['Stats.Jabbers', 'Stats.X_ALU-COM_UpStreamJabbers'],
    oversizePackets: ['Stats.OversizePackets', 'Stats.X_ALU-COM_OverSizePacketsReceived'],
    undersizePackets: ['Stats.UndersizePackets', 'Stats.X_ALU-COM_UnderSizePacketsReceived'],
  };
  return Object.fromEntries(Object.entries(aliases).flatMap(([key, names]) => {
    const value = number(leaf(parameters, ...names));
    return value === undefined ? [] : [[key, value]];
  }));
}

function accessControl(parameters) {
  const services = ['Http', 'Https', 'Ssh', 'Telnet', 'Ftp', 'Sftp', 'Tr69', 'IcmpEchoReq'];
  return Object.fromEntries(services.map(service => {
    const disabled = bool(leaf(parameters, `X_ALU-COM_WanAccessCfg.${service}Disabled`, `${service}Disabled`));
    const trusted = bool(leaf(parameters, `X_ALU-COM_WanAccessCfg.${service}Trusted`, `${service}Trusted`));
    return [service.replace('IcmpEchoReq', 'icmpEcho').toLowerCase(), {
      enabled: disabled === undefined ? undefined : !disabled,
      trusted,
    }];
  }));
}

function normalizeConnection({ parameters, type, root, indices }) {
  const ppp = type === 'PPP';
  const name = leaf(parameters, 'Name', 'Alias');
  return {
    ...indices,
    type,
    root,
    modelRoot: root.startsWith('Device.') ? 'TR-181' : 'TR-098',
    name,
    enabled: bool(leaf(parameters, 'Enable')),
    connectionStatus: first(leaf(parameters, 'ConnectionStatus'), leaf(parameters, 'Status')),
    connectionType: leaf(parameters, 'ConnectionType'),
    addressingType: ppp ? 'PPPoE' : first(leaf(parameters, 'AddressingType'), leaf(parameters, 'IPInterfaceAddressingType')),
    serviceType: first(leaf(parameters, 'X_ALU-COM_ServiceList', 'X_CT-COM_ServiceList', 'ServiceList'),
      String(name || '').match(/(?:INTERNET|TR069|IPTV|VOICE)/i)?.[0]),
    transportType: leaf(parameters, 'TransportType', 'LowerLayers'),
    lowerLayers: leaf(parameters, 'LowerLayers'),
    username: ppp ? leaf(parameters, 'Username') : undefined,
    externalIPAddress: first(leaf(parameters, 'ExternalIPAddress'), leaf(parameters, 'IPAddress')),
    subnetMask: leaf(parameters, 'SubnetMask'),
    gateway: first(leaf(parameters, 'DefaultGateway'), leaf(parameters, 'Gateway')),
    remoteIPAddress: leaf(parameters, 'RemoteIPAddress'),
    macAddress: leaf(parameters, 'MACAddress', 'PhysAddress', 'CurrentMACAddress', 'ClonedMACAddress', 'X_ALU-COM_MACAddress'),
    macAddressSource: leaf(parameters, 'MACAddress', 'PhysAddress', 'CurrentMACAddress', 'ClonedMACAddress', 'X_ALU-COM_MACAddress') ? 'profile' : undefined,
    dnsServers: dns(leaf(parameters, 'DNSServers', 'DNSServer')),
    mtu: number(first(leaf(parameters, 'InterfaceMtu'), leaf(parameters, 'MaxMTUSize'), leaf(parameters, 'MTU'))),
    currentMRU: number(leaf(parameters, 'CurrentMRUSize')),
    maximumMRU: number(leaf(parameters, 'MaxMRUSize')),
    authenticationProtocol: leaf(parameters, 'PPPAuthenticationProtocol', 'AuthenticationProtocol'),
    compressionProtocol: leaf(parameters, 'PPPCompressionProtocol'),
    encryptionProtocol: leaf(parameters, 'PPPEncryptionProtocol'),
    pppoeAcName: leaf(parameters, 'PPPoEACName'),
    pppoeServiceName: leaf(parameters, 'PPPoEServiceName'),
    pppoeSessionId: number(leaf(parameters, 'PPPoESessionID')),
    lcpEchoInterval: number(leaf(parameters, 'PPPLCPEcho')),
    lcpEchoRetryCount: number(leaf(parameters, 'PPPLCPEchoRetry')),
    uptime: number(leaf(parameters, 'Uptime')),
    lastConnectionError: leaf(parameters, 'LastConnectionError'),
    natEnabled: bool(leaf(parameters, 'NATEnabled')),
    dnsEnabled: bool(leaf(parameters, 'DNSEnabled')),
    dnsOverrideAllowed: bool(leaf(parameters, 'DNSOverrideAllowed')),
    macOverride: bool(leaf(parameters, 'MACAddressOverride')),
    shapingRate: number(leaf(parameters, 'ShapingRate')),
    shapingBurstSize: number(leaf(parameters, 'ShapingBurstSize')),
    vlan: vlan(parameters),
    vlanPriority: number(leaf(parameters, 'X_CT-COM_802-1pMark', 'EthernetPriority', 'VLANPriority')),
    multicastVlan: number(leaf(parameters, 'X_ALU-COM_MulticastVlan', 'MulticastVlan')),
    connectionTrigger: leaf(parameters, 'ConnectionTrigger'),
    routeProtocolRx: leaf(parameters, 'RouteProtocolRx'),
    dhcpServerIPAddress: leaf(parameters, 'DHCPServerIPAddress'),
    dhcpLeaseTime: number(leaf(parameters, 'DHCPLeaseTime')),
    ipv6Address: leaf(parameters, 'X_ALU-COM_IPv6IPAddress', 'X_CT-COM_IPv6IPAddress', 'IPv6Address'),
    ipv6Gateway: leaf(parameters, 'X_ALU-COM_DefaultIPv6Gateway', 'X_CT-COM_DefaultIPv6Gateway', 'IPv6Gateway'),
    ipv6Prefix: leaf(parameters, 'X_ALU-COM_IPv6Prefix', 'X_CT-COM_IPv6Prefix', 'IPv6Prefix'),
    ipv6Status: leaf(parameters, 'X_ALU-COM_IPv6ConnStatus', 'IPv6Status'),
    prefixDelegationEnabled: bool(leaf(parameters, 'X_ALU-COM_IPv6PrefixDelegationEnabled', 'PrefixDelegationEnabled')),
    accessControl: accessControl(parameters),
    stats: stats(parameters),
    parameters,
  };
}

function normalizeWanConnections(device) {
  const flattened = flattenParameters(device);
  const groups = new Map();
  for (const [path, value] of Object.entries(flattened)) {
    const tr098 = path.match(/^(InternetGatewayDevice\.WANDevice\.(\d+)\.WANConnectionDevice\.(\d+)\.(WANPPPConnection|WANIPConnection)\.(\d+))\.(.+)$/);
    const tr181 = path.match(/^(Device\.(PPP|IP)\.Interface\.(\d+))\.(.+)$/);
    if (tr098) {
      const [, root, wanDeviceIndex, wanConnectionDeviceIndex, kind, connectionIndex, suffix] = tr098;
      if (!groups.has(root)) groups.set(root, { type: kind === 'WANPPPConnection' ? 'PPP' : 'IP', root,
        indices: { wanDeviceIndex, wanConnectionDeviceIndex, connectionIndex }, parameters: {} });
      groups.get(root).parameters[`${root}.${suffix}`] = value;
    } else if (tr181) {
      const [, root, kind, connectionIndex, suffix] = tr181;
      if (!groups.has(root)) groups.set(root, { type: kind, root,
        indices: { connectionIndex }, parameters: {} });
      groups.get(root).parameters[`${root}.${suffix}`] = value;
    }
  }
  return [...groups.values()].map(group => {
    const connection = normalizeConnection(group);
    if (present(connection.macAddress)) return connection;

    const prefixes = connection.modelRoot === 'TR-098'
      ? [
          `InternetGatewayDevice.WANDevice.${connection.wanDeviceIndex}.WANConnectionDevice.${connection.wanConnectionDeviceIndex}.`,
          `InternetGatewayDevice.WANDevice.${connection.wanDeviceIndex}.`
        ]
      : [
          `Device.${connection.type}.Interface.${connection.connectionIndex}.`,
          'Device.Ethernet.Interface.'
        ];
    const fallbackEntry = Object.entries(flattened).find(([path, value]) =>
      prefixes.some(prefix => path.startsWith(prefix)) &&
      /(?:MACAddress|PhysAddress)$/.test(path) &&
      present(value)
    );
    return fallbackEntry
      ? { ...connection, macAddress: fallbackEntry[1], macAddressSource: fallbackEntry[0] }
      : connection;
  });
}

module.exports = {
  accessControl, bool, dns, flattenParameters, leaf, normalizeWanConnections, number, vlan,
};
