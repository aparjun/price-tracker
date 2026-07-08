---
Date: 2026-07-09
Supersedes: N/A
Status: In Progress
---

# Amazon India Price Tracker - Implementation Plan

## Project Overview
Build an automated price tracking system for Amazon India products using GitHub Actions, Node.js, OpenRouter AI for HTML parsing, and Telegram for notifications. The system checks prices every 4 hours and alerts when a new all-time low is detected.

## Technical Constraints
- **Frequency Limit**: Maximum 1 check per 4-6 hours to avoid Amazon anti-bot detection
- **Free Tier Only**: All services must use free tiers (GitHub Actions, OpenRouter free models, Telegram Bot API)
- **No External Dependencies**: Use native Node.js `fetch` (Node 18+)
- **State Persistence**: Store all-time low price in `state.json` committed back to repository

---

## File Structure to Create

```
PriceTracker/
├── index.js                    # Main tracking script
├── package.json                # Project metadata (optional, for Node version)
├── state.json                  # Initial state file (lowestPrice: Infinity)
├── .github/
│   └── workflows/
│       └── tracker.yml         # GitHub Actions workflow
├── .gitignore                  # Git ignore file
└── README.md                   # Setup documentation
```

---

## Step 1: Create package.json

**File**: `PriceTracker/package.json`

```json
{
  "name": "amazon-price-tracker",
  "version": "1.0.0",
  "description": "Automated Amazon India price tracker with AI parsing",
  "main": "index.js",
  "type": "module",
  "engines": {
    "node": ">=18.0.0"
  },
  "scripts": {
    "start": "node index.js",
    "test": "echo \"No tests specified\" && exit 0"
  },
  "keywords": ["price-tracker", "amazon", "automation", "github-actions"],
  "license": "MIT"
}
```

**Notes**:
- `"type": "module"` enables ES modules (import/export)
- Node 18+ required for native `fetch`

---

## Step 2: Create .gitignore

**File**: `PriceTracker/.gitignore`

```
# Dependencies
node_modules/

# Environment files
.env
.env.local

# IDE
.vscode/
.idea/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Logs
*.log
npm-debug.log*
```

---

## Step 3: Create Initial State File

**File**: `PriceTracker/state.json`

```json
{
  "lowestPrice": 999999999,
  "productUrl": "",
  "lastChecked": null,
  "priceHistory": []
}
```

**Notes**:
- `lowestPrice` initialized to a very high number (999999999) to ensure first check always triggers "new low"
- `productUrl` will be populated from environment variable at runtime
- `priceHistory` array stores timestamped price entries for future reporting

---

## Step 4: Create index.js - Main Tracking Script

**File**: `PriceTracker/index.js`

```javascript
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
```

---

## Step 5: Create GitHub Actions Workflow

**File**: `PriceTracker/.github/workflows/tracker.yml`

```yaml
name: Amazon Price Tracker

on:
  schedule:
    # Run every 4 hours (at minute 0 of hours 0, 4, 8, 12, 16, 20)
    - cron: '0 */4 * * *'
  # Allow manual trigger
  workflow_dispatch:
    inputs:
      force_notification:
        description: 'Force send notification even if no new low'
        required: false
        default: 'false'
        type: boolean

jobs:
  track-price:
    name: Track Price
    runs-on: ubuntu-latest
    timeout-minutes: 10
    
    permissions:
      contents: write  # Required to push state.json changes
    
    steps:
      # Checkout repository with full history for git push
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0  # Full history needed for push
          token: ${{ secrets.GITHUB_TOKEN }}
      
      # Setup Node.js
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      
      # Install dependencies (if any)
      - name: Install dependencies
        run: |
          if [ -f package-lock.json ]; then
            npm ci
          elif [ -f package.json ]; then
            npm install
          else
            echo "No package.json found, skipping install"
          fi
      
      # Run price tracker
      - name: Run Price Tracker
        id: tracker
        env:
          AMAZON_URL: ${{ secrets.AMAZON_URL }}
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
          TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
          TELEGRAM_CHAT_ID: ${{ secrets.TELEGRAM_CHAT_ID }}
        run: |
          node index.js
      
      # Commit and push state.json if changed
      - name: Persist state changes
        if: always()
        run: |
          git config --global user.name 'Price Tracker Bot'
          git config --global user.email 'price-tracker@github-actions.local'
          
          # Check if state.json has changes
          if git diff --quiet state.json; then
            echo "No changes to state.json"
          else
            echo "State file changed, committing..."
            git add state.json
            git commit -m "chore: update price tracking state [$(date -u +'%Y-%m-%d %H:%M:%S' UTC)]"
            git push origin HEAD:${{ github.ref_name }}
            echo "State pushed successfully"
          fi
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      
      # Summary output
      - name: Output Summary
        if: always()
        run: |
          echo "## Price Tracker Run Summary" >> $GITHUB_STEP_SUMMARY
          echo "**Status**: ${{ job.status }}" >> $GITHUB_STEP_SUMMARY
          echo "**Time**: $(date -u)" >> $GITHUB_STEP_SUMMARY
          echo "**Repository**: ${{ github.repository }}" >> $GITHUB_STEP_SUMMARY
          echo "**Workflow**: ${{ github.workflow }}" >> $GITHUB_STEP_SUMMARY
          if [ -f state.json ]; then
            echo "" >> $GITHUB_STEP_SUMMARY
            echo "### Current State" >> $GITHUB_STEP_SUMMARY
            cat state.json | jq . >> $GITHUB_STEP_SUMMARY 2>/dev/null || cat state.json >> $GITHUB_STEP_SUMMARY
          fi
```

