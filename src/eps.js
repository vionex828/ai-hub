const crypto = require('crypto');
const { config } = require('./config');

// EPS signs every request with x-hash = base64( HMAC-SHA512(key = hash key, data) ).
const xhash = data => crypto.createHmac('sha512', config.EPS.hashKey).update(String(data), 'utf8').digest('base64');

async function call(method, path, { hashOf, token, body } = {}) {
  const res = await fetch(config.EPS.base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-hash': xhash(hashOf),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok || !data) throw new Error(`EPS ${path} failed (${res.status}): ${text.slice(0, 200)}`);
  return data;
}

async function getToken() {
  const d = await call('POST', '/v1/Auth/GetToken', {
    hashOf: config.EPS.username,
    body: { userName: config.EPS.username, password: config.EPS.password },
  });
  if (!d.token) throw new Error('EPS did not return a token: ' + (d.errorMessage || d.ErrorMessage || JSON.stringify(d).slice(0, 200)));
  return d.token;
}

// Returns the EPS payment page URL for the customer.
async function initPayment({ mtid, orderId, amount, phone, productName, successUrl, failUrl, cancelUrl, ip }) {
  const token = await getToken();
  const host = new URL(config.BASE_URL).hostname;
  const body = {
    merchantId: config.EPS.merchantId,
    storeId: config.EPS.storeId,
    CustomerOrderId: orderId,
    merchantTransactionId: mtid,
    transactionTypeId: 1,
    totalAmount: amount,
    successUrl,
    failUrl,
    cancelUrl,
    customerName: 'Customer ' + phone.slice(-4),
    customerEmail: config.EPS.customerEmail || `customer@${host}`,
    customerAddress: 'Dhaka',
    customerCity: 'Dhaka',
    customerState: 'Dhaka',
    customerPostcode: '1000',
    customerCountry: 'BD',
    customerPhone: '0' + phone,
    productName,
    productProfile: 'digital-goods',
    productCategory: 'AI tokens',
    noOfItem: '1',
    ipAddress: ip || '',
    version: '1',
    valueA: mtid,
    ProductList: [{ ProductName: productName, NoOfItem: '1', ProductProfile: 'digital-goods', ProductCategory: 'AI tokens', ProductPrice: String(amount) }],
  };
  const d = await call('POST', '/v1/EPSEngine/InitializeEPS', { hashOf: mtid, token, body });
  if (!d.RedirectURL) throw new Error('EPS init failed: ' + (d.ErrorMessage || JSON.stringify(d).slice(0, 200)));
  return d.RedirectURL;
}

// The only trusted source for "was this paid?". Status is "Success" when paid.
async function checkStatus(mtid) {
  const token = await getToken();
  return call('GET', `/v1/EPSEngine/CheckMerchantTransactionStatus?merchantTransactionId=${encodeURIComponent(mtid)}`, { hashOf: mtid, token });
}

module.exports = { initPayment, checkStatus, xhash };
