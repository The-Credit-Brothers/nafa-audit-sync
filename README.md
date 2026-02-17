# nafa-audit-sync

Cloudflare Worker that syncs NAFA audit files from Monday.com to Close CRM.

## What It Does

When a NAFA audit file is uploaded to a Monday.com board column, this worker:

1. Downloads the file from Monday.com
2. Uploads it to Close CRM via their two-step upload process (init → S3)
3. Stores a copy in Cloudflare R2 (`nafa-audit-pdfs` bucket) for public hosting
4. Updates a Close lead custom field with the public R2 URL
5. Creates a Close note with the file attachment on the lead

## Setup

### Cloudflare Worker Secrets

These are already configured on the live worker. If you ever need to update them:

```sh
npx wrangler secret put MONDAY_API_TOKEN
npx wrangler secret put CLOSE_API_KEY
npx wrangler secret put NAFA_FILE_COLUMN_ID
npx wrangler secret put CLOSE_LEAD_ID_COLUMN_ID
npx wrangler secret put CLOSE_NAFA_URL_FIELD_ID
npx wrangler secret put R2_PUBLIC_URL
```

### GitHub Actions Auto-Deploy

Pushes to `main` automatically deploy to Cloudflare Workers via GitHub Actions.

Add these as **GitHub repo secrets** (Settings → Secrets and variables → Actions → New repository secret):

| Secret | Value |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | `e8e60b65eb8b7ac41a8b9930de4ff5d5` |
| `CLOUDFLARE_API_TOKEN` | Create at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) — use the **Edit Cloudflare Workers** template |

## Local Development

```sh
npm install
npm run dev
```

## Manual Deploy

```sh
npm run deploy
```
