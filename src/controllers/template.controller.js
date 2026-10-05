const {
    DEFAULT_TEMPLATES,
    ensureTemplateTable,
    seedDefaultTemplates
} = require('../utils/templateHelper');

const VALID_CHANNELS = new Set(['EMAIL', 'SMS']);

function normalizeChannel(channel) {
    return String(channel || 'EMAIL').toUpperCase();
}

async function listTemplates(req, res, next) {
    try {
        const ispId = Number(req.ispId);
        const channel = req.query.channel ? normalizeChannel(req.query.channel) : null;
        const eventKey = req.query.eventKey ? String(req.query.eventKey) : null;

        await seedDefaultTemplates(ispId, req.prisma);

        const rows = await req.prisma.messageTemplate.findMany({
            where: {
                ispId,
                ...(channel ? { channel } : {}),
                ...(eventKey ? { eventKey } : {})
            },
            orderBy: [
                { channel: 'asc' },
                { eventKey: 'asc' },
                { isDefault: 'desc' },
                { updatedAt: 'desc' }
            ]
        });

        res.json(rows);
    } catch (err) {
        next(err);
    }
}

async function createTemplate(req, res, next) {
    try {
        await ensureTemplateTable(req.prisma);
        const ispId = Number(req.ispId);
        const channel = normalizeChannel(req.body.channel);
        const { eventKey, name, subject, body } = req.body;

        if (!VALID_CHANNELS.has(channel)) return res.status(400).json({ error: 'Invalid template channel.' });
        if (!eventKey || !name || !body) return res.status(400).json({ error: 'Event, name, and body are required.' });

        await req.prisma.messageTemplate.create({
            data: {
                ispId,
                channel,
                eventKey: String(eventKey),
                name: String(name),
                subject: channel === 'EMAIL' ? (subject || null) : null,
                body: String(body),
                isActive: req.body.isActive !== false,
                isDefault: false
            }
        });

        res.status(201).json({ success: true });
    } catch (err) {
        next(err);
    }
}

async function updateTemplate(req, res, next) {
    try {
        await ensureTemplateTable(req.prisma);
        const ispId = Number(req.ispId);
        const id = Number(req.params.id);
        const channel = normalizeChannel(req.body.channel);
        const { eventKey, name, subject, body, isActive } = req.body;

        if (!id) return res.status(400).json({ error: 'Template id is required.' });
        if (!VALID_CHANNELS.has(channel)) return res.status(400).json({ error: 'Invalid template channel.' });
        if (!eventKey || !name || !body) return res.status(400).json({ error: 'Event, name, and body are required.' });

        await req.prisma.messageTemplate.updateMany({
            where: { id, ispId },
            data: {
                channel,
                eventKey: String(eventKey),
                name: String(name),
                subject: channel === 'EMAIL' ? (subject || null) : null,
                body: String(body),
                isActive: isActive !== false
            }
        });

        res.json({ success: true });
    } catch (err) {
        next(err);
    }
}

async function deleteTemplate(req, res, next) {
    try {
        await ensureTemplateTable(req.prisma);
        const ispId = Number(req.ispId);
        const id = Number(req.params.id);
        if (!id) return res.status(400).json({ error: 'Template id is required.' });

        await req.prisma.messageTemplate.deleteMany({
            where: { id, ispId, isDefault: false }
        });

        res.json({ success: true });
    } catch (err) {
        next(err);
    }
}

async function resetDefaults(req, res, next) {
    try {
        await seedDefaultTemplates(req.ispId, req.prisma);
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
}

function getTemplateMeta(req, res) {
    const eventKeys = [...new Map(DEFAULT_TEMPLATES.map(template => [template.eventKey, {
        eventKey: template.eventKey,
        label: template.name.replace(/ - .*/, ''),
        variables: Array.from(new Set((`${template.subject || ''}\n${template.body}`).match(/\{[a-zA-Z0-9_]+\}/g) || []))
            .map(item => item.slice(1, -1))
    }])).values()];

    res.json({ events: eventKeys, defaults: DEFAULT_TEMPLATES });
}

module.exports = {
    listTemplates,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    resetDefaults,
    getTemplateMeta
};
