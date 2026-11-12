# SafarFill licence server — API for the extension (v1.10.0)

Base URL: `https://safarfill-api.azeemhfd.workers.dev`
Worker name `safarfill-api`, D1 database `safarfill` (binding `DB`). Separate from `fq-relay`: no shared code, database or secrets.
Secrets: `ANTHROPIC_KEY`, `ADMIN_KEY`, `SIGNING_KEY`, `RULES_PRIVATE_KEY` (v1.9.0; names only).
Cron Trigger (v1.9.2): daily, e.g. `0 2 * * *` — deletes activity and AI-call logs older than 90 days.
Dashboard: `/admin` (password = `ADMIN_KEY`).

All answers are JSON. Errors: `{ ok: false, error: "<code>", message: "<text to show the user>" }`. Show `message` as is.

## Plans (server defaults)
| Plan | Length | AI reads | Computers | Portals |
|---|---|---|---|---|
| trial | 2 days from first use (you can set other days) | **0: built-in reader only** (you can give 5–10 AI test reads) | 1 | all |
| starter | 30 days | 300 / month | 1 | one, chosen per key |
| standard | 30 days | 800 / month | 1 | all |
| owner | never ends | no limit | 5 | all |

Portal ids: `akbar`, `alhind`, `airsial`, `muqeem`. The built-in reader is unlimited on every plan.

## POST /v1/session
Start or refresh. Call when the popup opens if there is no pass or it ends within 12 hours, after the user types a key, and after any `pass_invalid` error.

Request: `{ "key": "SF-XXXX-XXXX-XXXX", "device": "<random id made once at install, 8–64 of A-Z a-z 0-9 ->", "version": "1.1.0" }`

Answer: `{ ok: true, pass, pass_expires, licence: { plan, agency, portals: [...], expires_at, ai_quota, ai_used, ai_left }, support: { whatsapp, email }, rules_version, portal_status }`
- `rules_version`: the rules version this licence would get from /v1/rules (null if none). `portal_status`: see Portal switch below.
- `pass` goes in `Authorization: Bearer <pass>` on every other call. It lasts up to 24 hours: the extension may keep working **offline** until `pass_expires`.
- `expires_at` / `ai_left` are `null` for no limit.

Errors: `bad_key`, `unknown_key`, `blocked`, `expired`, `trial_over`, `device_limit`, `too_many`.

## POST /v1/parse  (Bearer pass)
Turns OCR text into passport fields. The parsing logic lives only on the server.
- Page read: `{ "lines": ["...", "..."] }` (OCR text lines of one page, top to bottom; send only lines of 20+ characters; up to 40, the server examines 12)
  → `{ ok: true, pick: { i1, i2, score } | null, parsed: <parseMrz result> | null }` (`i1`/`i2` index into the lines you sent; `i1` is -1 if no first line)
- Closer read: `{ "pairs": [["line1", "line2"], ...] }` (up to 6) → `{ ok: true, results: [<parseMrz result>, ...] }` in the same order. Pick the best one yourself (valid first, then higher score).
- Both may be sent in one call.
- **Counting reads:** send header `X-Read-Start: 1` on the **first** /v1/parse call for each passport page only. The dashboard's "Reads" counts those headers (= pages read), not calls. All calls are still rate-limited: 240 calls per minute per licence.

`parseMrz result` is exactly what `lib/mrz.js` returned before: `{ valid, passed, score, checks, problems, doubt, lines, fields: { surname, givenNames, passportNo, nationalityCode, issuingCode, dob, sex, expiry, cnic } }`.

Errors: `pass_invalid`, `blocked`, `expired`, `trial_over`, `device_removed`, `too_many`.

## POST /v1/ai  (Bearer pass)
Reads one passport/iqama image with the AI using the server's key. Nothing is stored.
- Body: the image as **plain base64 text** (no `data:...;base64,` prefix). Header `X-Image-Type: image/jpeg` (or png/webp). Optional `X-Model: sonnet | haiku` (default sonnet).
- Shrink the image before sending: longest side 1600 px, JPEG quality 0.85.
- Answer: `{ ok: true, fields: <same object the record_passport tool returned before>, ai_left }`
- `{ ok: false, error: "no_details", ai_left }` = the AI answered without details (it still counts). Show the message; never retry by itself.

