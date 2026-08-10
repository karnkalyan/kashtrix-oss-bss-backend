const { Prisma } = require('@prisma/client');

const DATABASE_CONNECTION_ERROR_CODES = new Set([
  'P1000', // Authentication failed
  'P1001', // Database server is unreachable
  'P1002', // Database server timed out
  'P1008', // Operation timed out
  'P1017', // Server closed the connection
]);

function isDatabaseConnectionError(error) {
  return error instanceof Prisma.PrismaClientInitializationError ||
    error?.name === 'PrismaClientInitializationError' ||
    DATABASE_CONNECTION_ERROR_CODES.has(error?.code);
}

function errorHandler(error, req, res, next) {
  if (isDatabaseConnectionError(error)) {
    console.error(`[DATABASE] ${error.message || 'Database connection failed'}`);
    res.set('Retry-After', '5');
    return res.status(503).json({
      error: 'Database unavailable',
      message: 'The database is temporarily unavailable. Please try again shortly.',
    });
  }

  const requestId=req.headers?.['x-request-id']||req.id||null;
  console.error(`[${requestId||'request'}] ${error.code||error.name||'ERROR'}: ${error.message||error}`);
  if(error.code==='SSH_ALGORITHM_NEGOTIATION_FAILED'){
    const negotiation=error.negotiation||{};
    return res.status(error.status||502).json({connected:false,errorCode:error.code,message:'The device and Kashtrix could not agree on an SSH encryption algorithm.',negotiation:{direction:negotiation.direction||'unknown',category:negotiation.category||'unknown',profilesTried:error.profilesAttempted||[]},recommendations:['Verify that SSH version 2 is enabled on the device.','Review the device SSH encryption, MAC, host-key, and key-exchange configuration.','Upgrade device software when it supports only obsolete algorithms.','Use device-specific legacy compatibility only when required.'],requestId});
  }
  return res.status(error.status || 500).json({
    error: (error.status && error.status < 500) ? 'Request could not be completed.' : 'Internal server error.',
    requestId
  });
}

module.exports = { errorHandler, isDatabaseConnectionError };
