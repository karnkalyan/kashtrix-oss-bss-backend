const test = require('node:test');
const assert = require('node:assert/strict');
const {
  printedPonSerialToHex,
  hexPonSerialToPrinted,
  ponSerialCandidates,
  samePonSerial
} = require('../src/utils/ponSerial');

test('converts an ALCL printed GPON serial to the Huawei hexadecimal vendor form', () => {
  assert.equal(printedPonSerialToHex('ALCLB2C8653B'), '414C434CB2C8653B');
});

test('converts a hexadecimal vendor prefix back to the printed serial', () => {
  assert.equal(hexPonSerialToPrinted('414c434cb2c8653b'), 'ALCLB2C8653B');
});

test('matches printed and hexadecimal representations of the same ONT', () => {
  assert.deepEqual(ponSerialCandidates('ALCLB2C8653B'), ['ALCLB2C8653B', '414C434CB2C8653B']);
  assert.equal(samePonSerial('ALCLB2C8653B', '414C434CB2C8653B'), true);
});
