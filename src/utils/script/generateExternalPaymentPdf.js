const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

function generatePdf(outputPath, baseUrl = 'https://cms.arrownet.com.np') {
  const hostUrl = String(baseUrl || 'https://cms.arrownet.com.np').replace(/\/+$/, '');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 40,
      bufferPages: true
    });

    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    const primaryColor = '#1e3a8a';   // Deep Blue
    const secondaryColor = '#059669'; // Emerald Green
    const darkColor = '#0f172a';      // Slate 900
    const grayColor = '#475569';      // Slate 600
    const codeBgColor = '#f1f5f9';    // Slate 100
    const borderColor = '#cbd5e1';    // Slate 300

    // Helper: Header block
    function drawHeader(title, subtitle) {
      doc.rect(40, 40, 515, 65).fill(primaryColor);
      doc.fillColor('#ffffff').fontSize(18).font('Helvetica-Bold').text(title, 55, 52);
      doc.fontSize(10).font('Helvetica').text(subtitle, 55, 76);
      doc.moveDown(2);
      doc.y = 120;
    }

    // Helper: Section Title
    function drawSectionTitle(text) {
      doc.moveDown(0.8);
      const y = doc.y;
      doc.rect(40, y, 4, 18).fill(secondaryColor);
      doc.fillColor(darkColor).fontSize(14).font('Helvetica-Bold').text(text, 50, y + 2);
      doc.moveDown(0.5);
    }

    // Helper: Subsection Title
    function drawSubTitle(text) {
      doc.moveDown(0.5);
      doc.fillColor(primaryColor).fontSize(11).font('Helvetica-Bold').text(text);
      doc.moveDown(0.2);
    }

    // Helper: Body text
    function drawText(text) {
      doc.fillColor(grayColor).fontSize(9.5).font('Helvetica').text(text, { lineGap: 2.5 });
      doc.moveDown(0.3);
    }

    // Helper: Code block
    function drawCode(code) {
      doc.moveDown(0.2);
      const y = doc.y;
      const height = (code.split('\n').length * 11) + 12;
      
      // Page break check
      if (y + height > 750) {
        doc.addPage();
      }

      const currentY = doc.y;
      doc.rect(40, currentY, 515, height).fill(codeBgColor);
      doc.rect(40, currentY, 515, height).stroke(borderColor);
      doc.fillColor('#0f172a').fontSize(8).font('Courier').text(code, 48, currentY + 6, {
        width: 500,
        lineGap: 1.5
      });
      doc.y = currentY + height + 8;
    }

    // Helper: Key-Value Table
    function drawTable(rows, colWidths = [140, 375]) {
      const startX = 40;
      doc.moveDown(0.3);
      for (const [col1, col2] of rows) {
        if (doc.y > 750) doc.addPage();
        const y = doc.y;
        doc.rect(startX, y, colWidths[0], 18).fill('#e2e8f0').stroke(borderColor);
        doc.rect(startX + colWidths[0], y, colWidths[1], 18).fill('#ffffff').stroke(borderColor);

        doc.fillColor(darkColor).fontSize(8.5).font('Helvetica-Bold').text(col1, startX + 6, y + 5);
        doc.fillColor(grayColor).fontSize(8.5).font('Helvetica').text(col2, startX + colWidths[0] + 6, y + 5);
        doc.y = y + 18;
      }
      doc.moveDown(0.5);
    }

    // ================= PAGE 1 =================
    drawHeader(
      'Kisan ISP - External Payment Public API Guide',
      'Production Documentation & Integration Manual | Version 1.0.0'
    );

    drawSectionTitle('1. Overview & Architecture');
    drawText(
      'The External Payment Gateway (externalpayment) provides an enterprise REST API that allows third-party payment gateways, bank channels, kiosk aggregators, and custom portals to push instant subscriber recharges, query customer balances, and synchronize billing transactions automatically with Kisan ISP.'
    );
    drawText(
      'It mirrors 100% of the proven architecture from existing payment integrations (such as eSewa) while introducing direct push recharge capabilities where an external service can recharge an account directly using a customer username and duration without requiring a prior inquiry request.'
    );

    drawSectionTitle('2. Endpoints Summary');
    const endpointRows = [
      ['POST /api/externalpayment/access-token', 'Obtains OAuth2 Bearer access token using username & password'],
      ['POST /api/externalpayment/login', 'Direct JSON login alternative returning Bearer token'],
      ['GET  /api/externalpayment/inquiry/:id', 'Search user by PPPoE username, customer ID, phone, or email'],
      ['GET  /api/externalpayment/user/:username', 'Lookup customer directly by PPPoE username (e.g. karnkalyan)'],
      ['POST /api/externalpayment/payment', 'Direct Push Recharge: renews subscription, RADIUS & invoice'],
      ['POST /api/externalpayment/recharge', 'Alias to /payment for direct recharge push'],
      ['POST /api/externalpayment/status', 'Transaction reconciliation & status query by transaction_code'],
      ['GET  /api/externalpayment/payment-modes', 'List available payment methods (EXTERNAL, CASH, ONLINE, etc.)'],
      ['GET  /externalpayment', 'Frontend management dashboard & instant recharge tester']
    ];
    drawTable(endpointRows, [210, 305]);

    drawSectionTitle('3. Authentication Methods');
    drawText(
      'The API supports multiple authentication strategies to ensure seamless compatibility with external servers, cron jobs, and webhooks:'
    );
    drawTable([
      ['Bearer Token', 'Header: Authorization: Bearer <access_token> (expires in 24 hours)'],
      ['HTTP Basic Auth', 'Header: Authorization: Basic <base64(username:password)>'],
      ['Payload Credentials', 'Body: "auth_username" & "auth_password" (or "username" & "password")'],
      ['API Key', 'Header: x-api-key: <api_key>']
    ], [130, 385]);

    // ================= PAGE 2 =================
    doc.addPage();
    drawHeader(
      'External Payment API - Customer Inquiry & Recharge',
      'Step-by-Step API Specification & Direct Recharge Workflows'
    );

    drawSectionTitle('4. Customer Inquiry (Inquiry API)');
    drawText(
      'Query customer status, current subscribed package, plan expiration date, and all available online packages for renewal. The inquiry parameter accepts: PPPoE username (e.g. karnkalyan), subscriber username, customer email, primary phone number, secondary contact number, or Customer Unique ID (e.g. CUST-1001).'
    );

    drawSubTitle('HTTP Request:');
    drawCode(`GET ${hostUrl}/api/externalpayment/inquiry/karnkalyan?lookup_type=all
Authorization: Basic ZXh0ZXJuYWxfaXNwXzE6RXh0ZXJuYWxASVNQIyExMjAyNQ==`);

    drawSubTitle('Success Response (JSON):');
    drawCode(`{
  "response_code": 0,
  "response_message": "success",
  "customer": {
    "id": 142,
    "customer_unique_id": "CUST-1001",
    "customer_name": "Kalyan Karn",
    "username": "karnkalyan",
    "subscriber_username": "karnkalyan",
    "phone": "9800000000",
    "secondary_phone": "9841000000",
    "email": "kalyan@gmail.com",
    "expiry_date": "2026-10-01",
    "status": "active",
    "is_rechargeable": true
  },
  "current_package": {
    "id": 12,
    "name": "KISAN-75-1-TV",
    "duration": "1 month",
    "amount": 1200
  },
  "packages": [
    { "id": 12, "name": "KISAN-75-1-TV", "duration": "1 month", "amount": 1200 },
    { "id": 13, "name": "KISAN-75-3-TV", "duration": "3 months", "amount": 3400 }
  ]
}`);

    drawSectionTitle('5. Direct Push Recharge API');
    drawText(
      'The primary endpoint for pushing payment confirmation and instant recharge. Supported identifiers: username, email, phone, secondary_number, subscriber_user, customerId, or identifier with lookup_type. The system automatically resolves the customer, calculates the new expiration date, provisions RADIUS, syncs the sales invoice to accounting, and marks the account active.'
    );

    drawSubTitle('HTTP Request (cURL):');
    drawCode(`curl -X POST "${hostUrl}/api/externalpayment/payment" \\
  -H "Content-Type: application/json" \\
  -u "external_isp_1:External@ISP#1!2025" \\
  -d '{
    "username": "karnkalyan",
    "lookup_type": "all",
    "payment_mode": "EXTERNAL",
    "duration": "1 month",
    "amount": 1200,
    "transaction_code": "EXT-TXN-9847291"
  }'`);

    drawSubTitle('Success Response (JSON):');
    drawCode(`{
  "response_code": 0,
  "response_message": "Payment and recharge successful",
  "data": {
    "transaction_code": "EXT-TXN-9847291",
    "reference_code": "EXT-20260916-B97FC73659FE-24",
    "order_id": 24,
    "customer_id": "CUST-1001",
    "customer_name": "Kalyan Karn",
    "username": "karnkalyan",
    "payment_mode": "EXTERNAL",
    "amount": 1200,
    "package_name": "KISAN-75-1-TV",
    "package_duration": "1 month",
    "new_expiry_date": "2026-11-01T18:15:00.000Z",
    "radius_provisioned": true
  }
}`);

    // ================= PAGE 3 =================
    doc.addPage();
    drawHeader(
      'External Payment API - Network & Accounting Sync',
      'RADIUS Provisioning, Accounting Integration & Reconciliation'
    );

    drawSectionTitle('6. RADIUS Provisioning & Network Refresh');
    drawText(
      'Upon every successful recharge, the system provisions the RADIUS AAA database in real-time:'
    );
    drawTable([
      ['Expiration Attribute', 'Updated in radreply table to the exact new calculated package end date.'],
      ['Session Disconnection', 'Sends a disconnect request (CoA / PoD) to NAS/BRAS so the user immediately reconnects with the renewed speed profile and updated quota.'],
      ['Service Status', 'Activates connection user status and sets customer service connection to active.']
    ], [150, 365]);

    drawSectionTitle('7. Accounting Invoice Synchronization');
    drawText(
      'Every external payment automatically generates an official sales invoice in the configured cloud accounting system (Tshul Accounting or Nepurix Cloud Accounting):'
    );
    drawTable([
      ['Customer Record', 'Matches or creates customer ledger in accounting using customer unique ID.'],
      ['Line Items', 'Breaks down Base Package, VAT (13%), Telecommunication Service Charge (TSC), and add-on charges.'],
      ['Payment Method', 'Allocated to the specified payment_mode (e.g. EXTERNAL, CASH, ONLINE) in accounting books.']
    ], [150, 365]);

    drawSectionTitle('8. Status Check & Reconciliation API');
    drawText(
      'Check status of any transaction to reconcile pending payments or confirm transaction execution.'
    );
    drawSubTitle('HTTP Request:');
    drawCode(`POST ${hostUrl}/api/externalpayment/status
Content-Type: application/json
Authorization: Basic ZXh0ZXJuYWxfaXNwXzE6RXh0ZXJuYWxASVNQIyExMjAyNQ==

{
  "transaction_code": "EXT-TXN-9847291"
}`);

    drawSubTitle('Response:');
    drawCode(`{
  "response_code": 0,
  "status": "COMPLETED",
  "response_message": "success",
  "data": {
    "transaction_code": "EXT-TXN-9847291",
    "reference_code": "EXT-20260916-B97FC73659FE-24",
    "amount": 1200,
    "payment_mode": "EXTERNAL",
    "paid_at": "2026-09-16T10:07:45.000Z"
  }
}`);

    // ================= PAGE 4 =================
    doc.addPage();
    drawHeader(
      'External Payment API - Access, Setup & Credentials',
      'Credential Management, System Settings & Dashboard Access'
    );

    drawSectionTitle('9. ISP Credential Generation & Management');
    drawText(
      'Each ISP tenant can independently generate and customize their external payment API username and password. This ensures complete isolation between ISPs.'
    );
    drawTable([
      ['Master Settings Tab', 'System Settings -> Master Settings -> External Payment tab.'],
      ['Dedicated Portal', 'Services -> 3rd Party Services -> External Payment API Requests.'],
      ['Credential Generator', 'Click "Generate Random Password" or enter a secure password and save.'],
      ['Default Payment Mode', 'Configurable per ISP (default: EXTERNAL).'],
      ['API Authentication', 'Supports HTTP Basic Auth (username:password), Bearer Token, or JSON body.']
    ], [150, 365]);

    drawSectionTitle('10. Frontend URLs & Live Recharge Tester');
    drawTable([
      ['Dashboard URL', `${hostUrl}/externalpayment`],
      ['Alternative URL', `${hostUrl}/services/externalpayment`],
      ['Sidebar Navigation', 'Services -> 3rd Party Services -> External Payment API Requests'],
      ['Live Tester Tab', 'Allows operators to enter a username & duration to test live push recharges directly.']
    ], [150, 365]);

    // Footer on all pages
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.rect(40, 785, 515, 1).fill(borderColor);
      doc.fillColor(grayColor).fontSize(8).font('Helvetica').text(
        'Kisan ISP Management System | Confidential & Proprietary',
        40,
        792
      );
      doc.text(
        `Page ${i + 1} of ${range.count}`,
        480,
        792,
        { align: 'right' }
      );
    }

    doc.end();

    stream.on('finish', () => resolve(outputPath));
    stream.on('error', reject);
  });
}

async function main() {
  const rootDir = path.resolve(__dirname, '../../../../');
  const backendPdfPath = path.join(rootDir, 'External_Payment_API_Documentation.pdf');
  const frontendPublicDir = path.join(rootDir, 'frontend', 'public', 'docs');

  if (!fs.existsSync(frontendPublicDir)) {
    fs.mkdirSync(frontendPublicDir, { recursive: true });
  }

  const frontendPdfPath = path.join(frontendPublicDir, 'External_Payment_API_Documentation.pdf');

  console.log('📄 Generating External Payment PDF documentation...');
  await generatePdf(backendPdfPath);
  console.log(`✅ Saved: ${backendPdfPath}`);

  fs.copyFileSync(backendPdfPath, frontendPdfPath);
  console.log(`✅ Saved to frontend public: ${frontendPdfPath}`);
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { generatePdf, main };
