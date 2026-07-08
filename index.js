import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Secrets (only these are sensitive)
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Tracked data lives in the repo (not secret)
const PRODUCTS_FILE = join(__dirname, 'products.json');
const STATE_FILE = join(__dirname, 'state.json');
const HIGH_INITIAL = 999999999;

// Ordered preference of free models. Every entry carries OpenRouter's ":free"
// suffix and has ZERO prompt/completion pricing, so they never consume credits.
// The live resolver below verifies pricing before any call.
const PREFERRED_FREE_MODELS = [
  'google/gemma-4-26b-a4b-it:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'qwen/qwen3-coder:free',
  'openai/gpt-oss-20b:free',
  'google/gemma-4-31b-it:free'
];

// Fallback provider (only used when OpenRouter free models are unavailable).
// Mistral has a free tier (small quota); kept as a sparing backup so OpenRouter
// (zero-cost) remains the primary parser.
const MISTRAL_MODEL = 'mistral-small-latest';

// A few realistic User-Agents, rotated on retries to reduce Amazon blocking.
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Edg/119.0.0.0',
  'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0'
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Errors marked .fatal are NOT retried (e.g. parse failures, removed product).
class FatalError extends Error {
  constructor(message) {
    super(message);
    this.fatal = true;
  }
}

// Rate-limit (429) on the free tier: account-wide, won't clear mid-run.
class RateLimitedError extends Error {
  constructor(message) {
    super(message);
    this.rateLimited = true;
  }
}

// Amazon served a block/redirect/CAPTCHA page (typically from a flagged IP).
// Transient: a later run (possibly a different IP) usually succeeds.
class BlockedError extends Error {
  constructor(message) {
    super(message);
    this.transient = true;
  }
}

// fetch() wrapper that aborts after `ms` so a hung connection can't stall the run.
async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Generic retry with exponential backoff + jitter.
// `isRetryable(err)` decides whether to retry; fatal errors short-circuit.
async function withRetry(
  fn,
  { retries = 3, baseDelayMs = 2000, factor = 2, isRetryable = () => true, label = 'operation' } = {}
) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (err?.fatal || !isRetryable(err)) {
        console.warn(`⚠️  ${label} failed (non-retryable): ${err.message}`);
        throw err;
      }
      const isLast = attempt === retries;
      console.warn(`⚠️  ${label} failed (attempt ${attempt}/${retries}): ${err.message}`);
      if (isLast) break;
      const delay = Math.min(baseDelayMs * Math.pow(factor, attempt - 1), 30000) + Math.random() * 500;
      console.log(`   retrying in ${Math.round(delay)}ms...`);
      await sleep(delay);
    }
  }
  throw lastError;
}

// Validate required secrets
function validateConfig() {
  const missing = [];
  if (!OPENROUTER_API_KEY) missing.push('OPENROUTER_API_KEY');
  if (!TELEGRAM_BOT_TOKEN) missing.push('TELEGRAM_BOT_TOKEN');
  if (!TELEGRAM_CHAT_ID) missing.push('TELEGRAM_CHAT_ID');

  if (missing.length > 0) {
    console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
}

// Load the list of products to track from the repo
function readProducts() {
  try {
    const data = fs.readFileSync(PRODUCTS_FILE, 'utf-8');
    const products = JSON.parse(data);

    if (!Array.isArray(products)) {
      throw new Error('products.json must be a JSON array');
    }

    for (const p of products) {
      if (!p.id || !p.url) {
        throw new Error('Each product must have an "id" and a "url"');
      }
      if (!p.url.includes('amazon.in') && !p.url.includes('amazon.com')) {
        throw new Error(`Product "${p.id}" URL must be an Amazon India (.in) or Amazon (.com) link`);
      }
    }

    return products;
  } catch (error) {
    console.error('❌ Failed to read products.json:', error.message);
    process.exit(1);
  }
}

// Read per-product state from file
function readState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      if (parsed && parsed.products) return parsed;
    }
  } catch (error) {
    console.warn('⚠️  Could not read state file, starting fresh:', error.message);
  }
  return { products: {} };
}

