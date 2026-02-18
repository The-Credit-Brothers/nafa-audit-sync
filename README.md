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

The following GitHub repo secrets are already configured (Settings → Secrets and variables → Actions):

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

## Local Development

```sh
npm install
npm run dev
```

## Manual Deploy

```sh
npm run deploy
```
