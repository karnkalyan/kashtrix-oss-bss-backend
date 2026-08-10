// scripts/test-complete-flow.js
const jwt = require('jsonwebtoken');
const axios = require('axios');

console.log('🧪 Testing Complete eSewa Flow\n');

const HARDCODED_SECRET = 'KisanNet@ESEWA2025AUTH';
const BASE_URL = 'http://localhost:3200';

// Test 1: Generate token with hardcoded secret
console.log('1. Generating test token...');
const testToken = jwt.sign(
  { esewaConfigId: 1, type: 'access', iat: Math.floor(Date.now() / 1000) },
  HARDCODED_SECRET,
  { expiresIn: 250 }
);

console.log(`   Token: ${testToken.substring(0, 50)}...`);

// Test 2: Verify with hardcoded secret
console.log('\n2. Verifying test token...');
try {
  const verified = jwt.verify(testToken, HARDCODED_SECRET);
  console.log('✅ Token verified successfully!');
  console.log('   Decoded:', verified);
} catch (error) {
  console.log('❌ Verification failed:', error.message);
}

// Test 3: Test API endpoints
async function testAPI() {
  console.log('\n3. Testing API endpoints...');
  
  // First, get access token from your API
  try {
    console.log('   Getting access token from /esewa/access-token...');
    const response = await axios.post(`${BASE_URL}/esewa/access-token`, {
      grant_type: 'password',
      client_secret: process.env.ESEWA_CLIENT_SECRET || ('YWQ3MWMzZWE3OTdhYWFhMTgwNjdjYzg4Yzg0YjAyNzNmNDBjNDNmYmY2ZmNjYmM4' + 'NjIyY2ZkMzk1NDYzN2I2OWIzMmJlOWMxMzY4YmM3OTY3YWUxMTllYzQzZWVhNTgx'),
      username: 'esewa_isp_1',
      password: process.env.ESEWA_CLIENT_PASSWORD || ('NWU4MzRjZDYwMjUzOGE5NzliNmNi' + 'OTQ0YTdhZTQ3MzA=')
    });
    
    const accessToken = response.data.access_token;
    console.log(`   ✅ Got access token: ${accessToken.substring(0, 30)}...`);
    
    // Test inquiry endpoint with the NEW token
    console.log('\n4. Testing inquiry endpoint...');
    const inquiryResponse = await axios.get(`${BASE_URL}/esewa/inquiry/TESTTOKEN123`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    
    console.log('   Inquiry response:', inquiryResponse.data);
    
  } catch (error) {
    console.error('❌ API Test failed:', error.response?.data || error.message);
  }
}

// Uncomment to test API (make sure server is running)
// testAPI();

console.log('\n🔧 Quick Debug Info:');
console.log('   Hardcoded secret:', HARDCODED_SECRET);
console.log('   Secret length:', HARDCODED_SECRET.length);
console.log('   Base URL:', BASE_URL);

console.log('\n🚀 Steps to fix:');
console.log('1. Run: node scripts/clear-all-tokens.js');
console.log('2. Restart server');
console.log('3. Get NEW access token from /esewa/access-token');
console.log('4. Use that NEW token immediately (expires in 250 seconds)');