// Write state to file (with a couple of retries)
function writeState(state) {
  return withRetry(
    () => {
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      console.log('✅ State updated and saved');
    },
    { retries: 3, baseDelayMs: 500, label: 'write state' }
  );
}

// Resolve which free models are actually available, verified against OpenRouter's
// own pricing metadata so we NEVER call a model that would consume credits.
async function resolveFreeModels() {
  return withRetry(
    async () => {
      const res = await fetchWithTimeout(
        'https://openrouter.ai/api/v1/models',
        {
          headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            'HTTP-Referer': 'https://github.com',
            'X-Title': 'Amazon Price Tracker'
          }
        },
        15000
      );
      if (!res.ok) throw new Error(`models list HTTP ${res.status}`);

      const data = await res.json();
      const models = Array.isArray(data?.data) ? data.data : [];

      const free = models
        .filter((m) => {
          const p = m?.pricing;
          const zeroPricing = p && p.prompt === '0' && p.completion === '0';
          return zeroPricing && typeof m.id === 'string' && m.id.endsWith(':free');
        })
        .map((m) => m.id);

      if (free.length === 0) {
        // Could not confirm any free model via API. Fall back to our curated
        // :free list (these IDs are OpenRouter's reserved free-model names).
        console.warn('⚠️  No free models confirmed via API; using curated :free list (still zero-cost).');
        return PREFERRED_FREE_MODELS.slice();
      }

      // Honour our preferred order, then append any other verified-free models.
      const ordered = [
        ...PREFERRED_FREE_MODELS.filter((id) => free.includes(id)),
        ...free.filter((id) => !PREFERRED_FREE_MODELS.includes(id))
      ];
      console.log(`🆓 Free models available (${ordered.length}): ${ordered.join(', ')}`);
      return ordered;
    },
    { retries: 3, baseDelayMs: 1500, label: 'resolve free models' }
  );
}

