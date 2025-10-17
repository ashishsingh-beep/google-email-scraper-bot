// google_email_scraper.js
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import fetchPkg from 'node-fetch';
import * as NopechaPkg from 'nopecha';

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
const BROWSERS = Math.max(1, parseInt(process.env.BROWSERS || '1', 10));
const TABS_PER_BROWSER = Math.max(1, parseInt(process.env.TABS_PER_BROWSER || '1', 10));
const CONCURRENCY = Math.max(1, parseInt(process.env.CONCURRENCY || String(BROWSERS * TABS_PER_BROWSER || 3), 10));
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_TABLE = process.env.SUPABASE_TABLE || 'email_table';
const NOPECHA_API_KEY = process.env.NOPECHA_API_KEY || process.env.NOPECHA_KEY || '';
const NOPECHA_EXTENSION_PATH = process.env.NOPECHA_EXTENSION_PATH || '';

// node-fetch compatibility: prefer global fetch if available (Node 18+), fall back
const fetch = (typeof globalThis.fetch === 'function') ? globalThis.fetch : (fetchPkg && fetchPkg.default ? fetchPkg.default : fetchPkg);

// Initialize NopeCHA SDK (best-effort)
let nopecha = null;
let NopechaHelper = null;
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
  } catch {}
} catch (err) {
  console.warn('⚠️ Could not init NopeCHA SDK:', err?.message || err);
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
  const content = rows.map(r => `${escapeCsv(r.email)},${escapeCsv(r.timestamp)}`).join('\n') + '\n';
  try {
    fs.appendFileSync(OUTPUT_FILE, content, 'utf-8');
  } catch (err) {
    console.error('🚨 Failed to append to CSV:', err?.message || err);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Read queries from CSV - robust with header name fallback
function readCSV(filePath) {
  return new Promise((resolve, reject) => {
    const results = [];
    if (!fs.existsSync(filePath)) return resolve([]);
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (data) => {
        const q = data.query ?? data.q ?? data['search'] ?? '';
        if (q && String(q).trim()) results.push(String(q).trim());
      })
      .on('end', () => resolve(results))
      .on('error', reject);
  });
}

// Supabase insert (safe)
async function saveToSupabase(rows) {
  if (!supabase || !rows || rows.length === 0) return;
  try {
    const inserts = rows.map(r => ({ created_at: r.timestamp, email: r.email}));
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
  const locators = ['#L2AGLb','button[aria-label*="Agree" i]','button:has-text("I agree")','button:has-text("Accept all")'];
  for (const sel of locators) {
    try {
      const el = await page.$(sel);
      if (el) {
        try {
          await el.click();
        } catch (e) {
          try { await page.click(sel); } catch {}
        }
        await page.waitForTimeout(1000);
        if (!/consent/i.test(page.url())) return true;
      }
    } catch (err) { /* ignore */ }
  }
  return false;
}

// Solve reCAPTCHA token via NopeCHA using REST /token + GET poll
async function solveRecaptchaToken({ siteKey, pageUrl, typeHint }) {
  if (!NOPECHA_API_KEY) {
    console.warn('⚠️ NOPECHA_API_KEY not set; cannot solve captcha via NopeCHA.');
    return null;
  }
  // Sanity: warn if key shape looks like Stripe subscription
  if (/^sub_/i.test(NOPECHA_API_KEY)) {
    console.warn('⚠️ NOPECHA_API_KEY looks like a Stripe subscription ID (sub_...). Use your NopeCHA API key from their dashboard.');
  }

  // Try a sequence of types; prefer hint first if provided
  const types = [];
  if (typeHint) types.push(typeHint);
  // fallback order: reCAPTCHA v3, classic, enterprise
  for (const t of ['recaptcha3', 'recaptcha', 'recaptcha_enterprise']) {
    if (!types.includes(t)) types.push(t);
  }

  for (const t of types) {
    try {
      const body = { key: NOPECHA_API_KEY, type: t, sitekey: siteKey, url: pageUrl };
      // For v3, include an action. Use common default; providers often require it.
      if (t === 'recaptcha3') {
        body.data = { action: 'check' };
      }
      const res = await fetch('https://api.nopecha.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      const text = await res.text().catch(() => '');
      if (!res.ok) {
        console.warn(`⚠️ NopeCHA /token (${t}) returned ${res.status}: ${text.slice(0, 200)}`);
        // Try next type if invalid type
        if (res.status === 400 && /Invalid type/i.test(text)) continue;
        if (res.status === 429) await sleep(1000);
        continue;
      }
      let data = {};
      try { data = JSON.parse(text || '{}'); } catch {}

      if (data?.token) {
        console.log(`✅ NopeCHA token received (${t}) (prefix): ${String(data.token).slice(0, 12)}...`);
        return data.token;
      }
      const id = data?.id || data?.data || data?.task;
      if (id) {
        for (let i = 0; i < 20; i++) {
          await sleep(1500);
          try {
            const poll = await fetch(`https://api.nopecha.com?key=${encodeURIComponent(NOPECHA_API_KEY)}&id=${encodeURIComponent(id)}`);
            const pollText = await poll.text().catch(() => '');
            if (!poll.ok) {
              if (poll.status === 429) await sleep(1000);
              continue;
            }
            let pollData = {};
            try { pollData = JSON.parse(pollText || '{}'); } catch {}
            if (pollData?.token) return pollData.token;
            if (pollData?.solution) return pollData.solution;
            if (pollData?.data && typeof pollData.data === 'string') return pollData.data;
          } catch {}
        }
      }
    } catch (err) {
      console.warn(`⚠️ NopeCHA token request (${t}) failed:`, err?.message || err);
    }
  }

  console.warn('⚠️ No token returned from NopeCHA after trying all types.');
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
  const selectors = ['a#pnnext','a#pnnext span.oeN89d','a[aria-label="Next page"]','a[aria-label="Next"]'];
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.scrollIntoViewIfNeeded();
        await page.waitForTimeout(500 + Math.random()*500);
        try { await el.click({ delay: 50 + Math.random()*150 }); } catch { try { await page.click(sel); } catch {} }
        try { await page.waitForSelector('div#search', { timeout: 15000 }); } catch {}
        await page.waitForTimeout(1000 + Math.random()*1000);
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
  if (/recaptcha|challenge|sorry/i.test(url) || await page.$('div.g-recaptcha') || await page.$('iframe[src*="recaptcha"]') ) {
      // We mark as present
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
      } catch {}

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
              } catch {}
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
                } catch {}
              }
              return null;
            });
          }
        } catch {}
      }

      // If extension path provided, give extension a small chance to act (best-effort)
      if (!sitekey && NOPECHA_EXTENSION_PATH && fs.existsSync(NOPECHA_EXTENSION_PATH)) {
        console.log('🧩 CAPTCHA detected. NopeCHA extension path provided — giving extension a short moment to act.');
        await page.waitForTimeout(4000);
        // we can't detect success reliably, so mark as present but not solved
        return { present: true, solved: false };
      }

      if (!sitekey) {
        console.warn('⚠️ CAPTCHA detected but no sitekey found; skipping automated solve (present=true, solved=false).');
        return { present: true, solved: false };
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
      } catch {}

      // Try token acquisition via API
      try {
        const token = await solveRecaptchaToken({ siteKey: sitekey, pageUrl: url, typeHint });
        if (token) {
          console.log(`✅ reCAPTCHA token received (prefix): ${String(token).slice(0, 12)}...`);
          // Inject token into typical fields and attempt form submit
          await page.evaluate(tok => {
            const ta = document.querySelector('textarea#g-recaptcha-response');
            if (ta) { ta.value = tok; ta.dispatchEvent(new Event('change', { bubbles: true })); }
            try { window.__grecaptcha_token = tok; } catch (e) {}
          }, token);
          await page.waitForTimeout(600);

          // attempt to submit forms or reload search results
          try {
            const form = await page.$('form');
            if (form) {
              await form.evaluate(f => f.submit());
            } else {
              const qMatch = url.match(/[?&]q=([^&]+)/);
              const q = qMatch ? decodeURIComponent(qMatch[1]) : '';
              if (q) {
                await page.goto(`https://www.google.com/search?q=${encodeURIComponent(q)}&num=10&hl=en`, { waitUntil: 'domcontentloaded' }).catch(()=>{});
              } else {
                await page.reload({ waitUntil: 'domcontentloaded' }).catch(()=>{});
              }
            }
            await page.waitForLoadState('domcontentloaded');
          } catch (err) { /* ignore */ }

          return { present: true, solved: true };
        } else {
          console.warn('⚠️ CAPTCHA detected but no token returned from NopeCHA REST/SDK.');
          return { present: true, solved: false };
        }
      } catch (err) {
        console.error('⚠️ CAPTCHA solve attempt failed:', err?.message || err);
        return { present: true, solved: false };
      }
    }
  } catch (err) {
    console.warn('⚠️ maybeHandleCaptcha failed:', err?.message || err);
    return { present: false, solved: false };
  }
  return { present: false, solved: false };
}

