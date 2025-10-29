// google_email_scraper.js
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import fetchPkg from 'node-fetch';
// NopeCHA SDK (official client)
import * as NopechaPkg from 'nopecha';
import { solveRecaptchaIfPresent } from './solver.js';

// Resolve project root
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// Load env
dotenv.config({ path: path.join(ROOT_DIR, '.env') });

// Config
const INPUT_FILE = path.join(ROOT_DIR, 'src', 'input.csv');
const OUTPUT_FILE = path.join(ROOT_DIR, 'output.csv');
const HEADLESS = process.env.HEADLESS === 'true';
function toInt(v, def) { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : def; }
const BROWSERS = toInt(process.env.BROWSERS);
const TABS_PER_BROWSER = toInt(process.env.TABS_PER_BROWSER);
const CONCURRENCY = toInt(process.env.CONCURRENCY, BROWSERS * TABS_PER_BROWSER);
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_TABLE = process.env.SUPABASE_TABLE || 'email_table';
// Prefer official env name per docs
const NOPECHA_API_KEY = process.env.NOPECHA_KEY || process.env.NOPECHA_API_KEY || '';
const NOPECHA_EXTENSION_PATH = process.env.NOPECHA_EXTENSION_PATH || '';
const NOPECHA_USE_TOKEN = String(process.env.NOPECHA_USE_TOKEN || 'false').toLowerCase() === 'true';

// node-fetch compatibility: prefer global fetch if available (Node 18+), fall back
const fetch = (typeof globalThis.fetch === 'function') ? globalThis.fetch : (fetchPkg && fetchPkg.default ? fetchPkg.default : fetchPkg);

// Initialize NopeCHA SDK (best-effort per official docs)
let nopecha = null; // REST client via SDK for account status/balance
let NopechaHelper = null; // any helper methods exposed by package versions
try {
  const { Configuration, NopeCHAApi } = NopechaPkg?.default || NopechaPkg || {};
  if (NOPECHA_API_KEY && Configuration && NopeCHAApi) {
    const configuration = new Configuration({ apiKey: NOPECHA_API_KEY });
    nopecha = new NopeCHAApi(configuration);
  }
  NopechaHelper = (NopechaPkg && (NopechaPkg.default || NopechaPkg)) || null;
  try {
    if (NopechaHelper && typeof NopechaHelper.setApiKey === 'function' && NOPECHA_API_KEY) {
      NopechaHelper.setApiKey(NOPECHA_API_KEY);
    }
  } catch { }
} catch (err) {
  console.warn('⚠️ Could not init NopeCHA SDK:', err?.message || err);
}

// Verify NopeCHA key/balance using official client, fallback to REST status
async function verifyNopechaStatus() {
  if (!NOPECHA_API_KEY) {
    console.error('NOPECHA_KEY not set in .env');
    return { ok: false };
  }
  // Warn if key looks like a Stripe sub id
  // if (/^sub_/i.test(NOPECHA_API_KEY)) {
  //   console.warn(' The value in NOPECHA_KEY looks like a Stripe subscription id (sub_...). You must use the NopeCHA API key from the NopeCHA dashboard.');
  // }
  try {
    if (nopecha && typeof nopecha.getBalance === 'function') {
      const balance = await nopecha.getBalance();
      // to check the structure of balance 
      console.log('NopeCHA balance:', balance);
      return { ok: true, balance };
    }
  } catch (e) {
    console.warn(' NopeCHA SDK getBalance failed, will try REST /status:', e?.message || e);
  }
  // Fallback to REST status endpoint per docs
  try {
    const url = `https://api.nopecha.com/status?key=${encodeURIComponent(NOPECHA_API_KEY)}`;
    const res = await fetch(url, { method: 'GET' });
    const txt = await res.text().catch(() => '');
    let data = {};
    try { data = JSON.parse(txt || '{}'); } catch { }
    if (!res.ok) {
      console.warn(' NopeCHA /status error:', res.status, txt.slice(0, 200));
      return { ok: false, status: data };
    }
    console.log('NopeCHA status:', data);
    return { ok: true, status: data };
  } catch (e) {
    console.warn('NopeCHA /status request failed:', e?.message || e);
    return { ok: false };
  }
}

