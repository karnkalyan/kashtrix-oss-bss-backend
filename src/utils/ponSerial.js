function normalizePonSerial(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

function printedPonSerialToHex(value) {
  const serial = normalizePonSerial(value);
  if (/^[0-9A-F]{16}$/.test(serial)) return serial;
  if (!/^[A-Z0-9]{4}[0-9A-F]{8}$/.test(serial)) return null;
  const vendorHex = [...serial.slice(0, 4)]
    .map((character) => character.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  return `${vendorHex}${serial.slice(4)}`;
}

function hexPonSerialToPrinted(value) {
  const serial = normalizePonSerial(value);
  if (!/^[0-9A-F]{16}$/.test(serial)) return null;
  let vendor = '';
  for (let index = 0; index < 8; index += 2) {
    const code = Number.parseInt(serial.slice(index, index + 2), 16);
    if (code < 33 || code > 126) return null;
    vendor += String.fromCharCode(code);
  }
  if (!/^[A-Z0-9]{4}$/i.test(vendor)) return null;
  return `${vendor.toUpperCase()}${serial.slice(8)}`;
}

function ponSerialCandidates(value) {
  const normalized = normalizePonSerial(value);
  return [...new Set([
    normalized,
    printedPonSerialToHex(normalized),
    hexPonSerialToPrinted(normalized)
  ].filter(Boolean))];
}

function samePonSerial(left, right) {
  const rightCandidates = new Set(ponSerialCandidates(right));
  return ponSerialCandidates(left).some((candidate) => rightCandidates.has(candidate));
}

module.exports = {
  normalizePonSerial,
  printedPonSerialToHex,
  hexPonSerialToPrinted,
  ponSerialCandidates,
  samePonSerial
};
