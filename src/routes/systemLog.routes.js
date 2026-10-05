const express = require('express');
const isAuthenticated = require('../middlewares/isAuthenticated');
const checkPermission = require('../middlewares/checkPermission');
const { getSystemLogs } = require('../controllers/systemLog.controller');

module.exports = (prisma) => {
  const router = express.Router();
  router.use((req, res, next) => { req.prisma = prisma; next(); });
  router.get('/', isAuthenticated(prisma), checkPermission('audit_log_read'), getSystemLogs);
  return router;
};
