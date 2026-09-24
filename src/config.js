// All settings come from environment variables (Railway → Variables).
// Never put real keys in this file or anywhere in the code.
const env = process.env;

const config = {
  PORT: Number(env.PORT || 8080),
  BASE_URL: (env.BASE_URL || '').replace(/\/+$/, ''),
  BRAND: env.BRAND_NAME || 'AI Hub',
  DATABASE_URL: env.DATABASE_URL || '',
  PGSSL: env.PGSSL === 'true',
  SESSION_DAYS: Number(env.SESSION_DAYS || 30),
  ADMIN_PASSWORD: env.ADMIN_PASSWORD || '',

  OPENROUTER_API_KEY: env.OPENROUTER_API_KEY || '',
  OPENROUTER_BASE: (env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),

  EPS: {
    base: (env.EPS_BASE_URL || (env.EPS_SANDBOX === 'true' ? 'https://sandboxpgapi.eps.com.bd' : 'https://pgapi.eps.com.bd')).replace(/\/+$/, ''),
    merchantId: env.EPS_MERCHANT_ID || '',
    storeId: env.EPS_STORE_ID || '',
    username: env.EPS_USERNAME || '',
    password: env.EPS_PASSWORD || '',
    hashKey: env.EPS_HASH_KEY || '',
    customerEmail: env.EPS_CUSTOMER_EMAIL || '',
  },

  SMS: {
    url: env.SMS_API_URL || 'https://bulksmsbd.net/api/smsapi',
    apiKey: env.SMS_API_KEY || '',
    senderId: env.SMS_SENDER_ID || '',
  },
  // Only for testing before SMS is set up. Shows the OTP on the login screen. Never leave on in production.
  OTP_DEBUG: env.OTP_DEBUG === 'true',

  TELEGRAM: { token: env.TELEGRAM_BOT_TOKEN || '', chatId: env.TELEGRAM_CHAT_ID || '' },
  LOW_CREDIT_USD: Number(env.LOW_CREDIT_USD || 10),
};

config.SECURE_COOKIES = config.BASE_URL.startsWith('https://');
config.epsReady = () => Boolean(config.EPS.merchantId && config.EPS.storeId && config.EPS.username && config.EPS.password && config.EPS.hashKey);
config.smsReady = () => Boolean(config.SMS.apiKey && config.SMS.senderId);

function checkConfig() {
  const errors = [];
  const warnings = [];
  if (!config.DATABASE_URL) errors.push('DATABASE_URL is missing (add a PostgreSQL database in Railway).');
  if (!config.BASE_URL) errors.push('BASE_URL is missing (your site address, e.g. https://ai.example.com).');
  if (!config.OPENROUTER_API_KEY) errors.push('OPENROUTER_API_KEY is missing.');
  if (config.ADMIN_PASSWORD.length < 12) errors.push('ADMIN_PASSWORD must be at least 12 characters.');
  if (!config.epsReady()) warnings.push('EPS variables are incomplete. Payments are turned off until they are set.');
  if (!config.smsReady() && !config.OTP_DEBUG) warnings.push('SMS variables are missing and OTP_DEBUG is off. Nobody can log in.');
  if (config.OTP_DEBUG) warnings.push('OTP_DEBUG is ON. Login codes are shown on screen. Turn it off before going live.');
  return { errors, warnings };
}

module.exports = { config, checkConfig };