// Strip tracking/redirect params so we hit the canonical product URL
// (less "shared-link" fingerprint, which Amazon is more likely to block).
function cleanAmazonUrl(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

// Detect when Amazon returns a block/redirect/CAPTCHA interstitial instead of
// the product page (common from flagged cloud IPs). These are transient — a
// later run (often a different IP) usually succeeds.
function isBlockedPage(html) {
  const lowered = html.toLowerCase();
  const markers = [
    'robot check', 'captcha', 'automated access', 'make sure you are not a robot',
    'characters you see', 'just need to make sure you', 'to discuss automated access',
    'type the characters you see', 'unusual traffic', 'verify you are human'
  ];
  if (markers.some((m) => lowered.includes(m))) return true;
  // Real Amazon product pages are very large; a tiny body means block/redirect/error.
  if (html.length < 30000) return true;
  return false;
}

// Fetch Amazon product page HTML (retried by caller, with UA rotation per attempt)
async function fetchAmazonPage(url, attempt) {
  const ua = USER_AGENTS[(attempt - 1) % USER_AGENTS.length];
  const fetchUrl = cleanAmazonUrl(url);
  console.log(`🔍 Fetching: ${fetchUrl}${fetchUrl !== url ? ` (cleaned from ${url})` : ''}`);
  console.log(`   (attempt #${attempt}, User-Agent rotation)`);

  const res = await fetchWithTimeout(
    fetchUrl,
    {
      headers: {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Cache-Control': 'max-age=0'
      }
    },
    30000
  );

  // 404 = product gone -> fatal (no point retrying). Others may be transient blocks.
  if (!res.ok) {
    if (res.status === 404) throw new FatalError(`Amazon returned 404 for ${url} (product likely removed)`);
    throw new Error(`HTTP ${res.status}: ${res.statusText}`); // 403/429/5xx -> retryable
  }

  const html = await res.text();
  if (!html || html.length < 500) {
    throw new FatalError('Amazon returned an empty/short body (likely a CAPTCHA or block page)');
  }

  if (isBlockedPage(html)) {
    throw new BlockedError('Amazon served a block/redirect/CAPTCHA page (anti-bot). Will retry next run.');
  }

  console.log(`📄 Received HTML (${html.length} characters)`);
  return html;
}

// Extract price-context windows from the (often huge) Amazon HTML instead of a
// fixed prefix. Amazon pages are 100s of KB; the price usually sits far below
// the <body> opening, so a 15k prefix misses it. We locate price-related text
// and pull a window around each hit, capped to keep token usage sane.
function extractHtmlSegments(html) {
  const MAX_TOTAL = 50000;
  const WIN = 4000;

  const keywords = ['₹', 'Rs.', 'INR', 'a-price', 'data-price', 'priceblock', 'buyingPrice', '"price"', 'priceCurrency', 'dealPrice'];
  const hits = [];
  for (const kw of keywords) {
    let idx = html.indexOf(kw);
    while (idx !== -1 && hits.length < 40) {
      hits.push(idx);
      idx = html.indexOf(kw, idx + 1);
    }
  }

  const seen = new Set();
  const windows = [];
  let total = 0;
  for (const pos of hits) {
    const start = Math.max(0, pos - Math.floor(WIN / 2));
    const end = Math.min(html.length, pos + Math.floor(WIN / 2));
    const key = Math.floor(start / 2000); // dedupe by coarse region
    if (seen.has(key)) continue;
    seen.add(key);
    const seg = html.substring(start, end);
    if (total + seg.length > MAX_TOTAL) break;
    windows.push(seg);
    total += seg.length;
  }

  if (windows.length > 0) {
    const combined = windows.join('\n\n---SNIP---\n\n');
    console.log(`📝 Extracted ${windows.length} price-context window(s) (${combined.length} characters)`);
    return combined;
  }

  // Fallback: large prefix of the body
  const bodyStart = html.indexOf('<body');
  const fallback = bodyStart === -1 ? html.substring(0, MAX_TOTAL) : html.substring(bodyStart, bodyStart + MAX_TOTAL);
  console.log(`📝 Extracted HTML segment (${fallback.length} characters)`);
  return fallback;
}

// Shared prompt: ask the model for the current INR selling price only.
function buildPricePrompt(htmlSegment) {
  return `Extract the current selling price in INR (Indian Rupees) from this Amazon product page HTML snippet.

Rules:
- Return ONLY the numeric price value (e.g., "42999" or "42999.00")
- No currency symbols (₹, Rs, INR)
- No commas
- No text, no explanations
- If multiple prices exist (deal price, list price), return the CURRENT SELLING PRICE (the one customer pays)
- If price not found, return "NOT_FOUND"

HTML:
${htmlSegment}`;
}

// Call a single (verified-free) model to extract the price.
async function callModel(modelId, htmlSegment) {
  // Defense-in-depth: never call a model that isn't explicitly free.
  if (!modelId.endsWith(':free')) {
    throw new FatalError(`Refusing to call non-free model "${modelId}" (would consume credits)`);
  }

  console.log(`🤖 Parsing price with ${modelId}...`);

  const prompt = buildPricePrompt(htmlSegment);

  const res = await fetchWithTimeout(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com',
        'X-Title': 'Amazon Price Tracker'
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 50,
        temperature: 0
      })
    },
    60000
  );

  if (!res.ok) {
    if (res.status === 429) throw new RateLimitedError(`OpenRouter HTTP 429 (rate limit) on ${modelId}`);
    if (res.status >= 500) throw new Error(`OpenRouter HTTP ${res.status} (transient)`);
    throw new FatalError(`OpenRouter HTTP ${res.status}: ${res.statusText}`);
  }

  const data = await res.json();
  if (data?.error) {
    throw new Error(`OpenRouter error: ${data.error.message || JSON.stringify(data.error)}`);
  }

  const content = data?.choices?.[0]?.message?.content?.trim() || '';
  console.log(`🤖 AI Response: "${content}"`);

  if (content === 'NOT_FOUND' || !content) {
    throw new FatalError('AI could not find price in HTML'); // try next model
  }

  const numericPrice = parseFloat(content.replace(/[^0-9.]/g, ''));
  if (isNaN(numericPrice) || numericPrice <= 0) {
    throw new FatalError(`Invalid price extracted: ${content}`); // try next model
  }

  console.log(`💰 Parsed price: ₹${numericPrice.toLocaleString('en-IN')}`);
  return numericPrice;
}

