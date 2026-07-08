import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration from environment variables
const AMAZON_URL = process.env.AMAZON_URL;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const STATE_FILE = join(__dirname, 'state.json');

// Validate required environment variables
function validateConfig() {
  const missing = [];
  if (!AMAZON_URL) missing.push('AMAZON_URL');
  if (!OPENROUTER_API_KEY) missing.push('OPENROUTER_API_KEY');
  if (!TELEGRAM_BOT_TOKEN) missing.push('TELEGRAM_BOT_TOKEN');
  if (!TELEGRAM_CHAT_ID) missing.push('TELEGRAM_CHAT_ID');

  if (missing.length > 0) {
    console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Validate Amazon URL format
  if (!AMAZON_URL.includes('amazon.in') && !AMAZON_URL.includes('amazon.com')) {
    console.error('❌ AMAZON_URL must be an Amazon India (.in) or Amazon (.com) product URL');
    process.exit(1);
  }
}

// Read state from file
function readState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.warn('⚠️  Could not read state file, using defaults:', error.message);
  }
  return { lowestPrice: 999999999, productUrl: AMAZON_URL, lastChecked: null, priceHistory: [] };
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
async function fetchAmazonPage() {
  console.log('🔍 Fetching Amazon product page...');

  const response = await fetch(AMAZON_URL, {
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

// Extract relevant HTML segment for AI parsing
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

  // Clean and parse the price
  const numericPrice = parseFloat(content.replace(/[^0-9.]/g, ''));

  if (isNaN(numericPrice) || numericPrice <= 0) {
    throw new Error(`Invalid price extracted: ${content}`);
  }

  console.log(`💰 Parsed price: ₹${numericPrice.toLocaleString('en-IN')}`);
  return numericPrice;
}

// Send Telegram notification
async function sendTelegramNotification(price, productUrl) {
  console.log('📱 Sending Telegram notification...');

  const message = `🚨 Price Drop Alert!

Product: Refrigerator (Tracked Item)
New All-Time Low: ₹${price.toLocaleString('en-IN')}
Previous Low: Check tracker history
Link: ${productUrl}

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

// Main tracking function
async function checkPrice() {
  console.log('🚀 Starting price check...');
  console.log(`🔗 Product URL: ${AMAZON_URL}`);

  validateConfig();

  const state = readState();
  console.log(`📊 Current lowest price in state: ₹${state.lowestPrice === 999999999 ? 'Not set' : state.lowestPrice.toLocaleString('en-IN')}`);

  try {
    // Fetch and parse
    const html = await fetchAmazonPage();
    const htmlSegment = extractHtmlSegment(html);
    const currentPrice = await parsePriceWithAI(htmlSegment);

    // Update state with current check
    const now = new Date().toISOString();
    state.lastChecked = now;
    state.productUrl = AMAZON_URL;
    state.priceHistory.push({ timestamp: now, price: currentPrice });

    // Keep only last 100 history entries
    if (state.priceHistory.length > 100) {
      state.priceHistory = state.priceHistory.slice(-100);
    }

    // Check for new low
    if (currentPrice < state.lowestPrice) {
      console.log(`🎉 NEW ALL-TIME LOW! ₹${currentPrice.toLocaleString('en-IN')} < ₹${state.lowestPrice === 999999999 ? '∞' : state.lowestPrice.toLocaleString('en-IN')}`);

      state.lowestPrice = currentPrice;
      writeState(state);

      await sendTelegramNotification(currentPrice, AMAZON_URL);
    } else {
      console.log(`📈 No new low. Current: ₹${currentPrice.toLocaleString('en-IN')}, Lowest: ₹${state.lowestPrice.toLocaleString('en-IN')}`);
      writeState(state);
    }

    console.log('✅ Price check completed successfully');

  } catch (error) {
    console.error('❌ Price check failed:', error.message);

    // Send error notification to Telegram (optional, but helpful for debugging)
    try {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: `⚠️ Price Tracker Error\n\n${error.message}\n\nProduct: ${AMAZON_URL}\nTime: ${new Date().toISOString()}`
        })
      });
    } catch (telegramError) {
      console.error('❌ Failed to send error notification:', telegramError.message);
    }

    process.exit(1);
  }
}

// Run the tracker
checkPrice();
