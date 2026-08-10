class MacAddressError extends Error {
  constructor(message = 'MAC address must contain exactly 12 hexadecimal characters') {
    super(message);
    this.name = 'MacAddressError';
    this.code = 'INVALID_MAC_ADDRESS';
    this.status = 400;
  }
}

function normalizeMac(value, format = 'plain') {
  if (typeof value !== 'string') throw new MacAddressError();
  const compact = value.trim().replace(/[:.\s-]/g, '').toLowerCase();
  if (!/^[0-9a-f]{12}$/.test(compact)) throw new MacAddressError();

  const formats = {
    plain: compact,
    colon: compact.match(/.{2}/g).join(':'),
    hyphen: compact.match(/.{2}/g).join('-'),
    dotted: compact.match(/.{4}/g).join('.'),
    huawei: compact.match(/.{4}/g).join('-'),
  };
  if (!(format in formats)) throw new MacAddressError(`Unsupported MAC format: ${format}`);
  return formats[format];
}

module.exports = { MacAddressError, normalizeMac };