---

## Step 6: Create README.md

**File**: `PriceTracker/README.md`

```markdown
# Amazon India Price Tracker

Automated price tracking for Amazon India products using GitHub Actions, AI-powered HTML parsing, and Telegram notifications.

## Features

- 🔄 **Automated checks every 4 hours** via GitHub Actions scheduled workflow
- 🤖 **AI-powered price extraction** using OpenRouter (Google Gemini Flash 1.5 Free) - resilient to Amazon HTML changes
- 📱 **Instant Telegram notifications** when new all-time low price detected
- 💾 **Persistent state** stored in repository (commits `state.json` automatically)
- 🆓 **Completely free** - uses only free tiers of all services
- 🛡️ **Secure** - all secrets stored in GitHub repository secrets

## Architecture

```
GitHub Actions (cron every 4h)
       │
       ▼
Node.js Script (index.js)
       │
       ├───▶ Fetch Amazon HTML (with browser-like headers)
       │
       ├───▶ Send HTML segment to OpenRouter AI
       │         └──▶ Returns numeric price
       │
       ├───▶ Compare with state.json lowestPrice
       │
       ├───▶ If new low: Update state.json + Send Telegram
       │
       └───▶ Commit & push state.json to repo
```

## Prerequisites

1. **GitHub Account** - For repository and Actions
2. **OpenRouter Account** - Free API key at [openrouter.ai](https://openrouter.ai)
3. **Telegram Account** - For bot and notifications

## Setup Instructions

### 1. Create Telegram Bot

1. Open Telegram and search for `@BotFather`
2. Send `/newbot` and follow prompts
3. Save the **Bot Token** (format: `123456789:ABCdefGHIjklMNOpqrSTUvwxyz`)
4. Message your new bot to start a chat
5. Get your **Chat ID**:
   - Visit: `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
   - Look for `"chat":{"id":123456789,...}` - that number is your Chat ID

### 2. Get OpenRouter API Key

