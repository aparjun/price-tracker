# Amazon India Price Tracker

Automated price tracking for Amazon India products using GitHub Actions, AI-powered HTML parsing, and Telegram notifications.

## Features

- 🔄 **Automated checks every 4 hours** via GitHub Actions scheduled workflow
- 🤖 **AI-powered price extraction** using OpenRouter, resilient to Amazon HTML changes
- 🆓 **Zero credits**: only verified zero-cost `:free` models are ever used
- 📱 **Instant Telegram notifications** when new all-time low price detected
- 💾 **Persistent state** stored in repository (commits `state.json` automatically)
- 🔁 **Resilient**: retries with backoff + per-model fallback at every external step
- 🛡️ **Secure** - all secrets stored in GitHub repository secrets

## Resilience & Free-Model Guarantee

**Only free models, never your credits.** Before any AI call, the script queries
OpenRouter's `/models` endpoint and keeps only models whose `pricing.prompt` and
`pricing.completion` are both `"0"` **and** whose id ends with `:free`. If the
live check is unavailable, it falls back to a curated list of `:free` model IDs
(each carries the `:free` suffix OpenRouter reserves for zero-cost models). A
final defense-in-depth guard refuses to call any model that does not end with
`:free`, so a paid model can never be invoked by accident.

**Retry + fallback at every step:**

| Step | Retry / Fallback strategy |
|------|---------------------------|
| Resolve free models | Retry up to 3x; on total failure, fall back to curated `:free` list |
| Fetch Amazon page | Retry up to 3x with exponential backoff; **rotates User-Agent** each attempt; 404 treated as fatal (no retry) |
| Parse price (AI) | Retry each model 2x; on exhaustion, **fall back to the next free model**; parse failures move on to the next model immediately |
| Telegram alert | Retry up to 3x; failures also reported via error alert |
| Write state | Retry up to 3x |

All external calls use a timeout (Amazon 30s, OpenRouter 60s, Telegram 15s) so a
hung connection can't stall the run. A failure on one product alerts you and
continues with the next — the whole run only exits non-zero if every product failed.

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

### 4. Add Products to Track

Product URLs are **not** secrets — they are public links, kept in `products.json`
in the repository so you can add or remove products by editing the file.

`products.json` format:

```json
[
  {
    "id": "samsung-253l",
    "name": "Samsung 253L Frost Free Double Door Refrigerator",
    "url": "https://www.amazon.in/dp/B0XXXXXXXX"
  },
  {
    "id": "lg-260l",
    "name": "LG 260L Smart Inverter Refrigerator",
    "url": "https://www.amazon.in/dp/B0YYYYYYYY"
  }
]
```

- `id` — unique short key (used in `state.json`); change it if you swap the model
- `name` — human-readable label shown in Telegram alerts
- `url` — the full Amazon India (`.in`) or Amazon (`.com`) product link

To add a product: append an entry and commit (or open a PR). The next scheduled
run picks it up automatically. Per-product all-time lows are stored in
`state.json` under `products.<id>`.

### 5. Configure GitHub Secrets

Go to your repository: **Settings → Secrets and variables → Actions → New repository secret**

Add these **3 secrets** (product URLs are NOT secrets):

| Secret Name | Value | Description |
|-------------|-------|-------------|
| `OPENROUTER_API_KEY` | `sk-or-v1-xxxxxxxxxxxxx` | Your OpenRouter API key |
| `TELEGRAM_BOT_TOKEN` | `123456789:ABCdefGHIjklMNOpqrSTUvwxyz` | From BotFather |
| `TELEGRAM_CHAT_ID` | `123456789` | Your numeric chat ID |

### 6. Enable GitHub Actions

1. Go to **Actions** tab in your repository
2. Click "I understand my workflows, go ahead and enable them"
3. The workflow will run automatically every 4 hours
4. You can also trigger manually from Actions tab → "Run workflow"

### 7. Test the Setup

1. Go to **Actions** tab
2. Select "Amazon Price Tracker" workflow
3. Click "Run workflow" → "Run workflow"
4. Check the run logs for success
5. Check Telegram for notification (the first run reports a new low, since the initial all-time low is effectively infinite)

## Web Admin UI

A static site (in `site/`) deployed to GitHub Pages lets you sign in with Google and
manage `products.json` without touching git. The tracker itself is unchanged — it
reads `products.json` from the repo.

### Enable the site

1. In repo **Settings → Pages → Build and deployment**, set Source to **GitHub Actions**.
2. Push to the `dev` branch (the `pages.yml` workflow deploys `site/` automatically).
3. The site URL is `https://<user>.github.io/<repo>/` (e.g. `https://aparjun.github.io/price-tracker/`).

### Google sign-in (gate)

1. In [Google Cloud Console](https://console.cloud.google.com) create an **OAuth 2.0 Client ID** (Web application).
2. Under **Authorized JavaScript origins** add your Pages origin, e.g. `https://aparjun.github.io`.
3. Put the Client ID and your Google email(s) into `site/app.js` → `CONFIG` (`GOOGLE_CLIENT_ID`, `ALLOWED_EMAILS`).
4. The sign-in is a soft gate: it only checks the signed-in email is allowed. Actual write
   access comes from the GitHub token below, so the email check is convenience, not real security.

### GitHub token (write access)

In the site, paste a GitHub token once (stored only in your browser via `localStorage`):

- **Fine-grained PAT**: grant **Contents: Read and write** on this repo, **or**
- **Classic PAT**: grant the `public_repo` scope (enough because the repo is public).

The site uses it to read/write `products.json` (and read `state.json` for the dashboard).

### Usage

- **Add product**: fill name + Amazon URL; the ID auto-fills from the name (editable, must be unique).
- **Dashboard**: lists each product with its all-time low and last-checked time (from `state.json`).
- **Delete**: removes a product from `products.json`.

> ⚠️ **Automation note**: GitHub runs *scheduled* workflows from the **default branch**.
> All code (including `tracker.yml`) currently lives on `dev`, and the default branch is `master`
> (which only has the plan). So the 4-hour automation will **not** fire until the default
> branch is set to `dev` (Settings → Branches → default branch → `dev`), or `dev` is merged into
> `master`. The manual "Run workflow" trigger already works on `dev`.

## Customization

### Change Check Frequency

Edit `.github/workflows/tracker.yml`:

```yaml
on:
  schedule:
    - cron: '0 */6 * * *'  # Every 6 hours instead of 4
```

### Track Multiple Products

Multiple products are supported out of the box. Just add more entries to
`products.json` (each with a unique `id`). The script checks every product on
each run and tracks a separate all-time low per `id` in `state.json`.

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
