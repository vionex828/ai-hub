# AI Hub

All-in-one AI chat for Bangladesh: ChatGPT, Claude, Gemini, Grok and DeepSeek in one account, token plans paid with EPS, login with a Bangladeshi mobile number.

Node.js 20+, Express, PostgreSQL. Runs as one Railway service.

## Deploy on Railway

1. Push this folder to a **private** GitHub repo.
2. Railway → New Project → Deploy from GitHub repo.
3. In the same project: **+ New → Database → PostgreSQL**.
4. Open the app service → **Variables** and add everything from `.env.example`.
   For `DATABASE_URL` use the reference `${{Postgres.DATABASE_URL}}`.
5. Service → Settings → Networking → **Generate domain** (or add your own domain) and put that address in `BASE_URL`.
6. Deploy. The database tables and default models/plans are created on first start.
7. Open `/admin`, log in with `ADMIN_PASSWORD`, go to **Models → Check IDs and prices on OpenRouter** and fix any model marked "Not found".

## Before going live

- [ ] EPS: give EPS your live domain and this IPN URL: `https://YOUR-DOMAIN/api/eps/ipn`
- [ ] Buy a Mini plan yourself with real money and check the tokens arrive
- [ ] `OTP_DEBUG` is not set
- [ ] Edit `public/terms.html`, `public/privacy.html`, `public/refund.html` (replace every [bracketed] part)
- [ ] Set a spending limit on your OpenRouter key
- [ ] Optional: Telegram alerts (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`)

## How the money side works

- Each message reserves the maximum it could cost, then refunds the difference once OpenRouter reports the real token count. Balances never go negative, even with several tabs open.
- Charge = (prompt tokens + reply tokens) × the model's token rate (1× everyday, 6× premium, set in admin).
- A failed model reply with no text costs nothing. A stopped reply costs only what was written.
- Payments are credited only after the server asks EPS directly (`CheckMerchantTransactionStatus`) and the paid amount matches. The IPN and the return page only trigger that check, so a fake request can't add tokens.
- Pending payments are re-checked every 2 minutes for 3 hours, in case the customer closes the tab before coming back.
- New plan: remaining tokens carry over, validity restarts. Top-up: needs an active plan, lasts until the plan ends.
- When a plan expires, the remaining tokens are cleared.

## Pages

| Path | What |
|---|---|
| `/` | Customer app (login, chat, plans, usage) |
| `/admin` | Owner panel: sales, OpenRouter credit, models, plans & profit, customers, payments, settings |
| `/terms`, `/privacy`, `/refund` | Legal pages (drafts, edit before launch) |
| `/api/health` | Health check |

## Model logos

Each model shows a colored letter by default. To use official logos, download them from each company's brand/press page (follow their usage rules), put the files in `public/logos/`, and set the Logo URL in admin (for example `/logos/claude.svg`).

## Files

```
server.js            app start, security headers, routes
src/config.js        reads Railway variables
src/db.js            tables, defaults, expiry
src/auth.js          OTP login, sessions, admin login
src/chat.js          streaming chat, compare, token charging
src/billing.js       plans, EPS checkout, payment checks, usage
src/admin.js         admin API, OpenRouter credit alert
src/eps.js           EPS API (GetToken, InitializeEPS, CheckMerchantTransactionStatus)
src/openrouter.js    OpenRouter streaming, models, credit
src/sms.js           BulkSMSBD
src/telegram.js      optional owner alerts
public/              customer app + admin panel
```
