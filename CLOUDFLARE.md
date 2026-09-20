# Publishing the demo site on Cloudflare Pages

The site's address should not move. A Cloudflare quick tunnel's does — ours rotated twice in
one day and took a submitted link with it — so the site goes on Pages and the tunnels stay
where they belong: in front of the anchor and the payment service, which run on a laptop.

The two are decoupled. `panel/runtime-config.js` is loaded before the bundle and carries the
backend hostnames, so a rotated tunnel is a one-line edit and a redeploy, not a new URL.

## First time

```bash
npx wrangler login                 # opens the browser; approve once
npm run deploy:site                # builds and publishes
```

The first deploy creates the project (`arfhe-demo`) and prints a `*.pages.dev` address. That
address is permanent.

## A custom domain

In the Cloudflare dashboard: **Workers & Pages → arfhe-demo → Custom domains → Set up a
domain**, and enter the name you want — for example `demo.arfhewallet.dev`. The DNS record is
created for you when the zone is already on this account. HTTPS follows within a few minutes.

## When a tunnel rotates

```bash
# 1. edit panel/runtime-config.js — the anchor and payroll hostnames
# 2. republish
npm run deploy:site
```

The URL does not change, so nothing that was handed out goes stale.

## What is not on Pages

The anchor (`npm run anchor`) and the payment service (`npm run payroll`) still run locally
and are reached through tunnels. Pages serves static files; these two hold keys and talk to
Horizon, and neither belongs in a static host. The wallet's own build also still carries its
anchor domain at build time — `VITE_ANCHOR_DOMAIN` — because an extension cannot read the
site's config file.