1. Sign up at [openrouter.ai](https://openrouter.ai)
2. Go to [Keys](https://openrouter.ai/keys)
3. Create a new API key
4. The free tier includes `google/gemini-flash-1.5-free` model

### 3. Create GitHub Repository

1. Create a new **private** repository on GitHub
2. Push these files to the repository:
   ```bash
   git init
   git add .
   git commit -m "Initial commit: Amazon price tracker"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
   git push -u origin main
   ```

### 4. Configure GitHub Secrets

Go to your repository: **Settings → Secrets and variables → Actions → New repository secret**

Add these **4 secrets**:

| Secret Name | Value | Description |
|-------------|-------|-------------|
| `AMAZON_URL` | `https://www.amazon.in/dp/B0XXXXXXXX` | Full Amazon India product URL |
| `OPENROUTER_API_KEY` | `sk-or-v1-xxxxxxxxxxxxx` | Your OpenRouter API key |
| `TELEGRAM_BOT_TOKEN` | `123456789:ABCdefGHIjklMNOpqrSTUvwxyz` | From BotFather |
| `TELEGRAM_CHAT_ID` | `123456789` | Your numeric chat ID |

### 5. Enable GitHub Actions

1. Go to **Actions** tab in your repository
2. Click "I understand my workflows, go ahead and enable them"
3. The workflow will run automatically every 4 hours
4. You can also trigger manually from Actions tab → "Run workflow"

### 6. Test the Setup

1. Go to **Actions** tab
2. Select "Amazon Price Tracker" workflow
3. Click "Run workflow" → "Run workflow"
4. Check the run logs for success
5. Check Telegram for notification (if price is lower than initial state)

## Customization

### Change Check Frequency

Edit `.github/workflows/tracker.yml`:

```yaml
on:
  schedule:
    - cron: '0 */6 * * *'  # Every 6 hours instead of 4
```

### Track Multiple Products

Create separate workflow files or modify `index.js` to accept multiple URLs via environment variables.

### Add Price History Report

The `state.json` accumulates `priceHistory` array. You can:
- Add a step to generate HTML report
- Deploy to GitHub Pages for visual dashboard
- Export to CSV for analysis

## Troubleshooting

### "AI could not find price"
- Amazon may have changed page structure significantly
- Try increasing HTML segment size in `extractHtmlSegment()` (currently 15000 chars)
- Check workflow logs for the HTML segment being sent

### "Telegram API error: 400 Bad Request"
- Verify `TELEGRAM_CHAT_ID` is correct (numeric, no quotes)
- Ensure you've messaged the bot at least once

### "Git push failed"
- Ensure repository is not empty
- Check `GITHUB_TOKEN` permissions (needs `contents: write`)
- Workflow uses `actions/checkout@v4` with `fetch-depth: 0`

### Rate Limited by Amazon
- Increase cron interval to 6+ hours
- The User-Agent mimics Chrome 120 on Windows

## Security Notes

- All secrets stored in GitHub encrypted secrets (never in code)
- `state.json` only contains price data, no credentials
- GitHub Actions runs in isolated ephemeral runners
- OpenRouter free tier has daily limits (check their docs)

## License

MIT License - Feel free to use and modify.
```

---

## Required GitHub Secrets Summary

| Secret | Required | Example Value |
|--------|----------|---------------|
| `AMAZON_URL` | Yes | `https://www.amazon.in/dp/B09V3KXJPB` |
| `OPENROUTER_API_KEY` | Yes | `sk-or-v1-abcdef123456...` |
| `TELEGRAM_BOT_TOKEN` | Yes | `123456789:ABCdefGHIjklMNOpqrSTUvwxyz` |
| `TELEGRAM_CHAT_ID` | Yes | `987654321` |

---

## Verification Checklist

After implementation, verify:

- [ ] `package.json` exists with `"type": "module"` and Node 18+ engine
- [ ] `.gitignore` excludes `node_modules/`, `.env`, IDE files
- [ ] `state.json` exists with initial `lowestPrice: 999999999`
- [ ] `index.js` uses ES modules (`import`), validates all env vars, handles errors
- [ ] `.github/workflows/tracker.yml` has correct cron (`0 */4 * * *`), permissions, and push logic
- [ ] `README.md` has complete setup instructions
- [ ] All 4 GitHub secrets configured in repository settings
- [ ] Workflow runs successfully on manual trigger
- [ ] Telegram notification received on first run (since initial lowestPrice is very high)
- [ ] `state.json` gets updated and committed after run

---

## Notes for Implementation Agent

1. **Do not modify** the core logic flow: Fetch → AI Parse → Compare → Notify → Persist
2. **Use native fetch only** - no axios, node-fetch, or other HTTP libraries
3. **ES Modules required** - use `import`/`export`, not `require`
4. **Error handling** - every external call must have try/catch with descriptive errors
5. **Logging** - console.log at each major step for debugging in Actions logs
6. **State persistence** - must commit and push `state.json` changes in workflow
7. **Free model** - must use `google/gemini-flash-1.5-free` on OpenRouter
8. **Cron schedule** - exactly `0 */4 * * *` (every 4 hours at minute 0)
9. **HTML segment** - exactly 15000 characters from `<body` tag
10. **Telegram message format** - match the specified format with emoji and locale formatting

## Addendum (2026-07-09 revisions)

- Product URLs moved out of secrets into a committed `products.json` (they are public, not sensitive). Only 3 secrets remain: `OPENROUTER_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
- **Free-model enforcement**: before any AI call, resolve models via OpenRouter `/models`, keep only those with `pricing.prompt === "0"` AND `pricing.completion === "0"` AND id ending in `:free`. Fall back to a curated `:free` list if the API is unreachable. A guard refuses to call any non-`:free` model so credits are never consumed.
- **Resilience**: every external step has retry-with-backoff plus fallback — Amazon fetch rotates User-Agents and treats 404 as fatal; AI parse retries each model 2x then falls back to the next free model; Telegram alerts retry 3x; state write retries 3x. All calls have timeouts. A single product failure alerts and continues; the run only fails if all products fail.

## Addendum 2 (Web Admin UI)

- Added a static site in `site/` deployed via GitHub Pages (`pages.yml`).
- Option A chosen: Google sign-in (GIS) gates access by allowed email; a GitHub PAT (stored in browser) reads/writes `products.json` via the Contents API. Tracker script unchanged.
- `site/app.js` `CONFIG` holds Google Client ID, allowed emails, repo owner/name, and target branch (dev).
- Reminder: scheduled workflow runs from the default branch; default must be set to `dev` (or dev merged to master) for the 4-hour automation to fire.

## Addendum 3 (Configure via GitHub UI)

- GitHub *secrets/variables* are only available to Actions runners, NOT to browser JS on a static Pages site. So values can't be read directly by `app.js`.
- Implemented build-time injection: `pages.yml` reads repo **Variables** (`GOOGLE_CLIENT_ID`, `ALLOWED_EMAILS`, `REPO_OWNER`, `REPO_NAME`, `BRANCH`) and writes `site/config.js`, which overrides `CONFIG_DEFAULTS` in `app.js` via `window.APP_CONFIG`.
- These values are public by nature → use Variables, not Secrets. The GitHub PAT must never be a var/secret (would be exposed in the public site); it stays in the browser.