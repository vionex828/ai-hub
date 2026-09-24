const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { config, checkConfig } = require('./src/config');
const db = require('./src/db');
const auth = require('./src/auth');
const chat = require('./src/chat');
const billing = require('./src/billing');
const admin = require('./src/admin');

const { errors, warnings } = checkConfig();
warnings.forEach(w => console.warn('[config] ' + w));
if (errors.length) {
  errors.forEach(e => console.error('[config] ' + e));
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: https:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join('; '),
  });
  next();
});

app.use(cookieParser());

// EPS IPN reads its own raw body, so it is mounted before the JSON parser.
app.post('/api/eps/ipn', billing.router);

app.use(express.json({ limit: '200kb' }));

// Blocks cross-site form posts: API writes must be JSON.
app.use('/api', (req, res, next) => {
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
    if (req.method !== 'DELETE' && !req.is('application/json')) return res.status(415).json({ error: 'json_only' });
  }
  next();
});

app.use(auth.loadUser);
app.use(auth.router);
app.use(chat.router);
app.use(billing.router);
app.use(admin.router);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Front end
app.use('/vendor', express.static(path.join(__dirname, 'node_modules/marked/lib'), { maxAge: '7d' }));
app.use('/vendor', express.static(path.join(__dirname, 'node_modules/dompurify/dist'), { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '5m' }));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public/admin.html')));
app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

// Errors
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status && err.status < 500 ? err.status : 500;
  if (status === 500) console.error('[error]', req.method, req.path, err);
  if (res.headersSent) return res.end();
  res.status(status).json({ error: status === 500 ? 'server_error' : 'bad_request', message: status === 500 ? 'Something went wrong. Please try again.' : err.message });
});

(async () => {
  try {
    await db.init();
  } catch (e) {
    console.error('[db] could not start:', e.message);
    process.exit(1);
  }
  billing.startPaymentPoller();
  admin.startCreditWatch();
  setInterval(() => {
    db.q("DELETE FROM sessions WHERE expires_at < now(); DELETE FROM otps WHERE created_at < now() - interval '1 day';").catch(() => {});
  }, 6 * 3600e3).unref();
  app.listen(config.PORT, () => console.log(`${config.BRAND} running on port ${config.PORT}`));
})();
