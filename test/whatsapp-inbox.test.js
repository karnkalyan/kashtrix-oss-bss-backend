const test = require('node:test');
const assert = require('node:assert/strict');
const { WhatsAppService } = require('../src/services/whatsapp.service');

test('incoming WhatsApp c.us messages are normalized for the chat inbox', async () => {
    const service = new WhatsAppService();
    const result = await service.normalizeIncomingMessage({}, {
        fromMe: false,
        from: '9779851188274@c.us',
        body: 'Hello support',
        type: 'chat',
        timestamp: 1785774600,
        id: { _serialized: 'inbound-message-1' },
        getContact: async () => ({ pushname: 'Kalyan' })
    });
    assert.equal(result.phone, '9779851188274');
    assert.equal(result.body, 'Hello support');
    assert.equal(result.displayName, 'Kalyan');
    assert.equal(result.direction, 'INBOUND');
    assert.equal(result.messageId, 'inbound-message-1');
});

test('incoming WhatsApp LID addresses resolve to their real phone number', async () => {
    const service = new WhatsAppService();
    const client = {
        getContactLidAndPhone: async () => [{ lid: '44332211@lid', pn: '9779800000000@c.us' }]
    };
    const result = await service.normalizeIncomingMessage(client, {
        fromMe: false,
        from: '44332211@lid',
        body: 'LID message',
        type: 'chat',
        id: { id: 'inbound-message-2' },
        getContact: async () => ({ name: 'Customer' })
    });
    assert.equal(result.phone, '9779800000000');
    assert.equal(result.displayName, 'Customer');
});

test('incoming media is visible and group/outbound messages are excluded', async () => {
    const service = new WhatsAppService();
    const media = await service.normalizeIncomingMessage({}, {
        fromMe: false,
        from: '9779800000000@c.us',
        body: '',
        type: 'image',
        id: { id: 'image-1' },
        getContact: async () => ({})
    });
    assert.equal(media.body, '[Image]');
    assert.equal(await service.normalizeIncomingMessage({}, { fromMe: true, from: '9779800000000@c.us' }), null);
    assert.equal(await service.normalizeIncomingMessage({}, { fromMe: false, from: '12000000000@g.us', author: '9779800000000@c.us' }), null);
});
