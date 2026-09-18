# SUNGWOO KASA Relay

Cloudflare Worker + Durable Object relay between the mobile GitHub Pages UI and the office KASA Chrome extension.

Required secret:

```bash
npx wrangler secret put KASA_API_KEY
```

Deploy:

```bash
npm install
npm run deploy
```

The mobile page and PC extension must use the same HTTPS Worker URL and the same `KASA_API_KEY` value.