// Supabase client (only if both url + key present)
const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// Email regex
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Ensure CSV header
try {
  if (!fs.existsSync(OUTPUT_FILE)) {
    fs.writeFileSync(OUTPUT_FILE, 'email,query,timestamp\n', 'utf-8');
  } else {
    const firstLine = fs.readFileSync(OUTPUT_FILE, 'utf-8').split(/\r?\n/)[0] || '';
    if (firstLine.trim() !== 'email,query,timestamp') {
      const backup = OUTPUT_FILE.replace(/\.csv$/i, `.backup-${Date.now()}.csv`);
      fs.copyFileSync(OUTPUT_FILE, backup);
      fs.writeFileSync(OUTPUT_FILE, 'email,query,timestamp\n', 'utf-8');
      console.log(`ℹ️ Existing output had old header. Backed up to ${backup}`);
    }
  }
} catch (err) {
  console.error('🚨 Could not initialize output CSV header:', err?.message || err);
  process.exit(1);
}

// CSV helpers
function escapeCsv(v = '') {
  const s = String(v ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function appendToCSV(rows) {
  if (!rows || rows.length === 0) return;
  const content = rows.map(r => `${escapeCsv(r.email)},${escapeCsv(r.query)},${escapeCsv(r.timestamp)}`).join('\n') + '\n';
  try {
    fs.appendFileSync(OUTPUT_FILE, content, 'utf-8');
  } catch (err) {
    console.error('🚨 Failed to append to CSV:', err?.message || err);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Read queries from CSV - robust with header name fallback
// function readCSV(filePath) {
//   return new Promise((resolve, reject) => {
//     const results = [];
//     if (!fs.existsSync(filePath)) return resolve([]);
//     fs.createReadStream(filePath)
//       .pipe(csv())
//       .on('data', (data) => {
//         const q = data.query ?? data.q ?? data['search'] ?? '';
//         if (q && String(q).trim()) results.push(String(q).trim());
//       })
//       .on('end', () => resolve(results))
//       .on('error', reject);
//   });
// }

// ✅ Safe, header-tolerant CSV reader
function readCSV(filePath) {
  return new Promise((resolve) => {
    try {
      if (!fs.existsSync(filePath)) return resolve([]);

      const text = fs.readFileSync(filePath, 'utf8');
      const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

      // detect and skip header
      if (lines.length && /^(query|q|search)/i.test(lines[0])) {
        lines.shift();
      }

      const results = lines.map(line => {
        // remove extra commas or quotes
        return line.replace(/^["']|["']$/g, '').trim();
      });

      resolve(results);
    } catch (err) {
      console.error('❌ Error reading CSV:', err.message);
      resolve([]);
    }
  });
}


// Supabase insert (safe)
async function saveToSupabase(rows) {
  if (!supabase || !rows || rows.length === 0) return;
  try {
    const inserts = rows.map(r => ({ created_at: r.timestamp, email: r.email }));
    const { error } = await supabase.from(SUPABASE_TABLE).insert(inserts);
    if (error) console.error('❌ Supabase insert error:', error.message || error);
    else console.log(`📦 Inserted ${inserts.length} rows to Supabase (${SUPABASE_TABLE})`);
  } catch (err) {
    console.error('🚨 Supabase save failed:', err?.message || err);
  }
}

// Email extraction
async function extractEmailsFromPage(page) {
  try {
    const text = await page.evaluate(() => document.body ? document.body.innerText : '');
    return (text.match(EMAIL_REGEX) || [])
      .map(e => e.toLowerCase())
      .filter(e => !/(example\.com|example\.org|example\.net|noreply@|no-reply@)/.test(e));
  } catch (err) {
    console.warn('⚠️ extractEmailsFromPage failed:', err?.message || err);
    return [];
  }
}

// Google consent acceptance
async function tryAcceptConsent(page) {
  const locators = ['#L2AGLb', 'button[aria-label*="Agree" i]', 'button:has-text("I agree")', 'button:has-text("Accept all")'];
  for (const sel of locators) {
    try {
      const el = await page.$(sel);
      if (el) {
        try {
          await el.click();
        } catch (e) {
          try { await page.click(sel); } catch { }
        }
        await page.waitForTimeout(1000);
        if (!/consent/i.test(page.url())) return true;
      }
    } catch (err) { /* ignore */ }
  }
  return false;
}

// Solve reCAPTCHA v2 token via NopeCHA Basic plan
async function solveRecaptchaToken({ siteKey, pageUrl, maxRetries = 5 }) {
  if (!NOPECHA_API_KEY) {
    console.warn('⚠️ NOPECHA_API_KEY not set; cannot solve captcha via NopeCHA.');
    return null;
  }

  // Only recaptcha2 is supported in Basic plan
  const type = 'recaptcha2';
  console.log(`🧩 Requesting NopeCHA token for sitekey=${siteKey}, type=${type}`);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Submit challenge to NopeCHA
      const body = { key: NOPECHA_API_KEY, type, sitekey: siteKey, url: pageUrl };
      const res = await fetch('https://api.nopecha.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json().catch(() => ({}));

      if (data?.token) {
        console.log(`✅ NopeCHA token received (attempt ${attempt}): ${String(data.token).slice(0, 12)}...`);
        return data.token;
      }

      const id = data?.id || data?.task || data?.data;
      console.log(`ℹ️ NopeCHA task id (attempt ${attempt}): ${id}`);
      if (!id) {
        console.warn(`⚠️ NopeCHA returned no task id (attempt ${attempt}). Retrying...`);
        await sleep(1500);
        continue;
      }

      // Poll for solution
      for (let i = 0; i < 20; i++) {
        await sleep(1500);
        try {
          const poll = await fetch(`https://api.nopecha.com?key=${encodeURIComponent(NOPECHA_API_KEY)}&id=${encodeURIComponent(id)}`);
          const pollData = await poll.json().catch(() => ({}));
          if (pollData?.token) return pollData.token;
          if (pollData?.solution) return pollData.solution;
          if (pollData?.data && typeof pollData.data === 'string') return pollData.data;
        } catch { }
      }

      // quiet retry
      await sleep(1500);
    } catch (err) {
      // quiet retry
      await sleep(1500);
    }
  }

  // give up
  return null;
}



// Poll GET https://api.nopecha.com?key=...&id=... until solved or timeout
async function pollNopechaResult(id, timeoutMs = 45_000, interval = 1500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const url = `https://api.nopecha.com?key=${encodeURIComponent(NOPECHA_API_KEY)}&id=${encodeURIComponent(id)}`;
      const res = await fetch(url, { method: 'GET' });
      const txt = await res.text().catch(() => '');
      if (!res.ok) {
        // if rate-limited, backoff
        if (res.status === 429) await sleep(1000);
      } else {
        let data = {};
        try { data = JSON.parse(txt || '{}'); } catch (e) { data = {}; }
        // Many endpoints return { token: '...' } or { data: 'id' } or something similar
        if (data?.token) return data.token;
        if (data?.solution) return data.solution;
        // For recognition endpoints, result could come back as data (string)
        if (data?.data && typeof data.data === 'string' && data.data.length > 0) return data.data;
      }
    } catch (err) {
      // ignore and continue
    }
    await sleep(interval);
  }
  console.warn('⚠️ pollNopechaResult: timed out waiting for solution');
  return null;
}

// Pagination - improved selector handling & small waits
async function goToNextPage(page) {
  const selectors = ['a#pnnext', 'a#pnnext span.oeN89d', 'a[aria-label="Next page"]', 'a[aria-label="Next"]'];
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.scrollIntoViewIfNeeded();
        await page.waitForTimeout(500 + Math.random() * 500);
        try { await el.click({ delay: 50 + Math.random() * 150 }); } catch { try { await page.click(sel); } catch { } }
        try { await page.waitForSelector('div#search', { timeout: 15000 }); } catch { }
        await page.waitForTimeout(1000 + Math.random() * 1000);
        return true;
      }
    } catch (err) {
      // ignore and try next selector
    }
  }
  return false;
}