// Try each free model in order; fall back to the next on any failure.
// Mistral fallback: used only when OpenRouter free models are exhausted/
// rate-limited. Requires MISTRAL_API_KEY (optional repo secret). Mistral has
// a free tier (small quota) — used sparingly, so OpenRouter stays primary.
async function callMistral(apiKey, htmlSegment) {
  console.log(`🤖 Parsing price with Mistral (${MISTRAL_MODEL})...`);
  const prompt = buildPricePrompt(htmlSegment);

  const res = await fetchWithTimeout('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: MISTRAL_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 50,
      temperature: 0
    })
  }, 60000);

  if (!res.ok) {
    if (res.status === 429) throw new RateLimitedError('Mistral HTTP 429 (rate limit)');
    if (res.status >= 500) throw new Error(`Mistral HTTP ${res.status} (transient)`);
    throw new FatalError(`Mistral HTTP ${res.status}: ${res.statusText}`);
  }

  const data = await res.json();
  if (data?.error) throw new Error(`Mistral error: ${data.error.message || JSON.stringify(data.error)}`);

  const content = data?.choices?.[0]?.message?.content?.trim() || '';
  console.log(`🤖 Mistral Response: "${content}"`);

  if (content === 'NOT_FOUND' || !content) throw new FatalError('Mistral could not find price in HTML');
  const numericPrice = parseFloat(content.replace(/[^0-9.]/g, ''));
  if (isNaN(numericPrice) || numericPrice <= 0) throw new FatalError(`Invalid price extracted: ${content}`);

  console.log(`💰 Parsed price: ₹${numericPrice.toLocaleString('en-IN')}`);
  return numericPrice;
}

// OpenRouter free models first (max 3), then a single Mistral fallback.
// Capped at ~3 + 1 calls so we never storm the APIs.
async function parsePriceWithFallback(htmlSegment, freeModelIds) {
  const candidates = freeModelIds.slice(0, 3);
  let lastError;
  let rateLimited = false;

  for (const modelId of candidates) {
    try {
      const price = await withRetry(
        () => callModel(modelId, htmlSegment),
        { retries: 1, baseDelayMs: 1500, label: `AI parse (${modelId})`, isRetryable: (e) => !e?.fatal && !e?.rateLimited }
      );
      console.log(`💡 Used OpenRouter model ${modelId}`);
      return price;
    } catch (err) {
      if (err?.rateLimited) rateLimited = true;
      lastError = err;
      const reason = err?.fatal ? 'could not parse price' : err?.rateLimited ? 'rate-limited' : 'failed (transient)';
      console.warn(`⚠️  OpenRouter ${modelId} ${reason}; trying next`);
    }
  }

  const mistralKey = process.env.MISTRAL_API_KEY;
  if (mistralKey) {
    try {
      console.log('🔁 Falling back to Mistral...');
      const price = await withRetry(
        () => callMistral(mistralKey, htmlSegment),
        { retries: 1, baseDelayMs: 1500, label: 'AI parse (Mistral)', isRetryable: (e) => !e?.fatal && !e?.rateLimited }
      );
      console.log('💡 Used Mistral fallback');
      return price;
    } catch (err) {
      if (err?.rateLimited) rateLimited = true;
      lastError = err;
      console.warn(`⚠️  Mistral fallback failed: ${err.message}`);
    }
  } else {
    console.log('ℹ️  MISTRAL_API_KEY not set; skipping Mistral fallback');
  }

  if (rateLimited) {
    throw new RateLimitedError('All providers rate-limited. Will retry next scheduled run.');
  }
  throw lastError ?? new FatalError('All providers failed to parse price');
}

// Send a Telegram message (throws on failure so the caller can retry).
async function sendTelegramMessage(text) {
  const res = await fetchWithTimeout(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: false
      })
    },
    15000
  );

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Telegram HTTP ${res.status} - ${errorText}`);
  }

  const result = await res.json();
  if (!result.ok) {
    throw new Error(`Telegram API error: ${result.description}`);
  }

  return result;
}

async function sendTelegramNotification(name, price, url, previousLow) {
  console.log('📱 Sending Telegram notification...');
  const prev = previousLow === HIGH_INITIAL ? '—' : `₹${previousLow.toLocaleString('en-IN')}`;
  const message = `🚨 Price Drop Alert!

