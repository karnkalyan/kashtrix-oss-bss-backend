const prisma = require('../../prisma/client');

function emailDetailRows(rows) {
  return rows
    .map(([label, value]) => `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#64748b;font-size:13px;width:38%;">${label}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#0f172a;font-size:13px;font-weight:700;">${value}</td>
      </tr>
    `)
    .join('');
}

function emailTemplate({ eyebrow, title, intro, rows = [], note = '', accent = '#2563eb' }) {
  return `
<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#eef2f7;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#eef2f7;padding:28px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:680px;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #dbe3ef;box-shadow:0 14px 36px rgba(15,23,42,0.12);">
            <tr>
              <td style="background:${accent};padding:22px 28px;color:#ffffff;">
                <div style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;font-weight:700;opacity:0.9;">${eyebrow}</div>
                <div style="font-size:26px;line-height:1.2;font-weight:800;margin-top:8px;">${title}</div>
                <div style="font-size:14px;line-height:1.6;margin-top:8px;opacity:0.95;">{ispName}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:28px;">
                <div style="font-size:15px;line-height:1.8;color:#334155;">${intro}</div>
                ${rows.length ? `
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:22px;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;background:#ffffff;">
                    ${emailDetailRows(rows)}
                  </table>
                ` : ''}
                ${note ? `<div style="margin-top:22px;padding:14px 16px;border-radius:12px;background:#f8fafc;border:1px solid #e2e8f0;color:#475569;font-size:13px;line-height:1.6;">${note}</div>` : ''}
                <div style="margin-top:28px;border-top:1px solid #e5e7eb;padding-top:18px;">
                  <div style="font-size:14px;font-weight:800;color:#0f172a;">{ispName}</div>
                  <div style="font-size:13px;color:#64748b;margin-top:4px;">{companyAddress}</div>
                  <div style="font-size:13px;color:#64748b;margin-top:4px;">Phone: {companyPhone} &nbsp; Email: {companyEmail}</div>
                  <div style="font-size:12px;color:#94a3b8;margin-top:10px;">This is an automated message from {ispName}. Please keep this email for your records.</div>
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

const DEFAULT_TEMPLATES = [
  {
    channel: 'EMAIL',
    eventKey: 'customer_new_connection',
    name: 'New Connection - Customer',
    subject: 'Welcome to {ispName}, {customerName}',
    body: emailTemplate({
      eyebrow: 'New Connection',
      title: 'Welcome, {customerName}',
      intro: 'Your new internet connection has been created successfully. Below are your customer and package details.',
      rows: [
        ['Customer ID', '{customerUniqueId}'],
        ['Package', '{packageName}'],
        ['Plan Start', '{planStart}'],
        ['Plan End', '{planEnd}'],
        ['Login Username', '{username}'],
        ['Login Password', '{password}'],
        ['Login URL', '{loginUrl}']
      ],
      note: 'For your account security, please keep your login credentials private and contact support if you need any help.',
      accent: '#0f766e'
    })
  },
  {
    channel: 'EMAIL',
    eventKey: 'user_welcome',
    name: 'Welcome - New User',
    subject: 'Welcome to {ispName}, {userName}',
    body: emailTemplate({
      eyebrow: 'User Account Created',
      title: 'Welcome, {userName}',
      intro: 'Your account has been created successfully. Use the credentials below to sign in.',
      rows: [
        ['Login Username', '{username}'],
        ['Login Password', '{password}'],
        ['Login URL', '{loginUrl}']
      ],
      note: 'For your account security, sign in and change your password as soon as possible. Never share your credentials.',
      accent: '#2563eb'
    })
  },
  {
    channel: 'EMAIL',
    eventKey: 'password_reset',
    name: 'Password Reset',
    subject: 'Reset your {ispName} password',
    body: emailTemplate({
      eyebrow: 'Password Reset',
      title: 'Reset Your Password',
      intro: 'Hello {userName}, we received a request to reset your account password.',
      rows: [
        ['Account', '{username}'],
        ['Reset URL', '{resetUrl}'],
        ['Link Expires', '{expiresIn}']
      ],
      note: 'If you did not request this reset, you can safely ignore this email. This link can be used only once.',
      accent: '#dc2626'
    })
  },
  {
    channel: 'EMAIL',
    eventKey: 'support_ticket_customer',
    name: 'Support Ticket - Customer',
    subject: 'Support Ticket Created: {ticketNumber}',
    body: emailTemplate({
      eyebrow: 'Support Request',
      title: 'Ticket Created Successfully',
      intro: 'Dear {customerName}, your support ticket has been created. Our team will review it and contact you soon.',
      rows: [
        ['Ticket Number', '{ticketNumber}'],
        ['Title', '{title}'],
        ['Priority', '{priority}'],
        ['Customer Phone', '{customerPhone}'],
        ['Customer Email', '{customerEmail}']
      ],
      note: 'You can reply to this email or contact support with your ticket number for faster assistance.',
      accent: '#2563eb'
    })
  },
  {
    channel: 'EMAIL',
    eventKey: 'support_ticket_assignee',
    name: 'Support Ticket - Assigned User',
    subject: 'Ticket Assigned: {ticketNumber}',
    body: emailTemplate({
      eyebrow: 'Ticket Assignment',
      title: 'A Ticket Needs Your Attention',
      intro: 'Hello {userName}, a support ticket has been assigned to you. Please review the details and take action.',
      rows: [
        ['Ticket Number', '{ticketNumber}'],
        ['Customer', '{customerName}'],
        ['Title', '{title}'],
        ['Priority', '{priority}'],
        ['Description', '{description}']
      ],
      accent: '#7c3aed'
    })
  },
  {
    channel: 'EMAIL',
    eventKey: 'support_ticket_branch',
    name: 'Support Ticket - Branch Support',
    subject: 'New Ticket in {branchName}: {ticketNumber}',
    body: emailTemplate({
      eyebrow: 'Branch Support',
      title: 'New Ticket in {branchName}',
      intro: 'Hello {userName}, a new support ticket has been created in your branch.',
      rows: [
        ['Branch', '{branchName}'],
        ['Ticket Number', '{ticketNumber}'],
        ['Customer', '{customerName}'],
        ['Title', '{title}'],
        ['Priority', '{priority}'],
        ['Description', '{description}']
      ],
      accent: '#0891b2'
    })
  },
  {
    channel: 'EMAIL',
    eventKey: 'task_assigned_user',
    name: 'Task Assigned - User',
    subject: 'Task Assigned: {taskTitle}',
    body: emailTemplate({
      eyebrow: 'Task Assignment',
      title: 'New Task Assigned',
      intro: 'Hello {userName}, a new task has been assigned to you. Please check your dashboard and proceed.',
      rows: [
        ['Task', '{taskTitle}'],
        ['Priority', '{priority}'],
        ['Customer', '{customerName}'],
        ['Ticket', '{ticketNumber}'],
        ['Description', '{description}']
      ],
      accent: '#ea580c'
    })
  },
  {
    channel: 'EMAIL',
    eventKey: 'lead_followup',
    name: 'Lead Follow-up',
    subject: 'Following Up On Your Internet Inquiry',
    body: emailTemplate({
      eyebrow: 'Internet Inquiry',
      title: 'Thank You For Your Interest',
      intro: 'Dear {leadName}, thank you for your interest in {ispName}. Our team can help you choose the right internet package for your home or business.',
      rows: [
        ['Lead Name', '{leadName}'],
        ['Interested Package', '{packageName}'],
        ['Phone', '{phoneNumber}']
      ],
      note: 'We would be happy to answer your questions about installation, packages, billing, and support.',
      accent: '#16a34a'
    })
  },
  {
    channel: 'EMAIL',
    eventKey: 'subscription_expiring',
    name: 'Subscription Expiring Soon',
    subject: 'Your subscription expires soon',
    body: emailTemplate({
      eyebrow: 'Subscription Reminder',
      title: 'Your Subscription Expires Soon',
      intro: 'Dear {customerName}, your internet subscription is close to expiry. Please recharge before the expiry date to continue uninterrupted service.',
      rows: [
        ['Customer ID', '{customerUniqueId}'],
        ['Package', '{packageName}'],
        ['Expiry Date', '{expiryDate}'],
        ['Amount Due', '{amount}']
      ],
      note: 'Recharge before expiry to avoid service interruption.',
      accent: '#ca8a04'
    })
  },
  {
    channel: 'EMAIL',
    eventKey: 'recharge_success',
    name: 'Recharge Successful',
    subject: 'Recharge Successful - {ispName}',
    body: emailTemplate({
      eyebrow: 'Payment Confirmation',
      title: 'Recharge Successful',
      intro: 'Dear {customerName}, your recharge has been completed successfully. Thank you for your payment.',
      rows: [
        ['Customer ID', '{customerUniqueId}'],
        ['Package', '{packageName}'],
        ['Amount', '{amount}'],
        ['Valid Until', '{expiryDate}']
      ],
      note: 'Your plan validity has been updated. Please contact support if your service does not resume shortly.',
      accent: '#0f766e'
    })
  },
  {
    channel: 'SMS',
    eventKey: 'ticket_creation',
    name: 'Support Ticket SMS',
    body: 'Dear {firstName}, ticket {ticketNumber} has been created for {title}. {ispName}'
  },
  {
    channel: 'SMS',
    eventKey: 'task_assigned_user',
    name: 'Task Assigned SMS',
    body: 'Task assigned: {taskTitle}. Priority: {priority}. Please check your dashboard.'
  },
  {
    channel: 'SMS',
    eventKey: 'subscription_expiring',
    name: 'Subscription Expiry SMS',
    body: 'Dear {customerName}, your {packageName} subscription expires on {expiryDate}. Please recharge soon.'
  },
  {
    channel: 'SMS',
    eventKey: 'recharge_success',
    name: 'Recharge Success SMS',
    body: 'Dear {customerName}, recharge of {amount} is successful. Valid until {expiryDate}.'
  },
  {
    channel: 'SMS',
    eventKey: 'customer_new_connection',
    name: 'New Connection SMS',
    body: 'Dear {customerName}, your new connection is created. Customer ID: {customerUniqueId}. {ispName}'
  }
];

async function ensureTemplateTable(db = prisma) {
  // Table is managed by Prisma (MessageTemplate model)
}

async function seedDefaultTemplates(ispId, db = prisma) {
  if (!db.messageTemplate) return;
  const numericIspId = Number(ispId);
  for (const template of DEFAULT_TEMPLATES) {
    const existing = await db.messageTemplate.findFirst({
      where: {
        ispId: numericIspId,
        channel: template.channel,
        eventKey: template.eventKey,
        isDefault: true
      }
    });
    if (existing) {
      const nextSubject = template.subject || null;
      if (existing.name !== template.name || existing.subject !== nextSubject || existing.body !== template.body) {
        await db.messageTemplate.update({
          where: { id: existing.id },
          data: {
            name: template.name,
            subject: nextSubject,
            body: template.body,
            isActive: true
          }
        });
      }
    } else {
      await db.messageTemplate.create({
        data: {
          ispId: numericIspId,
          channel: template.channel,
          eventKey: template.eventKey,
          name: template.name,
          subject: template.subject || null,
          body: template.body,
          isActive: true,
          isDefault: true
        }
      });
    }
  }
}

function looksLikeHtml(text = '') {
  return /<\/?[a-z][\s\S]*>/i.test(String(text));
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderText(text = '', data = {}, options = {}) {
  return String(text).replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
    const value = data[key];
    const normalizedValue = value === undefined || value === null ? '' : String(value);
    return options.escapeValues ? escapeHtml(normalizedValue) : normalizedValue;
  });
}

function textToHtml(text = '') {
  if (looksLikeHtml(text)) return String(text);
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

async function renderTemplate(ispId, channel, eventKey, data = {}, fallback = {}, db = prisma) {
  const normalizedChannel = String(channel).toUpperCase();
  console.log('[templateHelper] Rendering notification template', {
    ispId,
    channel: normalizedChannel,
    eventKey,
    hasFallbackSubject: Boolean(fallback.subject),
    hasFallbackBody: Boolean(fallback.body)
  });
  await seedDefaultTemplates(ispId, db);
  let companyData = {};
  if (ispId) {
    const isp = await db.iSP.findUnique({
      where: { id: Number(ispId) },
      select: {
        companyName: true,
        phoneNumber: true,
        masterEmail: true,
        address: true,
        city: true,
        state: true,
        country: true,
        website: true
      }
    }).catch(() => null);
    if (isp) {
      const addressParts = [isp.address, isp.city, isp.state, isp.country].filter(Boolean);
      companyData = {
        ispName: isp.companyName,
        companyName: isp.companyName,
        companyPhone: isp.phoneNumber || '',
        companyEmail: isp.masterEmail || '',
        companyAddress: addressParts.join(', '),
        companyWebsite: isp.website || ''
      };
    }
  }
  let template = fallback;
  if (db.messageTemplate) {
    const row = await db.messageTemplate.findFirst({
      where: {
        ispId: Number(ispId),
        channel: normalizedChannel,
        eventKey,
        isActive: true
      },
      orderBy: [
        { isDefault: 'asc' },
        { updatedAt: 'desc' }
      ]
    });
    if (row) template = row;
  }
  // Company fields loaded for the authenticated ISP are authoritative. Some
  // callers provide generic fallback values (for example "ISP"), which must
  // not replace the real tenant branding resolved above.
  const mergedData = { ...data, ...companyData };
  const bodyTemplate = template.body || fallback.body || '';
  const bodyIsHtml = normalizedChannel === 'EMAIL' && looksLikeHtml(bodyTemplate);
  const rendered = {
    subject: renderText(template.subject || fallback.subject || '', mergedData),
    body: renderText(bodyTemplate, mergedData, { escapeValues: bodyIsHtml })
  };
  console.log('[templateHelper] Notification template rendered', {
    ispId,
    channel: normalizedChannel,
    eventKey,
    source: rows[0] ? 'database' : 'fallback',
    subjectLength: rendered.subject.length,
    bodyLength: rendered.body.length
  });
  return rendered;
}

module.exports = {
  DEFAULT_TEMPLATES,
  ensureTemplateTable,
  seedDefaultTemplates,
  renderTemplate,
  renderText,
  textToHtml
};
