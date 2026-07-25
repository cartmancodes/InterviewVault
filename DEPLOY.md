# Deploying InterviewVault

The site is a plain static folder (`site/`) — no server, no database, no build step at
request time. Cloudflare Pages serves it directly, and a GoDaddy domain points at it.

---

## 1. Build the site

```bash
cd tools
npm install                  # once
node render-diagrams.mjs     # mermaid -> SVG (cached; only new diagrams re-render)
node build-site.mjs          # markdown -> site/
```

`render-diagrams.mjs` drives your local Google Chrome through Puppeteer. If Chrome lives
somewhere non-standard, point at it:

```bash
CHROME_PATH="/path/to/Chrome" node render-diagrams.mjs
```

Set the canonical origin before building so `sitemap.xml` carries your real domain:

```bash
SITE_ORIGIN="https://your-domain.com" node build-site.mjs
```

Preview locally:

```bash
cd ../site && python3 -m http.server 8899   # http://localhost:8899
```

> Diagrams are pre-rendered to SVG at build time, so **commit `site/`**. That keeps
> Cloudflare's build step empty and means the deploy never needs Chrome.

---

## 2. Publish to Cloudflare Pages

### Option A — connect the Git repo (recommended)

1. Push this repository to GitHub.
2. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
3. Pick the repository, then set:

   | Setting | Value |
   |---|---|
   | Framework preset | `None` |
   | Build command | *(leave empty)* |
   | Build output directory | `site` |
   | Root directory | `/` |

4. **Save and Deploy.** You get `https://<project>.pages.dev`.

Every push to the default branch redeploys. Because `site/` is committed and pre-built,
Cloudflare only uploads files — deploys take seconds.

### Option B — direct upload from your machine

```bash
npx wrangler pages deploy site --project-name interviewvault
```

Use this if you would rather not commit `site/`, or want to publish without pushing.

---

## 3. Point the GoDaddy domain at it

Cloudflare needs to answer for the hostname. There are two routes; **A is the one to use
if you want the apex domain** (`example.com`, not just `www.`).

### Route A — move DNS to Cloudflare (recommended, supports apex)

1. Cloudflare dashboard → **Add a site** → enter your domain → choose a plan (Free is fine).
2. Cloudflare scans your existing records. **Check them against GoDaddy before continuing** —
   anything it misses (mail, verification `TXT`, subdomains) must be re-added by hand, or
   that service breaks when nameservers cut over.
3. Cloudflare gives you two nameservers, e.g. `dana.ns.cloudflare.com` / `rob.ns.cloudflare.com`.
4. In **GoDaddy** → *My Products* → your domain → **DNS** → **Nameservers** → **Change** →
   **I'll use my own nameservers** → paste both Cloudflare nameservers → save.
5. Back in Cloudflare: **Workers & Pages** → your Pages project → **Custom domains** →
   **Set up a custom domain** → enter `example.com`, then repeat for `www.example.com`.
   Cloudflare creates the records and issues the TLS certificate automatically.

Nameserver changes usually take 15 minutes to a few hours (up to 48 in the worst case).

### Route B — keep DNS at GoDaddy (`www` only)

GoDaddy cannot CNAME an apex domain, so this route only serves `www.example.com`.

1. **GoDaddy** → your domain → **DNS** → **Add record**:

   | Type | Name | Value | TTL |
   |---|---|---|---|
   | `CNAME` | `www` | `<project>.pages.dev` | 1 hour |

2. Cloudflare → Pages project → **Custom domains** → add `www.example.com`.
3. For the bare domain, add a GoDaddy **Domain Forwarding** rule sending
   `example.com` → `https://www.example.com` (permanent, 301).

---

## 4. After it is live

- Set `SITE_ORIGIN` and rebuild so `sitemap.xml` points at the real domain.
- `site/_headers` already sets long-lived immutable caching for `/assets/*` plus
  `nosniff`, `Referrer-Policy` and `X-Frame-Options`. Adjust there, not in the dashboard.
- `site/_redirects` is empty apart from a comment — add legacy paths there if URLs move.

---

## Rebuilding after you edit the docs

```bash
cd tools && node render-diagrams.mjs && node build-site.mjs
```

Only new or changed mermaid diagrams re-render; everything else comes from cache.
Then commit `site/` and push (Option A) or re-run `wrangler pages deploy` (Option B).