Errors: `ai_not_in_plan` (402: AI is off on this licence, e.g. a trial; show the message: "Read with AI is not included in the free trial. Contact Sahl Labs to try it."), `quota` (402), `bad_image`, `too_large`, `ai_busy`, `ai_unavailable`, `ai_refused`, `too_many`, plus the licence errors above.

**AI call log (v1.7.0):** every POST /v1/ai is recorded per computer: time, licence key, device id (from the pass), extension version, result (`ok`, `no_details`, `quota`, `ai_not_in_plan`, or another error code), `ai_left` after the call, and the image size. The image and passport details are never stored. Nothing changes for the extension.

## POST /v1/fill  (Bearer pass)
"May I fill?" Call it **every time Fill form is pressed**, before filling. Fill only when the answer is `ok: true`.
- Body: `{ "portal": "akbar" | "alhind" | "airsial" | "muqeem" }`
- Answer: `{ ok: true }` (the server counts one form filled for the dashboard).
- Errors: `portal_not_in_plan` (403), **`portal_paused` (423)**: the portal is switched off in the dashboard (e.g. its page changed); `message` is the text to show. `too_many`, plus the licence errors above. Show the message and do not fill.
- Offline (network error): do not fill; show "No internet connection. SafarFill needs the internet to check your licence."

## Version check (all calls)
Send the extension's version in `/v1/session` (`"version": "1.1.0"`). If you set a minimum version in the dashboard, older versions get `update_required` (426) on every call. Show the message; it tells the user to update.

## GET /v1/support
`{ ok: true, whatsapp, email, website, announcements }`. `website` = `"https://sahllabs.com"`. `announcements` = `[{ id, level: "info"|"warning"|"urgent", text, link|null, until|null }]`: **plain text, never HTML** (show with textContent). Without an Authorization header only the "everyone" messages are returned; with `Authorization: Bearer <pass>` also the messages for that licence's plan and for that licence. Ended messages (`until` passed) are left out.
Earlier fields: No licence needed, so the licence screen can show it before a key is entered or after a licence ends. `whatsapp` is digits with country code (e.g. `966512345678`); open `https://wa.me/<whatsapp>`. Empty string = not set: hide that button. Cache the last answer in chrome.storage.local for offline use.

## GET /v1/rules  (Bearer pass)  — Phase 2, v1.9.0
Rules are **data only** (never code). Answer: `{ ok: true, version, payload, sig, portal_status }`
- `payload`: a JSON **string** = exactly the bytes that were signed: `{ schema: 1, version, issued_at, airlines: [...], messages: { key: text }, portals: { <portal id>: <recipe JSON> } }`. `portals` contains only the portals in that licence's plan.
- `sig`: base64 of the raw 64-byte ECDSA P-256 signature (r‖s, the WebCrypto format) over the UTF-8 bytes of `payload`, SHA-256. Verify with the public key built into the extension:
  ```js
  const key = await crypto.subtle.importKey('jwk', PUBLIC_JWK, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key,
    Uint8Array.from(atob(sig), (c) => c.charCodeAt(0)), new TextEncoder().encode(payload));
  ```
  Use the rules only if `ok` and `JSON.parse(payload).version` is **not lower** than the version already stored (a roll back is released as a new, higher version).
- `?have=N`: when N is already the newest for this licence the answer is `{ ok: true, version: N, unchanged: true, portal_status }` (no payload).
- Which version: the newest **released** one; a licence marked "rules tester" gets the newest **test** version if it is newer.
- `portal_status`: `{ akbar: { on: true }, alhind: { on: false, message }, ... }` (also in /v1/session).
- Errors: `no_rules` (404), `rules_not_ready` (503: RULES_PRIVATE_KEY not set), plus the licence errors.
- Seed: version 1 = safarfill-airline-rules-v1.json (34 airlines, no portals), released.

