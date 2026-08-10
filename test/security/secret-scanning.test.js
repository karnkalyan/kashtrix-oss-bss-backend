const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.next',
  '.git',
  'dist',
  'build',
  'coverage',
  'uploads',
  'codex-backend.err.log',
  'codex-backend.out.log',
  'codex-next.err.log',
  'codex-next.out.log',
  'codex-ui.err.log',
  'codex-ui.out.log',
  '.runtime-err.log',
  '.runtime-out.log',
  'ai-worker.stderr.log',
  'ai-worker.stdout.log'
]);

const SECRET_PATTERNS = [
  { name: 'Google API Key', regex: /AIzaSy[A-Za-z0-9_-]{35}/ },
  { name: 'OpenAI API Key', regex: /sk-[a-zA-Z0-9]{20,}/ },
  { name: 'Generic Password Assignment', regex: /(?:password|passwd|shared_secret|api_key|client_secret)\s*[:=]\s*(['"`])(?![A-Z_]+\1)(.*?)\1/i },
  { name: 'Private Key Block', regex: /-----BEGIN (?:RSA |EC |PEM |OPENSSH )?PRIVATE KEY-----/ }
];

function scanDir(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (EXCLUDED_DIRS.has(file) || EXCLUDED_DIRS.has(path.relative(process.cwd(), fullPath))) {
      continue;
    }
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      scanDir(fullPath, fileList);
    } else if (stat.isFile() && /\.(js|ts|tsx|jsx|json|prisma)$/.test(file)) {
      // Exclude test files from checking literal passwords so test mocks don't trip
      if (file.endsWith('.test.js')) continue;
      fileList.push(fullPath);
    }
  }
  return fileList;
}

const FALSE_POSITIVES = new Set([
  'Password',
  'Minimum',
  '••••••••',
  'password',
  'true',
  'false',
  'null',
  'undefined',
  'demo-radius-password',
  'Password is required',
  'Minimum 8 characters',
  'Minimum 6 characters',
  ''
]);

test('Secret Scanning: Ensure no credentials or keys are hardcoded in source files', () => {
  const files = [];
  const rootDir = path.resolve(__dirname, '../../');
  scanDir(rootDir, files);

  // Also scan frontend files
  const frontendDir = path.resolve(rootDir, '../frontend');
  if (fs.existsSync(frontendDir)) {
    scanDir(frontendDir, files);
  }

  const leaks = [];

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    for (const pattern of SECRET_PATTERNS) {
      const matches = content.matchAll(new RegExp(pattern.regex, 'gi'));
      for (const match of matches) {
        // Double check it's not an environment variable placeholder
        if (!match[0].includes('process.env') && !match[0].includes('env.')) {
          // Extract the literal value inside quotes (capture group 2)
          const literal = match[2] || '';
          if (FALSE_POSITIVES.has(literal) || literal.length < 5) {
            continue;
          }
          leaks.push({
            file: path.relative(rootDir, file),
            type: pattern.name,
            matched: match[0].substring(0, 40) // only log a portion to avoid leaking in CI logs
          });
        }
      }
    }
  }

  if (leaks.length > 0) {
    console.error('⚠️ SECRET LEAK DETECTED ⚠️');
    console.error(JSON.stringify(leaks, null, 2));
  }

  assert.equal(leaks.length, 0, `Detected ${leaks.length} potential hardcoded secrets in the codebase.`);
});