// Improved maybeHandleCaptcha: returns { present: bool, solved: bool }
async function maybeHandleCaptcha(page) {
  try {
    const url = page.url();

    // quick consent accept
    if (/consent/i.test(url)) {
      const accepted = await tryAcceptConsent(page);
      if (accepted) return { present: true, solved: true };
    }

    // detect common captcha indicators
    if (/recaptcha|challenge|sorry/i.test(url) || await page.$('div.g-recaptcha') || await page.$('iframe[src*="recaptcha"]')) {
      // We mark as present
      // First attempt frame-based solver (does not require sitekey)
      try {
        const solvedSolverEarly = await solveRecaptchaIfPresent(page);
        if (solvedSolverEarly) {
          // If we're on a Google sorry page with a continue param, follow it
          try {
            const cont = extractContinueUrl(url);
            if (cont) {
              await page.goto(cont, { waitUntil: 'domcontentloaded' }).catch(() => { });
              await page.waitForTimeout(600);
            }
          } catch { }
          return { present: true, solved: true };
        }
      } catch { }

      let sitekey = null;
      try {
        sitekey = await page.evaluate(() => {
          const els = [
            ...Array.from(document.querySelectorAll('[data-sitekey]')),
            ...Array.from(document.querySelectorAll('.g-recaptcha'))
          ];
          for (const el of els) {
            const v = el.getAttribute('data-sitekey') || (el.dataset && el.dataset.sitekey);
            if (v) return v;
          }
          return null;
        });
      } catch { }

      // check frames and scripts for sitekey param (v2/v3)
      if (!sitekey) {
        try {
          for (const frame of page.frames()) {
            const fu = frame.url();
            if (/recaptcha|google\.com\/recaptcha|anchor/i.test(String(fu))) {
              try {
                const u = new URL(fu);
                const k = u.searchParams.get('k') || u.searchParams.get('sitekey') || u.searchParams.get('render');
                if (k) { sitekey = k; break; }
              } catch { }
            }
          }
          // scan script tags for api.js?render=<sitekey> (v3 pattern)
          if (!sitekey) {
            sitekey = await page.evaluate(() => {
              const scripts = Array.from(document.querySelectorAll('script[src*="recaptcha/api.js"],script[src*="grecaptcha"]'));
              for (const s of scripts) {
                try {
                  const u = new URL(s.src, document.baseURI);
                  const r = u.searchParams.get('render');
                  if (r && r !== 'explicit') return r;
                } catch { }
              }
              return null;
            });
          }
        } catch { }
      }

      // If extension path provided, give extension a small chance to act (best-effort)
      if (!sitekey && NOPECHA_EXTENSION_PATH && fs.existsSync(NOPECHA_EXTENSION_PATH)) {
        console.log('🧩 CAPTCHA detected. NopeCHA extension path provided — giving extension a short moment to act.');
        await page.waitForTimeout(4000);
        // we can't detect success reliably, so mark as present but not solved
        return { present: true, solved: false };
      }

      if (!sitekey) {
        // Try to escape the sorry page by following the continue param if present
        try {
          const cont = extractContinueUrl(url);
          if (cont) {
            await page.goto(cont, { waitUntil: 'domcontentloaded' }).catch(() => { });
            await page.waitForTimeout(600);
            return { present: true, solved: true };
          }
        } catch { }
        console.warn('⚠️ CAPTCHA detected but no sitekey found; skipping automated token solve.');
        return { present: true, solved: false };
      }

      // Try solver module first (frame-based challenge solving via NopeCHA recognition)
      try {
        const solvedSolver = await /* The above code is a comment block in JavaScript. It mentions a
        function `solveRecaptchaIfPresent(page)` which is likely intended
        to solve a reCAPTCHA challenge if it is present on the page.
        However, the actual implementation of the
        `solveRecaptchaIfPresent` function is not provided in the code
        snippet. */
        solveRecaptchaIfPresent(page);
        if (solvedSolver) {
          return { present: true, solved: true };
        }
      } catch (e) {
        // ignore and continue to token flow
      }

      // Try helper-first if available (NopechaHelper might inject into browser)
      try {
        if (NopechaHelper && typeof NopechaHelper.solveRecaptchaV2 === 'function') {
          await NopechaHelper.solveRecaptchaV2(page);
          // assume solved if no exception thrown
          return { present: true, solved: true };
        }
      } catch (err) {
        // fall through to token flow
      }

      // Determine type hint: if v3 patterns detected, prefer recaptcha3
      let typeHint = null;
      try {
        const hasExec = await page.evaluate(() => {
          try { return typeof window.grecaptcha !== 'undefined'; } catch { return false; }
        });
        // If there is a render param and no visible widget, lean v3
        if (hasExec && !(await page.$('.g-recaptcha'))) typeHint = 'recaptcha3';
      } catch { }

      // Try token acquisition via API (opt-in only)
      if (NOPECHA_USE_TOKEN) {
        try {
          const token = await solveRecaptchaToken({ siteKey: sitekey, pageUrl: url, typeHint });
          if (token) {
            console.log(`✅ reCAPTCHA token received (prefix): ${String(token).slice(0, 12)}...`);
            // Inject token into typical fields and attempt form submit
            await page.evaluate(tok => {
              const ta = document.querySelector('textarea#g-recaptcha-response');
              if (ta) { ta.value = tok; ta.dispatchEvent(new Event('change', { bubbles: true })); }
              try { window.__grecaptcha_token = tok; } catch (e) { }
            }, token);
            await page.waitForTimeout(600);

            // attempt to submit forms or reload search results
            try {
              const form = await page.$('form');
              if (form) {
                await form.evaluate(f => f.submit());
              } else {
                const cont = extractContinueUrl(url);
                if (cont) {
                  await page.goto(cont, { waitUntil: 'domcontentloaded' }).catch(() => { });
                } else {
                  const qMatch = url.match(/[?&]q=([^&]+)/);
                  const q = qMatch ? decodeURIComponent(qMatch[1]) : '';
                  if (q) {
                    await page.goto(`https://www.google.com/search?q=${encodeURIComponent(q)}&num=10&hl=en`, { waitUntil: 'domcontentloaded' }).catch(() => { });
                  } else {
                    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => { });
                  }
                }
              }
              await page.waitForLoadState('domcontentloaded');
            } catch (err) { /* ignore */ }

            return { present: true, solved: true };
          } else {
            return { present: true, solved: false };
          }
        } catch (err) {
          // token flow failed
          return { present: true, solved: false };
        }
      } else {
        // Token flow disabled; try to continue if possible
        const cont = extractContinueUrl(url);
        if (cont) {
          await page.goto(cont, { waitUntil: 'domcontentloaded' }).catch(() => { });
          await page.waitForTimeout(500);
          return { present: true, solved: true };
        }
        return { present: true, solved: false };
      }
    }
  } catch (err) {
    console.warn('⚠️ maybeHandleCaptcha failed:', err?.message || err);
    return { present: false, solved: false };
  }
  return { present: false, solved: false };
}

