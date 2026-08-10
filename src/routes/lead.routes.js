const express = require('express');
const multer = require('multer');
const {
  createLead,
  getAllLeads,
  getLeadById,
  updateLead,
  deleteLead,
  convertLeadToCustomer,
  getConvertedLeads,
  importLeadsFromCSV,
  downloadCSVTemplate,
  getLeadReports,
  exportLeadReport
} = require('../controllers/lead.controller');

const isAuthenticated = require('../middlewares/isAuthenticated');
const checkPermission = require('../middlewares/checkPermission');
const checkAnyPermission = require('../middlewares/checkAnyPermission');

// Configure multer for file upload
const storage = multer.memoryStorage(); // Store file in memory
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    // Accept CSV files only
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'), false);
    }
  }
});

module.exports = (prisma) => {
  const router = express.Router();

  router.use((req, res, next) => {
    req.prisma = prisma;
    next();
  });

  router.use(isAuthenticated(prisma));
  router.param('id', async (req, res, next, rawId) => {
    try {
      if (!req.user?.resellerId) return next();
      const lead = await prisma.lead.findFirst({
        where: {
          id: Number(rawId),
          ispId: Number(req.ispId),
          resellerId: Number(req.user.resellerId),
          isDeleted: false
        },
        select: { id: true }
      });
      if (!lead) return res.status(404).json({ error: 'Lead not found' });
      next();
    } catch (error) {
      next(error);
    }
  });

  // CRUD endpoints
  router.post('/', checkPermission('lead_create'), createLead);
  router.get('/template', checkPermission('lead_read'), downloadCSVTemplate);
  router.get('/', checkAnyPermission(['lead_read', 'tasks_read_self', 'tasks_update']), getAllLeads);
  router.get('/converted', checkPermission('lead_read'), getConvertedLeads);
  router.get('/reports/data', checkPermission('lead_read'), getLeadReports);
  router.get('/reports/export', checkPermission('lead_read'), exportLeadReport);
  router.get('/:id', checkPermission('lead_read'), getLeadById);
  router.put('/:id', checkPermission('lead_update'), updateLead);
  router.delete('/:id', checkPermission('lead_delete'), deleteLead);
  router.post('/:id/convert', checkPermission('customer_create'), convertLeadToCustomer);
  // Bulk import endpoint
  router.post('/import',
    checkPermission('lead_create'),
    upload.single('file'),
    importLeadsFromCSV
  );

  return router;
};
