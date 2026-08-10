const API_SCOPE_CATALOG = Object.freeze([
  { value: 'profile:read', label: 'Token profile', description: 'Inspect the current token identity and effective tenant scope.' },
  { value: 'customers:read', label: 'Customers', description: 'List and read customers inside the token tenant, branch, and reseller scope.' },
  { value: 'devices:read', label: 'Managed devices', description: 'List and read managed network devices inside the token scope.' },
]);

const EXTERNAL_API_ROUTES = Object.freeze([
  {
    method: 'GET', path: '/api/v1/routes', scope: null, title: 'API route catalog',
    description: 'Returns the routes available to the current token.',
  },
  {
    method: 'GET', path: '/api/v1/me', scope: 'profile:read', title: 'Token profile',
    description: 'Returns token name, scopes, expiration, and effective tenant restrictions.',
  },
  {
    method: 'GET', path: '/api/v1/customers', scope: 'customers:read', title: 'List customers',
    description: 'Paginated customer list. Supports page, limit, and search query parameters.',
    query: { page: 'Positive integer', limit: '1-100', search: 'Customer ID, name, or phone' },
  },
  {
    method: 'GET', path: '/api/v1/customers/:id', scope: 'customers:read', title: 'Get customer',
    description: 'Returns one customer when it belongs to the token tenant and optional branch/reseller scope.',
  },
  {
    method: 'GET', path: '/api/v1/devices', scope: 'devices:read', title: 'List managed devices',
    description: 'Paginated managed-device list. Supports page and limit query parameters.',
    query: { page: 'Positive integer', limit: '1-100' },
  },
  {
    method: 'GET', path: '/api/v1/devices/:id', scope: 'devices:read', title: 'Get managed device',
    description: 'Returns one managed device when it belongs to the token tenant and optional branch/reseller scope.',
  },
]);

module.exports = { API_SCOPE_CATALOG, EXTERNAL_API_ROUTES };
