# Google Email Scraper

This project searches Google for queries from `src/input.csv`, extracts emails using regex while paginating through search results, stores them in Supabase (optional), and appends results to `output.csv` (project root). It supports high concurrency (windows × tabs) and optional NopeCHA CAPTCHA solving via API or extension.

Warning: Automated scraping of Google may violate Google's Terms of Service. Use responsibly, for educational purposes, and at your own risk.

## Prerequisites
- Node.js 18+
- Playwright browsers installed
- (Optional) Supabase project with a table to store emails

## Setup

1. Install dependencies:

```powershell
npm install
npm run playwright:install
```

2. Configure environment:
- Copy `.env.example` to `.env` and fill in values.
- Set `HEADLESS=true` to run without the browser UI.
- Optionally set high concurrency:
  - `BROWSERS` (windows), `TABS_PER_BROWSER` (tabs per window). Example: 10 × 100.
- Provide `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE` (preferred) or `SUPABASE_KEY`/`SUPABASE_ANON_KEY`.
- Optional: set `NOPECHA_KEY` (official) or `NOPECHA_API_KEY` to enable NopeCHA automatic CAPTCHA solving via API.
- Optional: set `NOPECHA_EXTENSION_PATH` to load the NopeCHA browser extension (Chromium only; requires headless=false and extension path).

3. Prepare CSV input:
- Edit `src/input.csv` with a header `query` and one query per row.

Example:
```
query
Air Duct Cleaning in [New York] inurl:/contact" "com" -india -91 -gov -.pk -press -news
```

## Supabase Table
Create a table (default name `email_table`) with your chosen columns:

```sql
create table if not exists public.email_table (
  created_at timestamptz not null default now(),
  email text null
);
```

Default `SUPABASE_TABLE` is `email_table`. If using a different table name, set `SUPABASE_TABLE` in `.env`.

## Run

- Start the scraper:

```powershell
npm run start
```

- Dev mode with auto-reload:

```powershell
npm run dev
```

Results append to `output.csv` with columns: `email,query,timestamp`.
CAPTCHA handling tries consent auto-accept, then NopeCHA API token solving; if unavailable, it proceeds without waiting.

### NopeCHA quick check (official client)

On start, the scraper will call NopeCHA's official client to print your balance. Make sure `.env` contains a valid `NOPECHA_KEY` from the NopeCHA dashboard. If you see a value starting with `sub_...`, that's a Stripe subscription id and won't work as an API key.

If you want to verify your key manually with a one-off Node snippet:

```js
import { Configuration, NopeCHAApi } from 'nopecha';
const nopecha = new NopeCHAApi(new Configuration({ apiKey: process.env.NOPECHA_KEY }));
const balance = await nopecha.getBalance();
console.log(balance);
```

## Notes
- The scraper uses several selectors to find the “Next” button (e.g., `a#pnnext`, `a[aria-label="Next page"]`).
- Basic CAPTCHA/consent detection attempts to accept consent banners. If NopeCHA is configured, it requests a token via the official `/token` API and injects it automatically.
- Email extraction uses a simple regex and filters obvious false positives. Tweak in `src/main.js` if needed.
- Concurrency can increase throughput but also blocking risk; start low and increase gradually.