// Extract and decode the continue= parameter from Google's Sorry URL, if present
function extractContinueUrl(u) {
  try {
    const url = new URL(u);
    const cont = url.searchParams.get('continue');
    if (!cont) return null;
    return decodeURIComponent(cont);
  } catch {
    return null;
  }
}



async function runQueryInTab(page, query) {
  console.log(`🔍 [Tab] Searching Google for: ${query}`);
  const collected = new Set();
  let pageNum = 1, consecutiveCaptcha = 0;

  try {
    await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}&num=10&hl=en`, { waitUntil: 'domcontentloaded', timeout: 30000 });

    while (true) {
      console.log(`📄 [${query}] Page ${pageNum}...`);
      const { present, solved } = await maybeHandleCaptcha(page);
      if (present && !solved) {
        consecutiveCaptcha++;
        if (consecutiveCaptcha >= 3) break;
      } else {
        consecutiveCaptcha = 0;
      }

      const emails = await extractEmailsFromPage(page);
      const newEmails = emails.filter(e => !collected.has(e));
      newEmails.forEach(e => collected.add(e));

      if (newEmails.length) {
        const rows = newEmails.map(e => ({ email: e, query, timestamp: new Date().toISOString() }));
        appendToCSV(rows);
        await saveToSupabase(rows).catch(() => { });
        console.log(`✅ [${query}] ${newEmails.length} new emails`);
      }

      const hasNext = await goToNextPage(page);
      if (!hasNext) break;
      pageNum++;
      await sleep(1500 + Math.random() * 1500);
    }
  } catch (err) {
    console.error(`🚨 [${query}] runQueryInTab failed:`, err?.message || err);
  } finally {
    console.log(`🎯 [${query}] done (${collected.size} unique emails)`);
  }
}


// Entry
(async () => {
  try {
    // Check NopeCHA key and balance per official docs
    await verifyNopechaStatus();

    const queries = await readCSV(INPUT_FILE);
    if (!queries || queries.length === 0) {
      console.error('No queries found in input CSV:', INPUT_FILE);
      process.exit(1);
    }

    if (supabase) {
      console.log('🔌 Testing Supabase connection...');
      try {
        const { error } = await supabase.from(SUPABASE_TABLE).select('*').limit(1);
        if (error) console.error('❌ Supabase connection failed:', error.message || error);
        else console.log('✅ Supabase connected successfully!');
      } catch (err) {
        console.error('❌ Supabase connection test error:', err?.message || err);
      }
    }


    //* You open 10 browsers, and each browser opens 10 tabs concurrently → that means 100 total parallel tabs working at once.

    // Parallel execution: multiple browsers, each with multiple tabs
    console.log(`🚀 Launching ${BROWSERS} browsers × ${TABS_PER_BROWSER} tabs = ${BROWSERS * TABS_PER_BROWSER} total.`);

    let queryIndex = 0;

    const browserWorkers = Array.from({ length: BROWSERS }, async (_, browserId) => {
      const browser = await chromium.launch({ headless: HEADLESS });
      const context = await browser.newContext({
        viewport: { width: 1366, height: 820 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      });

      try {
        while (queryIndex < queries.length) {
          // Assign next batch of queries to this browser
          const batch = queries.slice(queryIndex, queryIndex + TABS_PER_BROWSER);
          queryIndex += TABS_PER_BROWSER;
          if (batch.length === 0) break;

          console.log(`🧩 [Browser ${browserId + 1}] Running ${batch.length} tabs...`);

          const pages = await Promise.all(batch.map(() => context.newPage()));

          // Run all tabs concurrently
          await Promise.allSettled(batch.map((q, i) => runQueryInTab(pages[i], q)));

          // Close tabs after completion
          await Promise.allSettled(pages.map(p => p.close().catch(() => { })));

          // Small stagger delay between batches
          await sleep(1000 + Math.random() * 2000);
        }
      } catch (err) {
        console.error(`🚨 [Browser ${browserId + 1}] Error:`, err?.message || err);
      } finally {
        console.log(`🧹 [Browser ${browserId + 1}] Closing...`);
        await context.close().catch(() => { });
        await browser.close().catch(() => { });
      }
    });

    // Wait for all browsers to finish
    await Promise.all(browserWorkers);

    console.log('🏁 All queries completed. Output written to', OUTPUT_FILE);

  } catch (err) {
    console.error('🚨 Fatal error:', err?.message || err);
    process.exit(1);
  }
})();
