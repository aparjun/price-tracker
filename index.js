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

    if (!Array.isArray(products) || products.length === 0) {
      throw new Error('products.json must be a non-empty array');
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

// Write state to file
function writeState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    console.log('✅ State updated and saved');
  } catch (error) {
    console.error('❌ Failed to write state file:', error.message);
    throw error;
  }
}

// Fetch Amazon product page HTML
async function fetchAmazonPage(url) {
  console.log(`🔍 Fetching: ${url}`);
  console.log('   (mimicking a real browser with a Chrome User-Agent)');

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const html = await response.text();
  console.log(`📄 Received HTML (${html.length} characters)`);
  return html;
}

// Extract a fixed-size HTML segment for AI parsing
function extractHtmlSegment(html) {
  const bodyStart = html.indexOf('<body');
  if (bodyStart === -1) {
    console.warn('⚠️  No <body> tag found, using first 15000 chars');
    return html.substring(0, 15000);
  }
  const segment = html.substring(bodyStart, bodyStart + 15000);
  console.log(`📝 Extracted HTML segment (${segment.length} characters)`);
  return segment;
}

// Parse price using OpenRouter AI
async function parsePriceWithAI(htmlSegment) {
  console.log('🤖 Sending HTML to OpenRouter AI for price extraction...');

  const prompt = `Extract the current selling price in INR (Indian Rupees) from this Amazon product page HTML snippet.

Rules:
- Return ONLY the numeric price value (e.g., "42999" or "42999.00")
- No currency symbols (₹, Rs, INR)
- No commas
- No text, no explanations
- If multiple prices exist (deal price, list price), return the CURRENT SELLING PRICE (the one customer pays)
- If price not found, return "NOT_FOUND"

HTML:
${htmlSegment}`;

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com',
      'X-Title': 'Amazon Price Tracker'
    },
    body: JSON.stringify({
      model: 'google/gemini-flash-1.5-free',
      messages: [
        { role: 'user', content: prompt }
      ],
      max_tokens: 50,
      temperature: 0
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content?.trim() || '';
  console.log(`🤖 AI Response: "${content}"`);

  if (content === 'NOT_FOUND' || !content) {
    throw new Error('AI could not find price in HTML');
  }

  const numericPrice = parseFloat(content.replace(/[^0-9.]/g, ''));

  if (isNaN(numericPrice) || numericPrice <= 0) {
    throw new Error(`Invalid price extracted: ${content}`);
  }

  console.log(`💰 Parsed price: ₹${numericPrice.toLocaleString('en-IN')}`);
  return numericPrice;
}

// Send Telegram notification for a new low
async function sendTelegramNotification(name, price, url, previousLow) {
  console.log('📱 Sending Telegram notification...');

  const prev = previousLow === HIGH_INITIAL ? '—' : `₹${previousLow.toLocaleString('en-IN')}`;
  const message = `🚨 Price Drop Alert!

Product: ${name}
New All-Time Low: ₹${price.toLocaleString('en-IN')}
Previous Low: ${prev}
Link: ${url}

Checked at: ${new Date().toISOString()}`;

  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        disable_web_page_preview: false
      })
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Telegram API error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  if (!result.ok) {
    throw new Error(`Telegram API error: ${result.description}`);
  }

  console.log('✅ Telegram notification sent successfully');
  return result;
}

// Send Telegram error notification so failures are visible
async function sendErrorNotification(name, url, error) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: `⚠️ Price Tracker Error\n\nProduct: ${name}\nURL: ${url}\nError: ${error.message}\nTime: ${new Date().toISOString()}`
      })
    });
  } catch (telegramError) {
    console.error('❌ Failed to send error notification:', telegramError.message);
  }
}

// Process a single product
async function checkProduct(product, state) {
  const ps = state.products[product.id] || {
    lowestPrice: HIGH_INITIAL,
    lastChecked: null,
    priceHistory: []
  };

  const previousLow = ps.lowestPrice;

  const html = await fetchAmazonPage(product.url);
  const htmlSegment = extractHtmlSegment(html);
  const currentPrice = await parsePriceWithAI(htmlSegment);

  const now = new Date().toISOString();
  ps.lastChecked = now;
  ps.priceHistory.push({ timestamp: now, price: currentPrice });

  // Keep only last 100 history entries
  if (ps.priceHistory.length > 100) {
    ps.priceHistory = ps.priceHistory.slice(-100);
  }

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

  let failures = 0;
  for (const product of products) {
    try {
      console.log(`\n=== ${product.name} (${product.id}) ===`);
      await checkProduct(product, state);
    } catch (error) {
      failures++;
      console.error(`❌ Failed to check "${product.name}":`, error.message);
      await sendErrorNotification(product.name, product.url, error);
    }
  }

  writeState(state);

  console.log('\n✅ Price tracker run completed');
  if (failures > 0) {
    console.error(`⚠️  ${failures} product(s) failed to check`);
    process.exit(1);
  }
}

main();