## Portal switch (v1.9.2)
Dashboard → Portals & messages: each portal can be paused for every agency, with the message agents see (default `"<Portal> filling is paused for an update. Fill by hand for now."`). While paused, `/v1/fill` answers **423 `portal_paused`** with that message. Works with SafarFill 1.1.x already (it shows the server message and does not fill).

## Activity log (v1.9.2)
One row per action, kept **90 days** (daily Cron Trigger): time, licence key, computer id, SafarFill version, IP (CF-Connecting-IP), city + country (Cloudflare), action: `session`, `parse page` (only calls with X-Read-Start), `fill` + portal, `refused` + `<what>: <error code>`. AI calls stay in `ai_calls` (now also with IP, city, country) and are shown merged. Never passport details or images.
- Dashboard per licence: each computer's last IP and place; the last 100 actions.
- Needs your attention: one key used from **two countries** on the same (Saudi) day (`geo_country`, warning); from two cities (`geo_city`, info only: mobile internet often shows the wrong city); one computer from **more than 5 IPs** in a day (`ip_many`).

## GET /v1/ping
`{ ok: true, version }`. No licence needed.

## Dashboard (v1.3.0)
- **Needs your attention**: expired / ending licences, trials just ended, AI limit used or nearly used, agencies asking for another computer, trial agencies that pressed Read with AI, and AI service failures. Each has one-click fixes.
- **Activity**: everything that happened, including refused attempts and what the agent was shown. The same refusal is recorded once per hour per licence.
- **Forms filled** per licence and per month (counted by /v1/fill).
- **Settings → Oldest SafarFill version allowed**: older versions must update.
- **Settings → Support WhatsApp / email**: shown in SafarFill as "WhatsApp us" / email.
- Actions: Payment received (+30 days), + days, change plan, AI test (5/10, trials), +100 AI reads, +1 computer, block/unblock, remove one or all computers, **Delete key** (permanently removes a key with its computers, usage and history; for test keys).
- **Monthly price = plan + add-ons − discount**, worked out by the server and shown as a breakdown in the create and edit forms.
  - Plan: Starter 79, Standard 149; trial and owner are free.
  - Add-ons (defaults, editable in Settings → Add-on prices): extra portal 30 (Starter only; Starter includes 1), extra computer 25 (beyond the plan's), 100 AI reads 15 (beyond the plan's, per started 100).
  - Discount per licence: SAR (`20`) or percent (`10%`).
  - The price is recalculated whenever a licence changes (+1 computer, +100 AI reads, plan change, edit). New add-on prices apply to a licence the next time it changes.
  - Older databases: a typed price lower than the new sum becomes that licence's discount, so nobody's price changes.
- **Quotes**: fill in the create form and press **Save as quote** (Starter or Standard). Each quote gets a number (Q-0001), is valid 7 days, and is saved with its exact price breakdown. In the Quotes list:
  - **PDF**: a branded A4 quotation, saved through Chrome's print → Save as PDF. It shows the breakdown, what's included, how to pay (Settings → Payment details) and the support contact.
  - **Copy text**: the same quote as a WhatsApp message.
  - **Accept → key**: makes the licence with exactly the quoted settings and price, even if the add-on prices changed since.
  - **Declined**: marks it declined. Status: sent / accepted / declined / expired.
