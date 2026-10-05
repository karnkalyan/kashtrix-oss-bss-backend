// prisma/seed.js
const { PrismaClient } = require('@prisma/client');
// const bcrypt = require('bcrypt'); // Only needed if seeding users with passwords

const prisma = new PrismaClient();

async function main() {
  console.log('Start seeding specific data...');

  // Production-safe catalog upserts: never delete ISP configuration or credentials.
  for (const service of [
    { name: 'TShul Billing', code: 'TSHUL', description: 'TShul accounting and invoicing integration', category: 'BILLING', iconUrl: '/icons/tshul.svg' },
    { name: 'Nepurix Accounting', code: 'NEPURIX', description: 'Nepurix accounting and invoicing integration', category: 'BILLING', iconUrl: '/icons/nepurix.svg' },
    { name: 'eSewa', code: 'ESEWA', description: 'eSewa token payment and ePay v2 gateway', category: 'PAYMENT', iconUrl: '/icons/esewa.svg' }
  ]) {
    await prisma.service.upsert({
      where: { code: service.code },
      update: { ...service, isActive: true, isDeleted: false },
      create: service
    });
  }

  // --- 1. Define all unique Granular Permissions as objects { name, menuName } ---
  const allPermissions = [
    // Dashboard
    { name: 'dashboard_view', menuName: 'dashboard' },

    // Users
    { name: 'users_read', menuName: 'users' },
    { name: 'users_create', menuName: 'users' },
    { name: 'users_update', menuName: 'users' },
    { name: 'users_delete', menuName: 'users' },

    // Roles
    { name: 'roles_read', menuName: 'roles' },
    { name: 'roles_create', menuName: 'roles' },
    { name: 'roles_update', menuName: 'roles' },
    { name: 'roles_delete', menuName: 'roles' },

    // Departments
    { name: 'departments_read', menuName: 'departments' },
    { name: 'departments_create', menuName: 'departments' },
    { name: 'departments_update', menuName: 'departments' },
    { name: 'departments_delete', menuName: 'departments' },

    // ISP Management
    { name: 'isp_read', menuName: 'isp' },
    { name: 'isp_create', menuName: 'isp' },
    { name: 'isp_update', menuName: 'isp' },
    { name: 'isp_delete', menuName: 'isp' },

    // Connection Types
    { name: 'connection_types_read', menuName: 'connection_types' },
    { name: 'connection_types_create', menuName: 'connection_types' },
    { name: 'connection_types_update', menuName: 'connection_types' },
    { name: 'connection_types_delete', menuName: 'connection_types' },

    // Package Plans
    { name: 'package_plans_read', menuName: 'package_plans' },
    { name: 'package_plans_create', menuName: 'package_plans' },
    { name: 'package_plans_update', menuName: 'package_plans' },
    { name: 'package_plans_delete', menuName: 'package_plans' },


    // Package price
    { name: 'package_price_read', menuName: 'package_price' },
    { name: 'package_price_create', menuName: 'package_price' },
    { name: 'package_price_update', menuName: 'package_price' },
    { name: 'package_price_delete', menuName: 'package_price' },


    // One-Time Charges
    { name: 'one_time_charges_read', menuName: 'one_time_charges' },
    { name: 'one_time_charges_create', menuName: 'one_time_charges' },
    { name: 'one_time_charges_update', menuName: 'one_time_charges' },
    { name: 'one_time_charges_delete', menuName: 'one_time_charges' },

    // Reports
    { name: 'reports_read', menuName: 'reports' },
    { name: 'reports_generate', menuName: 'reports' },

    // Settings
    { name: 'settings_read', menuName: 'settings' },
    { name: 'settings_update', menuName: 'settings' },

    // Billing
    { name: 'billing_read', menuName: 'billing' },
    { name: 'billing_create', menuName: 'billing' },
    { name: 'billing_update', menuName: 'billing' },
    { name: 'billing_delete', menuName: 'billing' },
    { name: 'billing_read_self', menuName: 'billing' }, // Specific for customers to view their own billing


    // Customer Management
    { name: 'customer_read', menuName: 'customers' },
    { name: 'customer_create', menuName: 'customers' },
    { name: 'customer_update', menuName: 'customers' },
    { name: 'customer_delete', menuName: 'customers' },

    // Ticket Management
    { name: 'tickets_read', menuName: 'tickets' },
    { name: 'tickets_create', menuName: 'tickets' },
    { name: 'tickets_update', menuName: 'tickets' },
    { name: 'tickets_delete', menuName: 'tickets' },
    { name: 'tickets_read_self', menuName: 'tickets' },


    // Existing ISP Management
    { name: 'existingisp_read', menuName: 'existingisp' },
    { name: 'existingisp_create', menuName: 'existingisp' },
    { name: 'existingisp_update', menuName: 'existingisp' },
    { name: 'existingisp_delete', menuName: 'existingisp' },

    // Lead Management
    { name: 'lead_read', menuName: 'leads' },
    { name: 'lead_create', menuName: 'leads' },
    { name: 'lead_update', menuName: 'leads' },
    { name: 'lead_delete', menuName: 'leads' },

    // Membership Management
    { name: 'membership_read', menuName: 'memberships' },
    { name: 'membership_create', menuName: 'memberships' },
    { name: 'membership_update', menuName: 'memberships' },
    { name: 'membership_delete', menuName: 'memberships' },

    // Olt Management
    { name: 'olt_read', menuName: 'olts' },
    { name: 'olt_create', menuName: 'olts' },
    { name: 'olt_update', menuName: 'olts' },
    { name: 'olt_delete', menuName: 'olts' },

    // Splitter Management
    { name: 'splitter_read', menuName: 'splitters' },
    { name: 'splitter_create', menuName: 'splitters' },
    { name: 'splitter_update', menuName: 'splitters' },
    { name: 'splitter_delete', menuName: 'splitters' },

    // In your permission seed data
    { name: 'branches_create', menuName: 'Branches' },
    { name: 'branches_read', menuName: 'Branches' },
    { name: 'branches_update', menuName: 'Branches' },
    { name: 'branches_delete', menuName: 'Branches' },

    // services permission
    { name: 'services_read', menuName: 'Services' },
    { name: 'services_create', menuName: 'Services' },
    { name: 'services_update', menuName: 'Services' },
    { name: 'services_delete', menuName: 'Services' },
    { name: 'services_configure', menuName: 'Services' },
    { name: 'services_test', menuName: 'Services' },
    { name: 'services_export', menuName: 'Services' },
    { name: 'services_import', menuName: 'Services' },
    { name: 'services_manage', menuName: 'Services' },


    // yeastar permission
    { name: 'yeaster_read', menuName: 'yeaster' },
    { name: 'yeaster_create', menuName: 'yeaster' },
    { name: 'yeaster_update', menuName: 'yeaster' },
    { name: 'yeaster_delete', menuName: 'yeaster' },
    { name: 'yeaster_manage', menuName: 'yeaster' },

    // asterisk permission
    { name: 'asterisk_read', menuName: 'asterisk' },
    { name: 'asterisk_manage', menuName: 'asterisk' },

    // NAS permission
    { name: 'nas_read', menuName: 'NAS' },
    { name: 'nas_create', menuName: 'NAS' },
    { name: 'nas_update', menuName: 'NAS' },
    { name: 'nas_delete', menuName: 'NAS' },
    { name: 'tasks_read', menuName: 'tasks' },
    { name: 'tasks_create', menuName: 'tasks' },
    { name: 'tasks_update', menuName: 'tasks' },
    { name: 'tasks_delete', menuName: 'tasks' },
    { name: 'tasks_read_self', menuName: 'tasks' },

    // Bulk Inventory, Drums, Audit Log permissions
    { name: 'bulk_inventory_read', menuName: 'bulk_inventory' },
    { name: 'bulk_inventory_create', menuName: 'bulk_inventory' },
    { name: 'bulk_inventory_update', menuName: 'bulk_inventory' },
    { name: 'bulk_inventory_delete', menuName: 'bulk_inventory' },
    { name: 'drums_read', menuName: 'drums' },
    { name: 'drums_create', menuName: 'drums' },
    { name: 'drums_update', menuName: 'drums' },
    { name: 'drums_delete', menuName: 'drums' },
    { name: 'audit_log_read', menuName: 'audit_log' }
  ];

  // --- 2. Define Roles with their specific granular permissions ---
  const rolesData = [
    {
      name: 'Administrator',
      permissions: allPermissions, // Administrator has all permissions
    },
    {
      name: 'Manager',
      permissions: [
        { name: 'dashboard_view', menuName: 'dashboard' },
        { name: 'users_read', menuName: 'users' }, { name: 'users_create', menuName: 'users' }, { name: 'users_update', menuName: 'users' },
        { name: 'departments_read', menuName: 'departments' },
        { name: 'connection_types_read', menuName: 'connection_types' },
        { name: 'package_plans_read', menuName: 'package_plans' },
        { name: 'one_time_charges_read', menuName: 'one_time_charges' },
        { name: 'reports_read', menuName: 'reports' }, { name: 'reports_generate', menuName: 'reports' },
        { name: 'billing_read', menuName: 'billing' },
      ],
    },
    {
      name: 'Support Agent',
      permissions: [
        { name: 'dashboard_view', menuName: 'dashboard' },
        { name: 'users_read', menuName: 'users' },
        { name: 'connection_types_read', menuName: 'connection_types' },
        { name: 'package_plans_read', menuName: 'package_plans' },
      ],
    },
    {
      name: 'Billing Clerk',
      permissions: [
        { name: 'dashboard_view', menuName: 'dashboard' },
        { name: 'users_read', menuName: 'users' },
        { name: 'billing_read', menuName: 'billing' }, { name: 'billing_create', menuName: 'billing' }, { name: 'billing_update', menuName: 'billing' },
        { name: 'one_time_charges_read', menuName: 'one_time_charges' }, { name: 'one_time_charges_create', menuName: 'one_time_charges' }, { name: 'one_time_charges_update', menuName: 'one_time_charges' }, { name: 'one_time_charges_delete', menuName: 'one_time_charges' },
      ],
    },
    {
      name: 'Customer',
      permissions: [
        { name: 'dashboard_view', menuName: 'dashboard' },
        { name: 'billing_read_self', menuName: 'billing' },
        { name: 'customer_read', menuName: 'customers' },
        { name: 'tickets_read_self', menuName: 'tickets' },
        { name: 'tickets_create', menuName: 'tickets' },
      ],
    },
    {
      name: 'Field Staff',
      permissions: [
        { name: 'dashboard_view', menuName: 'dashboard' },
        { name: 'tasks_read_self', menuName: 'tasks' },
        { name: 'tasks_update', menuName: 'tasks' }, // Can update status of their tasks
      ],
    },
  ];

  // --- 3. Define Departments ---
  const departmentsData = [
    { name: 'IT', description: 'Manages all information technology infrastructure.' },
    { name: 'Customer Support', description: 'Handles customer inquiries and issues.' },
    { name: 'Field Operations', description: 'Manages on-site installations and maintenance.' },
    { name: 'Finance', description: 'Manages financial operations and billing.' },
    { name: 'Sales', description: 'Responsible for selling services and acquiring new customers.' },
    { name: 'Marketing', description: 'Handles brand promotion and lead generation.' },
    { name: 'Human Resources', description: 'Manages employee relations and recruitment.' },
  ];

  // --- Clear existing data for these models (Essential for a clean re-seed) ---
  // Order matters due to foreign key constraints: Users -> Roles -> Permissions, Users -> Departments

  await prisma.role.deleteMany({});
  await prisma.permission.deleteMany({});
  await prisma.department.deleteMany({});



  console.log('Existing data for Users, Roles, Permissions, Departments cleared.');


  // --- Create Permissions ---
  const createdPermissions = {}; // Store permissions by their full 'name'
  for (const permData of allPermissions) {
    const permission = await prisma.permission.create({
      data: { name: permData.name, menuName: permData.menuName },
    });
    createdPermissions[permData.name] = permission; // Use permData.name as the key
    console.log(`Created Permission: ${permission.menuName} - ${permission.name}`);
  }

  // --- Create Departments ---
  const createdDepartments = {};
  for (const dept of departmentsData) {
    const department = await prisma.department.create({
      data: dept,
    });
    createdDepartments[dept.name] = department;
    console.log(`Created Department: ${department.name}`);
  }

  // --- Create Roles and link Permissions ---
  const createdRoles = {};
  for (const roleData of rolesData) {
    // Map by the full permission name string
    const rolePermissions = roleData.permissions
      .map((pData) => createdPermissions[pData.name]?.id ? { id: createdPermissions[pData.name].id } : null)
      .filter(Boolean);
    const role = await prisma.role.create({
      data: {
        name: roleData.name,
        permissions: {
          connect: rolePermissions,
        },
      },
    });
    createdRoles[roleData.name] = role;
    console.log(`Created Role: ${role.name} with ${rolePermissions.length} permissions.`);
  }

  // IMPORTANT: If you want to seed users linked to these roles and departments,
  // ensure you have ISP data already, or create a dummy ISP here first.
  // Example for a user (uncomment and modify as needed):

  // const dummyIsp = await prisma.iSP.findFirst(); // Or create if none exists
  // if (dummyIsp) {
  //   const hashedPassword = await bcrypt.hash('UserPassword123!', 10);
  //   await prisma.user.create({
  //     data: {
  //       name: 'Example User',
  //       email: 'user@example.com',
  //       passwordHash: hashedPassword,
  //       status: 'active',
  //       role: { connect: { id: createdRoles['Manager'].id } }, // Assign a role
  //       department: { connect: { id: createdDepartments['IT'].id } }, // Assign a department
  //       isp: { connect: { id: dummyIsp.id } },
  //     },
  //   });
  //   console.log('Created example user.');
  // } else {
  //   console.warn('Skipping user creation as no ISP found/created.');
  // }


  console.log('Specific data seeding finished.');
}

// ... (main() catch and finally blocks from your original seed.js)
main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