// Main query - ensure context is always closed even on error
async function runQuery(browser, query) {
  const context = await browser.newContext({
    viewport: { width: 1366, height: 820 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();
  console.log(`🔎 Searching Google for: ${query}`);
  try {
    await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}&num=10&hl=en`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    console.error('⚠️ Page load error', e?.message || e);
  }

  const collected = new Set();
  let pageNum = 1, consecutiveCaptcha = 0;

  try {
    while (true) {
      console.log(`📄 Page ${pageNum}...`);
      const { present, solved } = await maybeHandleCaptcha(page);

      // Only increment consecutiveCaptcha if captcha present AND not solved
      if (present && !solved) {
        consecutiveCaptcha++;
        console.log(`⚠️ CAPTCHA present and not solved — consecutiveCaptcha=${consecutiveCaptcha}`);
        if (consecutiveCaptcha >= 3) {
          console.log('🛑 Too many unsolved CAPTCHA blocks. Stopping query.');
          break;
        }
      } else {
        // either no captcha or captcha solved -> reset counter
        consecutiveCaptcha = 0;
      }

      // if captcha present but solved, give page a moment to recover
      if (present && solved) {
        await page.waitForTimeout(1000 + Math.random() * 1500);
      }

      const emails = await extractEmailsFromPage(page);
      const newEmails = emails.filter(e => !collected.has(e));
      newEmails.forEach(e => collected.add(e));

      if (newEmails.length) {
        const rows = newEmails.map(e => ({ email: e, query, timestamp: (new Date()).toISOString() }));
        appendToCSV(rows);
        await saveToSupabase(rows).catch(() => {});
        console.log(`✅ ${newEmails.length} new emails stored`);
      } else {
        console.log('ℹ️ No new emails on this page.');
      }

      const hasNext = await goToNextPage(page);
      if (!hasNext) { console.log('🚫 No more pages.'); break; }
      pageNum++;
      await sleep(1500 + Math.random() * 1500);
    }
  } catch (err) {
    console.error('🚨 runQuery failed for', query, err?.message || err);
  } finally {
    try { await context.close(); } catch (e) { /* ignore */ }
    console.log(`🎯 Done for "${query}" — total ${collected.size} unique emails`);
  }
}

// Entry
(async () => {
  try {
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

    const browser = await chromium.launch({ headless: HEADLESS });
    try {
      let idx = 0;
      while (idx < queries.length) {
        const slice = queries.slice(idx, idx + CONCURRENCY);
        await Promise.allSettled(slice.map(q => runQuery(browser, q)));
        idx += CONCURRENCY;
      }
    } finally {
      try { await browser.close(); } catch (e) { /* ignore */ }
    }

    console.log('🏁 All queries completed. Output written to', OUTPUT_FILE);
  } catch (err) {
    console.error('🚨 Fatal error:', err?.message || err);
    process.exit(1);
  }
})();
