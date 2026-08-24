# Domain cutover — moving ZenPDF onto its own apex

**What this is.** The runbook for the day the owner's custom domain exists. It
covers Phase 11's workstream **11A** end to end: one commit, one Railway
env-var sweep, and a verify list. Everything in it was **parameterised in
advance on 2026-08-24** (`feat/phase-11-guides-and-contact`) so that this is a
procedure rather than a project — the code change is two lines and a comment
block that is already written and already validated.

**What it is not.** It is not the Cloudflare session that makes the domain
exist. That is owner work and it is written down in
`development-plans/phase-11-adsense-review.md` under **P1** — nameservers,
both custom domains on the `web` service, the CNAME *and* the ownership TXT
record for each, grey cloud, the Search Console TXT, and Email Routing. Do
that first. Nothing below works until Railway shows both domains verified and
a certificate issued.

Throughout, `<apex>` is the bare domain (`example.com`) and `www.<apex>` is the
alias that redirects to it. **The apex is canonical.** That decision is baked
into `SITE_URL`, into nginx and into DNS, and changing it later resets
canonicals, Search Console history and the AdSense site entry — so it is made
once, here, and not revisited.

---

## 0. Before you touch anything

- [ ] Railway → `web` → Settings → Networking shows **both** `<apex>` and
      `www.<apex>` with a certificate issued (not "waiting for DNS"). If a
      domain says it is unverified, the ownership **TXT** record is the usual
      cause — Railway needs the CNAME *and* the TXT, and with the TXT missing
      the domain never verifies and requests 404.
- [ ] `curl -sI https://<apex>/health` answers `200`. If it does not, stop:
      everything below assumes the new hostname already reaches the container.
- [ ] The working tree is clean and `main` is up to date. This lands as one
      commit on `main`, and a push to `main` **is** the deploy.

## 1. The commit

Three files, one commit.

**a. `frontend/src/app/core/site.ts`** — the origin, in the one place it is
written down:

```ts
export const SITE_URL = 'https://<apex>';
```

Nothing else in `frontend/src` or `frontend/tools` carries the host. That was
checked on 2026-08-24 and it is worth re-checking in thirty seconds rather
than trusting this sentence:

```bash
grep -rn "zenpdf.up.railway.app" frontend/src frontend/tools
# expected: exactly one hit, frontend/src/app/core/site.ts
```

Every canonical, `og:url`, JSON-LD `url`, sitemap `<loc>` and the `Sitemap:`
line in `robots.txt` derives from that constant.

**b. `frontend/src/app/core/site.ts`** — the support address, in the same file
and the same commit:

```ts
export const SUPPORT_EMAIL = 'support@<apex>';
```

It currently reads `yuval3000+support@gmail.com`, which is a placeholder with
a plus-tag on the owner's own inbox, chosen deliberately because a mailbox is
the one thing 11A cannot be parameterised around. Swap it only once Cloudflare
Email Routing is forwarding `support@<apex>` **and the destination-confirmation
mail has been clicked** — an address on `/contact` that bounces is worse than
a personal address that works.

**c. `infra/railway/nginx.railway.conf`** — uncomment the redirect block at the
bottom of the file and replace `<apex>`:

```nginx
server {
    listen 80;
    server_name zenpdf.up.railway.app www.<apex>;
    return 301 https://<apex>$request_uri;
}
```

> ⚠ **Do not move it, and do not remove `default_server` from the block above
> it.** The app block carries `listen 80 default_server;` explicitly. If the
> redirect block ends up first, or `default_server` is dropped, nginx makes the
> *redirect* block the default server — and then the apex Host, which matches
> no `server_name` (it is the redirect target, not a listed name), falls into
> it. **This was measured, not reasoned about**, on 2026-08-24 against a real
> nginx with both orderings:
>
> | Request | Correct order | Wrong order |
> |---|---|---|
> | `Host: <apex>` `/` | `200` | **`301` → itself (loop)** |
> | Railway healthcheck `/health` | `200` | **`301` (every deploy fails)** |
> | `Host: zenpdf.up.railway.app` `/merge-pdf` | `301` → apex | `301` → apex |
> | `Host: www.<apex>` `/` | `301` → apex | `301` → apex |
>
> The healthcheck row is the one that costs you an afternoon: Railway sends its
> own Host to `location = /health`, so a misordered config fails the deploy
> that contains it, and the failure looks like a broken app rather than a
> broken redirect.

The absolute `https://<apex>` in the `return` is deliberate. `$scheme` is
`http` inside the container because Railway's edge terminates TLS, so
`$scheme://` would redirect https traffic down to http — the same trap
`absolute_redirect off` already fixes for directory redirects.

**d. Regenerate and commit the artifacts.**

