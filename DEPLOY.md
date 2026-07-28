# Deploying InterviewVault

The site is a plain static folder (`site/`) — no server, no database, no build step at
request time. A Cloudflare **Worker with static assets** serves it, and a GoDaddy domain
points at that.

**`site/` is not committed.** GitHub Actions builds it from the markdown on every push and
deploys it with `wrangler deploy`. Sections 1 and 2 below describe that pipeline; sections
3 onward cover the domain and the manual fallback.

---

## 0. CI/CD (the normal path)

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) runs on every push and pull
request to `master`:

| Stage | What it does | Fails the build when |
|---|---|---|
| Check Python samples | `tools/check-python.py` | a ` ```python ` block does not parse |
| Render diagrams | `tools/render-diagrams.mjs` | a mermaid block cannot be rendered |
| Build site | `tools/build-site.mjs` | the build throws |
| Check links | `tools/check-site.mjs` | a broken link, missing asset or dead anchor |
| Deploy | `wrangler deploy` (Workers Static Assets) | the API token or account id is wrong |

Pull requests run the gates only. Pushes to `master` also deploy.

Rendered diagrams are cached on the hash of the markdown, so a run that changes prose but
no diagrams reuses all 607 SVGs and finishes in well under a minute. A cold cache renders
everything and takes roughly ten.

### One-time setup

1. **No project to create.** The site deploys as a **Worker with static assets**, configured
   by [`wrangler.toml`](wrangler.toml) at the repo root. `wrangler deploy` creates the Worker
   on its first run, so there is no separate project-creation step and no
   `Project not found` failure to hit.

2. **Create an API token** — Cloudflare dashboard → *My Profile* → *API Tokens* → *Create
   Token* → **Edit Cloudflare Workers** template. That template already grants
   `Account · Workers Scripts · Edit`, which is what `wrangler deploy` needs. Copy the
   token; it is shown once.

3. **Find your account ID** — Cloudflare dashboard → *Workers & Pages*; it is in the right
   sidebar and in the dashboard URL.

4. **Add both as repository secrets** — GitHub repo → *Settings* → *Secrets and variables*
   → *Actions* → *New repository secret*:

   | Secret | Value |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | the token from step 2 |
   | `CLOUDFLARE_ACCOUNT_ID` | the ID from step 3 |

5. **Point `SITE_ORIGIN` at the real domain** once DNS is live — it is an `env:` value at
   the top of the workflow and is baked into `sitemap.xml`.

---

## 1. Building locally

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

> `site/` is gitignored — CI builds it. Build locally only to preview, or to deploy by
> hand with the fallback in section 2b.

---

## 2. Publishing

### 2a — GitHub Actions (the normal path)

Push to `master`. The workflow validates, builds and deploys, and you get
`https://interviewvault.shubhchak.workers.dev`, and `https://cartmancodes.com` once section 3 is done.
Setup is in section 0.

Do **not** also connect Cloudflare's own Git integration to this repo — it would try to
build a second time and find no `site/` folder to serve.

### 2b — Deploy from your machine (fallback)

Useful when CI is down, or to publish something without pushing:

```bash
cd tools && node render-diagrams.mjs && node build-site.mjs && cd ..
export CLOUDFLARE_API_TOKEN=<token>
npx wrangler deploy            # reads wrangler.toml, uploads site/
npx wrangler deploy --dry-run  # validate without publishing
```

> **`_headers` and `_redirects` are a Pages convention.** Under Workers Static Assets they
> may be ignored, so the long-lived caching for `/assets/*` is not guaranteed. Check after
> the first deploy:
>
> ```bash
> curl -sI https://interviewvault.shubhchak.workers.dev/assets/site.css | grep -i cache-control
> ```
>
> If the header is missing, add a small Worker script to set it around the asset fetch.

---

## 3. Point cartmancodes.com at it

`cartmancodes.com` is already on Cloudflare nameservers (`kareem` / `peaches.ns.cloudflare.com`),
so no nameserver change is needed. The apex and `www` still carry the A/AAAA records for the
old **GoDaddy Website Builder** site, which is why adding the custom domain reports:

> Hostname 'cartmancodes.com' already has externally managed DNS records (A, CNAME, etc).
> Delete them first or try a different hostname.

Cloudflare will not overwrite records it did not create. Removing them **takes the old GoDaddy
site offline permanently** — export anything worth keeping first, and cancel the Website
Builder plan separately if you no longer want to be billed for it.

### Steps

1. Cloudflare dashboard → **Websites** → `cartmancodes.com` → **DNS** → **Records**.
2. Delete every apex and `www` record that resolves the site:

   | Type | Name | Note |
   |---|---|---|
   | `A` | `@` | points at GoDaddy hosting |
   | `AAAA` | `@` | points at GoDaddy hosting |
   | `A` / `AAAA` / `CNAME` | `www` | the `www` variant of the same |

   Leave `MX`, `TXT` (SPF/DKIM/domain verification) and any other subdomains alone —
   deleting those breaks email and third-party verifications.

3. Cloudflare → **Workers & Pages** → `interviewvault` → **Settings** → **Domains & Routes**
   → **Add** → `cartmancodes.com`. Repeat for `www.cartmancodes.com`.

Cloudflare recreates the correct records itself and issues the certificate. The apex is
CNAME-flattened to the Worker, so it works without an A record.

Propagation is usually a minute or two; the certificate can take a few minutes more.

### Verifying

```bash
dig +short cartmancodes.com                 # Cloudflare anycast IPs
curl -sI https://cartmancodes.com | head -1 # HTTP/2 200
curl -s https://cartmancodes.com | grep -o '<title>[^<]*'
```

If you still see GoDaddy assets (`img1.wsimg.com`) in the response, a stale record survived —
recheck step 2.

---

## 4. After it is live

- `SITE_ORIGIN` in the workflow is already `https://cartmancodes.com`, so `sitemap.xml`
  carries the real domain on the next CI run.
- **Verify the response headers.** `site/_headers` and `site/_redirects` are a Pages
  convention and may be ignored by Workers Static Assets — confirm the immutable caching on
  `/assets/*` actually arrives (see the note in section 2b) before relying on it.
- `not_found_handling` and `html_handling` are set in [`wrangler.toml`](wrangler.toml), not
  in the dashboard.

---

## Rebuilding after you edit the docs

Just commit the markdown and push — CI rebuilds and redeploys.

To preview the change first:

```bash
cd tools && node render-diagrams.mjs && node build-site.mjs
cd ../site && python3 -m http.server 8899
```

Only new or changed mermaid diagrams re-render; everything else comes from cache.

## Running the CI gates locally

```bash
python3 tools/check-python.py    # every ```python block parses
cd tools && node render-diagrams.mjs && node build-site.mjs && cd ..
node tools/check-site.mjs        # no broken links, missing assets or dead anchors
```