Product: ${name}
New All-Time Low: ₹${price.toLocaleString('en-IN')}
Previous Low: ${prev}
Link: ${url}

Checked at: ${new Date().toISOString()}`;

  await withRetry(
    () => sendTelegramMessage(message),
    { retries: 3, baseDelayMs: 2000, label: 'Telegram alert' }
  );
  console.log('✅ Telegram notification sent successfully');
}

// Best-effort error alert — reported but never blocks the run.
async function sendErrorNotification(name, url, error) {
  const message = `⚠️ Price Tracker Error

Product: ${name}
URL: ${url}
Error: ${error.message}
Time: ${new Date().toISOString()}`;

  try {
    await withRetry(
      () => sendTelegramMessage(message),
      { retries: 2, baseDelayMs: 1500, label: 'Telegram error alert' }
    );
  } catch (telegramError) {
    console.error('❌ Failed to send error notification:', telegramError.message);
  }
}

// Process a single product end-to-end with retries + fallbacks at each step.
async function checkProduct(product, state, freeModelIds) {
  const ps = state.products[product.id] || {
    lowestPrice: HIGH_INITIAL,
    lastChecked: null,
    priceHistory: []
  };
  const previousLow = ps.lowestPrice;

  // Step 1: fetch Amazon page (retries + UA rotation)
  const html = await withRetry(
    (attempt) => fetchAmazonPage(product.url, attempt),
    { retries: 3, baseDelayMs: 3000, factor: 2, label: 'fetch Amazon', isRetryable: (e) => !e?.fatal }
  );

  // Step 2: extract + parse price (model fallback across free models)
  const htmlSegment = extractHtmlSegments(html);
  const currentPrice = await parsePriceWithFallback(htmlSegment, freeModelIds);

  // Step 3: update state
  const now = new Date().toISOString();
  ps.lastChecked = now;
  ps.priceHistory.push({ timestamp: now, price: currentPrice });
  if (ps.priceHistory.length > 100) {
    ps.priceHistory = ps.priceHistory.slice(-100);
  }

  // Step 4: notify on new low
  if (currentPrice < previousLow) {
    console.log(`🎉 NEW ALL-TIME LOW for "${product.name}"! ₹${currentPrice.toLocaleString('en-IN')} < ₹${previousLow === HIGH_INITIAL ? '∞' : previousLow.toLocaleString('en-IN')}`);
    ps.lowestPrice = currentPrice;
    await sendTelegramNotification(product.name, currentPrice, product.url, previousLow);
  } else {
    console.log(`📈 No new low for "${product.name}". Current: ₹${currentPrice.toLocaleString('en-IN')}, Lowest: ₹${previousLow === HIGH_INITIAL ? '∞' : previousLow.toLocaleString('en-IN')}`);
  }

  state.products[product.id] = ps;
}

// Main entry point
async function main() {
  console.log('🚀 Starting price tracker...');
  validateConfig();

  const products = readProducts();
  console.log(`📦 Tracking ${products.length} product(s)`);

  const state = readState();

  // Resolve the list of zero-cost models once for the whole run.
  let freeModelIds;
  try {
    freeModelIds = await resolveFreeModels();
  } catch (err) {
    console.warn('⚠️  Free-model verification failed:', err.message, '— using curated :free list as fallback.');
    freeModelIds = PREFERRED_FREE_MODELS.slice();
  }

  let failures = 0;
  for (const product of products) {
    try {
      console.log(`\n=== ${product.name} (${product.id}) ===`);
      await checkProduct(product, state, freeModelIds);
    } catch (error) {
      if (error?.rateLimited || error?.transient) {
        // Expected (free-tier rate limit or Amazon anti-bot block); don't alarm.
        console.warn(`⏳ Skipping "${product.name}": ${error.message}`);
        continue;
      }
      failures++;
      console.error(`❌ Failed to check "${product.name}":`, error.message);
      await sendErrorNotification(product.name, product.url, error);
    }
  }

  await writeState(state);

  console.log('\n✅ Price tracker run completed');
  if (failures > 0) {
    console.error(`⚠️  ${failures} product(s) failed to check`);
    process.exit(1);
  }
}

main();