```bash
cd frontend && npm run build           # prebuild regenerates sitemap.xml + robots.txt
git add public/sitemap.xml public/robots.txt
npm test                               # seo-artifacts.spec.ts pins these byte-for-byte
npm run verify:prerender
```

`seo-artifacts.spec.ts` fails the build if the committed artifacts drift from
what the tables generate, so an un-regenerated sitemap cannot ship quietly.

**e. Docs sweep, same commit.** `docs/ops/railway-handoff-claude-cli.md` (H2's
`BASE_URL` and the custom-domain row) and anywhere else
`zenpdf.up.railway.app` appears as "the site" rather than as a historical
record. Tick the custom-domain item in `docs/09-adsense-readiness.md`.

Push. `infra/railway/**` is in the watch patterns for **every** service, so
this commit rebuilds `web` *and* the five Django services. That is expected and
harmless; it is also why the env sweep below is a separate step.

## 2. The Railway env sweep

Env-var only — no code, so `serviceInstanceDeployV2` is the right tool and
`redeploy` is **not** (`docs/ops/railway.md` has the trap). Apply to the five
Django services (`api`, `worker-default`, `worker-heavy`, `worker-render`,
`beat`) unless a row says otherwise.

| Variable | New value | Why it matters |
|---|---|---|
| `ALLOWED_HOSTS` | add `<apex>`, `www.<apex>` | Django rejects an unknown Host outright |
| `CSRF_TRUSTED_ORIGINS` | add `https://<apex>`, `https://www.<apex>` | |
| `FRONTEND_BASE_URL` | `https://<apex>` | **Every signing, verification and unsubscribe link is built from this.** Miss it and invitations keep minting on the old host |
| `API_BASE_URL` | `https://<apex>` | same; defaults to `FRONTEND_BASE_URL` if unset |
| `ABUSE_CONTACT_EMAIL` | `abuse@<apex>` | printed in mail footers and in the terms |
| `DEFAULT_FROM_EMAIL` | `ZenPDF <no-reply@<apex>>` | appears in headers even with SMTP off |
| `CORS_ALLOWED_ORIGINS` | update if set | belt-and-braces: nginx same-origin-proxies `/api/` |

Leave the frontend `SITE_URL` **environment variable** unset. It is a
preview-host escape hatch for the generator, not the production path — the
production value is the constant in `core/site.ts` you just changed.

## 3. Verify — all mechanical

```bash
# 301s, both of them, preserving the path
curl -sI https://zenpdf.up.railway.app/merge-pdf | head -1
curl -sI https://www.<apex>/merge-pdf | head -1
# expected: 301, Location: https://<apex>/merge-pdf

# the apex itself must NOT redirect
curl -sI https://<apex>/ | head -1            # 200

# canonicals name the apex
for p in "" merge-pdf about contact guides; do
  curl -s https://<apex>/$p | grep -o 'rel="canonical" href="[^"]*"'
done

# artifacts
curl -s https://<apex>/robots.txt | grep Sitemap:
curl -s https://<apex>/sitemap.xml | grep -c "<loc>https://<apex>/"   # 43
curl -sI https://<apex>/ads.txt | head -1
curl -s https://<apex>/api/health/                                     # status ok
```

- [ ] The Railway deploy went green (the healthcheck is the redirect-ordering
      canary — if it failed, re-read §1c before anything else).
- [ ] A guest upload → download round-trip works on the new origin.
- [ ] Send a real mail to `support@<apex>` and see it arrive. Forwarding
      proven, not assumed — this is the acceptance criterion Phase 11 leaves
      open until it is done.

## 4. Search Console (owner)

The **domain property** (verified by the TXT record from P1) covers apex, www
and both protocols. Submit `sitemap.xml`. Use URL Inspection to request
indexing for the landing page, the ten highest-value tool slugs, `/about`,
`/contact`, `/guides` and the guide slugs.

The old host was never a GSC property, so there is no change-of-address to
file — the 301s plus the new canonicals consolidate whatever Google picked up
from it. Optionally spot-check `site:zenpdf.up.railway.app` a few weeks later.

## 5. Afterwards

Phase 11's remaining criteria in `development-plans/PROGRESS.md` become
tickable: the 301s, the canonical sweep, and the `support@<apex>` mail test.
11D (the indexing bake, with its submission gate — a majority of guides and
≥ 10 tool pages indexed, **or** four weeks with zero crawl errors, whichever
comes first) starts the day this lands. 11E is the application, and
`ADS_ENABLED` stays `false` throughout: site verification proves control, and
no ad code needs to load for a review.

## Rollback

Revert the commit and push. The 301s stop, the canonicals go back to the old
host, and the env sweep can be reverted at leisure — nothing in it is
destructive, and the old host keeps working throughout because it is a Railway
subdomain that is never released.
