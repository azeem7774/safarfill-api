# SafarFill licence server — API for the extension (v1.6.2)

Base URL: `https://safarfill-api.azeemhfd.workers.dev`
Worker name `safarfill-api`, D1 database `safarfill` (binding `DB`). Separate from `fq-relay`: no shared code, database or secrets.
Secrets: `ANTHROPIC_KEY`, `ADMIN_KEY`, `SIGNING_KEY` (names only).
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

Answer: `{ ok: true, pass, pass_expires, licence: { plan, agency, portals: [...], expires_at, ai_quota, ai_used, ai_left }, support: { whatsapp, email } }`
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

## POST /v1/fill  (Bearer pass)
"May I fill?" Call it **every time Fill form is pressed**, before filling. Fill only when the answer is `ok: true`.
- Body: `{ "portal": "akbar" | "alhind" | "airsial" | "muqeem" }`
- Answer: `{ ok: true }` (the server counts one form filled for the dashboard).
- Errors: `portal_not_in_plan` (403), `too_many`, plus the licence errors above. Show the message and do not fill.
- Offline (network error): do not fill; show "No internet connection. SafarFill needs the internet to check your licence."

## Version check (all calls)
Send the extension's version in `/v1/session` (`"version": "1.1.0"`). If you set a minimum version in the dashboard, older versions get `update_required` (426) on every call. Show the message; it tells the user to update.

## GET /v1/support
`{ ok: true, whatsapp, email }`. No licence needed, so the licence screen can show it before a key is entered or after a licence ends. `whatsapp` is digits with country code (e.g. `966512345678`); open `https://wa.me/<whatsapp>`. Empty string = not set: hide that button. Cache the last answer in chrome.storage.local for offline use.

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

