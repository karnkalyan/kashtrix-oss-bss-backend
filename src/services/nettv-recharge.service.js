const { ServiceFactory } = require('../lib/clients/ServiceFactory');
const { SERVICE_CODES } = require('../lib/serviceConstants');

const asObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

function collectSerials(data) {
  const serials = new Set();
  const add = value => { if (String(value || '').trim()) serials.add(String(value).trim()); };
  add(data?.provisioning?.stb?.serial);
  add(data?.stb?.serial);
  for (const entry of data?.stbs || []) add(entry?.serial || entry?.stb?.serial);
  for (const entry of data?.subscriber?.user_stbs || []) add(entry?.serial || entry?.stb?.serial);
  return [...serials];
}

async function updateStatus(prisma, subscription, serviceData, status) {
  if (!subscription) return;
  await prisma.customerSubscribedService.update({
    where: { id: subscription.id },
    data: { serviceData: { ...serviceData, netTvRecharge: status } }
  });
}

async function rechargeCustomerNetTV({ prisma, ispId, customerId, packageId, orderId }) {
  const [pkg, subscription] = await Promise.all([
    prisma.packagePrice.findFirst({
      where: { id: Number(packageId), ispId: Number(ispId), isDeleted: false },
      select: { oneTimeCharges: { where: { isDeleted: false }, select: { name: true, referenceId: true } } }
    }),
    prisma.customerSubscribedService.findFirst({
      where: { customerId: Number(customerId), service: { code: SERVICE_CODES.NETTV } },
      include: { service: { select: { code: true, name: true } } }
    })
  ]);
  const packageIncludesNetTV = (pkg?.oneTimeCharges || []).some(item => /net\s*tv/i.test(`${item.name || ''} ${item.referenceId || ''}`));
  if (!packageIncludesNetTV && !subscription) return { required: false, status: 'SKIPPED' };

  const serviceData = asObject(subscription?.serviceData);
  const baseStatus = { attemptedAt: new Date().toISOString(), orderId: Number(orderId), required: true };
  if (!subscription || String(subscription.status).toLowerCase() !== 'active') {
    const result = { ...baseStatus, status: 'FAILED', message: 'NetTV is included in this recharge, but the customer has no successfully provisioned NetTV subscription.' };
    await updateStatus(prisma, subscription, serviceData, result);
    return result;
  }
  const serials = collectSerials(serviceData);
  const payload = serviceData?.provisioning?.package || serviceData?.lastNetTVPackagePayload || serviceData?.packagePayload;
  if (!serials.length || !payload?.packages?.length) {
    const result = { ...baseStatus, status: 'FAILED', message: 'NetTV recharge could not run because the provisioned STB serial or package mapping is missing.' };
    await updateStatus(prisma, subscription, serviceData, result);
    return result;
  }
  try {
    const client = await ServiceFactory.getClient(SERVICE_CODES.NETTV, Number(ispId));
    const responses = [];
    for (const serial of serials) responses.push({ serial, response: await client.subscribePackages(serial, payload) });
    const result = { ...baseStatus, status: 'SUCCESS', message: `NetTV package recharged on ${serials.length} STB(s).`, serials };
    await updateStatus(prisma, subscription, serviceData, { ...result, responses });
    return result;
  } catch (error) {
    const result = { ...baseStatus, status: 'FAILED', message: `Internet package renewed, but NetTV recharge failed: ${error.message}` };
    await updateStatus(prisma, subscription, serviceData, result);
    return result;
  }
}

module.exports = { rechargeCustomerNetTV };