- **AI reads per computer** on each licence: AI reads this month and in total (answered calls: ok or no_details), all AI calls, last call; plus the **last 50 AI calls** with time, computer, version, result, AI left and image size.
- **Needs your attention** also shows a computer with **more than 30 AI calls in one hour** (`ai_burst`), or **more than 5 refused AI calls (quota / not in plan) in one hour** (`ai_refused_burst`). Each is raised at most once per hour per licence.
- Delete key also removes that key's AI call log.
- **Computer names (v1.8.0)**: in a licence's Computers list, type a name for each computer (e.g. "Front desk", "Win7 PC") and press Save. Names show in the computer, AI-per-computer and AI-call lists and in the history ("Computer added (KeGhUhm8 · Front desk)"). A name is kept when a computer is removed, so it comes back if that computer enters the key again. Empty name = remove it. Nothing changes for the extension.
- **Tabs (v1.9.2)**: Licences / Rules / Portals & messages.
- **Rules**: list of versions (draft, test, released, retired); open a version; **New version from this** (draft copy); edit airlines, messages and each portal recipe as JSON; **Check** validates; **Save draft**; **Send to testers** (one test version at a time); **Release to all** (the previous release becomes retired); **Roll back to this** (re-releases an older version's rules as a NEW, higher version); delete a draft. Only drafts can be edited. Validation: airlines = list of { id (unique), name, rule, names [text], codes [text] }; messages = key: text (max 300); portals = akbar / alhind / airsial / muqeem, valid JSON, max 200 KB each; whole bundle max 900 KB.
- **Signing key** card: shows the public key (from RULES_PRIVATE_KEY) and makes a new key pair **in the browser** (nothing sent to the server): the private key goes into the Cloudflare secret RULES_PRIVATE_KEY, the public key into the extension.
- **Rules tester** checkbox on each licence.
- **Portal switches** and **Messages to agents** (text max 300, level, optional https link, optional end date, target everyone / plan / licence).
- Delete key also removes that key's activity log and its own messages.
- **Licence panel (v1.9.2)**: Copy key and Copy WhatsApp message buttons next to the licence title.

## Removed computers (v1.9.3)
- **Remove** on a computer now also records it in `removed_devices`. That computer can no longer join again with the key still saved on it: `/v1/session` answers 403 `device_removed` ("This computer was removed from your licence. Contact Sahl Labs."), counts the try and raises the "removed computer is still trying" alert. Before v1.9.3 it was silently added back the next time SafarFill opened there.
- The licence panel shows **Removed computers** (computer, removed, last try, tries) with **Allow again** (admin action `allow_device` `{ key, device }`); then SafarFill's **Try again** works on that computer.
- A new computer can still join with the key as normal, up to the computer limit. **Remove all computers** (`reset_devices`) does not block: it is for freeing slots, and computers can join again.
- Delete key also clears its removed-computers list.

## Portal recipes, phone rules and theme (v1.10.0, for SafarFill 1.3.0)
- Rules bundles may carry `phone` (max 20 KB) and `theme` (max 10 KB) next to `airlines`, `messages`, `portals`. `/v1/rules` puts them in the signed payload when present (portals still only those in the licence's plan). SafarFill 1.2.x ignores them.
- **Check / Save / Send to testers / Release** refuse any value SafarFill 1.3 would ignore — same checks as the extension (`src/rules-check.js` is copied from SafarFill 1.3.0 `lib/recipes.js`, `lib/phone.js`, `lib/theme.js`; keep it in step). Recipes must have `"recipe": 1`; unknown keys, wrong types, bad selectors (`<`, `{`, `}`), bad ids/control names, date formats outside the list, bad colours, logo hosts other than sahllabs.com / www.sahllabs.com / safarfill-api.azeemhfd.workers.dev, and the key names `__proto__`, `prototype`, `constructor` are refused. A phone note key needs a text in Messages (except the built-in phone_unknown / phone_not_offered / phone_unsure). An empty `phone.local` list is refused.
- Formats: project doc `claude/safarfill-v1.3-formats.md`. Starting values (= SafarFill 1.3 built-in): `src/rules-v1/*.json`.
- Rules tab: **New draft with SafarFill 1.3 starting values** (live rules + the four recipes, phone, theme and the 10 new texts, added only where missing); **Phone rules** and **Theme** boxes; Phone/Theme columns in the versions list.
- `POST /v1/fill` accepts `rules_ignored`: up to 20 paths (max 80 chars, only letters, digits, `_ . -` kept) of rules values SafarFill could not use. Logged in the licence's Activity as `rules_ignored` ("rules vN: path, path …") and raised as a warning in Attention.
