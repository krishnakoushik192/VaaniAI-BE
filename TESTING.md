# Testing the backend by hand

This guide walks through every API on your own machine before deploying to Vercel.
Allow about 15 minutes. Money is always in **paise** (₹1 = 100, so `6000` = ₹60).

## 0. Before you start

`.env` must contain these values (see `.env.example`):

```
MONGODB_URI=...        # your Atlas connection string
MONGODB_DB=vanni
JWT_SECRET=...         # long random string
GNANI_API_KEY=...      # speech-to-text
LLM_API_KEY=...        # Google AI Studio (Gemini) key
# GEMINI_MODEL=gemini-3.5-flash-lite   (optional, this is the default)
```

Install packages once:

```bash
npm install
```

Run the commands below in **Git Bash** (it comes with Git for Windows). In PowerShell, `curl` means something else and the quoting is different.
If you prefer clicking, you can paste the same URLs, headers and bodies into Postman or the Thunder Client extension in VS Code.

---

## 1. Automatic checks (no Atlas needed)

These run against a temporary in-memory database and delete it when done.

| Command | What it checks | Costs credit? |
|---|---|---|
| `npm run typecheck` | the code has no type errors | no |
| `npm run smoke` | login, customers, bills, payments, dues, lockout | no |
| `npm run make-audio` | creates 4 sample voice clips in `test-audio/` (English, Hindi, Telugu) with Gnani text-to-speech | a little Gnani credit |
| `npm run voice-test` | sends each clip through `/api/voice/bill` with your **real** Gnani + Gemini keys and prints what was understood | a little Gnani credit, Gemini free tier |

Expected output from `npm run voice-test` (each clip about 2 seconds):

```
━━ te-ramesh-khata.wav  HTTP 200
  heard (te-IN): రమేష్, రెండు కిలోల బియ్యం కిలో అరవై రూపాయలు ...
  customer: Ramesh (spoken: రమేష్)   method: khata
   • Rice                 2 kg     ×    ₹60.00 =   ₹120.00
   • Oil                  1 L      ×   ₹145.00 =   ₹145.00
   • Soap                 3 pc     ×    ₹40.00 =   ₹120.00
  total ₹385.00   needsCheck 0
```

If these pass, the code is fine. The steps below check your real Atlas database and let you try your own voice.

---

## 2. Start the server (uses your Atlas DB)

```bash
npm run dev
```

You should see `vanni-backend listening on http://localhost:4000`. Keep this window open and open a **second** Git Bash window for the commands below.

```bash
curl http://localhost:4000/api/health
```

→ `{"status":"ok","db":false}`. `db` turns `true` after the first real request.

## 3. Register and log in

Register once. Use your own number in place of the example mobile number.

```bash
curl -X POST http://localhost:4000/api/auth/register \
  -H "content-type: application/json" \
  -d '{"shopName":"Sri Lakshmi Kirana","shopkeeperName":"Koushik","mobileNumber":"9876543210","passcode":"1234","language":"te"}'
```

→ `201` with `token` and `shopkeeper`. **Check in Compass:** `vanni → shopkeepers` now has the record. `passcodeHash` is a long hash, never `1234`.

Log in and keep the token in a variable:

```bash
TOKEN=$(curl -s -X POST http://localhost:4000/api/auth/login \
  -H "content-type: application/json" \
  -d '{"mobileNumber":"9876543210","passcode":"1234"}' | node -pe "JSON.parse(require('fs').readFileSync(0)).token")
echo $TOKEN
```

If you open a new terminal, run this login command again. The `$TOKEN` variable only exists in the window where you set it.

Things to try:
- Wrong passcode → `401 Wrong mobile number or passcode`.
- 5 wrong passcodes → `429`, and the account is locked for 15 minutes.
- Register the same number again → `409`.

## 4. Customers

```bash
curl -X POST http://localhost:4000/api/customers \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"customerName":"Ramesh","phoneNumber":"9000000011","openingDue":50000}'
```

→ `201`. Copy the `id` from the response:

```bash
RAMESH=<paste the id here>
curl -H "authorization: Bearer $TOKEN" "http://localhost:4000/api/customers?search=ram"
curl -H "authorization: Bearer $TOKEN" http://localhost:4000/api/shopkeeper/me
```

`shopkeeper/me` now shows `duesTotal: 50000` (₹500 opening due).

## 5. Voice → bill draft

**Use your own voice:** record a clip of up to 30 seconds with Windows **Voice Recorder** (it saves `.m4a`) or your phone, then copy it into the `vanni-backend` folder. Say something like:
*"Ramesh, two kilo rice sixty rupees per kilo, one litre oil one forty five, put it on khata."*
Telugu, Hindi and mixed speech all work.
Or use a generated clip from `test-audio/` (made by `npm run make-audio`).

**a) Speech-to-text only**

```bash
curl -X POST http://localhost:4000/api/voice/transcribe \
  -H "authorization: Bearer $TOKEN" \
  -F "audio=@test-audio/te-ramesh-khata.wav"
```

→ `{ "transcript": "రమేష్, రెండు కిలోల ...", "detectedLanguage": "te-IN", ... }`

**b) Text → bill (no audio, handy for trying many sentences quickly)**

```bash
curl -X POST http://localhost:4000/api/voice/extract \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"transcript":"Ramesh ki do kilo chawal 60 rupaye kilo aur ek litre tel 145, khate mein likh do"}'
```

**c) Full flow: audio → transcript → bill draft** (this is what the app will call)

```bash
curl -X POST http://localhost:4000/api/voice/bill \
  -H "authorization: Bearer $TOKEN" \
  -F "audio=@test-audio/te-ramesh-khata.wav"
```

Optional form fields:
- `-F "customerId=$RAMESH"`: you already know the customer, so name matching is skipped.
- `-F "languages=te-IN,en-IN"`: language hints. The default comes from the shop's `language`.

How to read the response:

| Field | Meaning |
|---|---|
| `transcript` | what Gnani heard |
| `draft.customer` | the matched existing customer, or `null` |
| `draft.method` | `cash` / `upi` / `khata`, or `null` if it wasn't said |
| `draft.items[]` | `name, qty, unit, rate` (paise per unit) and `lineTotal` |
| `draft.items[].needsCheck` + `notes` | ⚠ the shopkeeper must confirm this line. Examples: price not heard, spoken total doesn't match qty × rate |
| `draft.total` | computed by the server, never by the AI |
| `draft.warnings` | e.g. the customer name isn't in your list, or khata has no customer |

**Nothing is saved yet.** A draft is only a suggestion.

Things to try:
- Say an amount that doesn't add up ("2 kilo onion 30 per kilo, total 80"). You should see a `needsCheck` line with the note `Said ₹80 but 2 × ₹30 = ₹60`.
- Leave out a price ("some dal"). You should get `rate: null` and the note `Price not heard`.
- Say a name that isn't saved yet. You should get `customer: null` plus a warning.
- Send a non-audio file → `400`. Send a clip longer than 30 s → `400 MAX_AUDIO_DURATION_EXCEEDED`.

## 6. Save the bill

After review, the app saves the draft's items. Copy `name, qty, unit, rate` for each item from the draft:

```bash
curl -X POST http://localhost:4000/api/transactions \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"kind":"bill","txnId":"test_bill_1","customerId":"'$RAMESH'","method":"khata",
       "items":[{"name":"Rice","qty":2,"unit":"kg","rate":6000},{"name":"Oil","qty":1,"unit":"L","rate":14500}]}'
```

→ `201`, `transaction.amount: 26500` (₹265), Ramesh's `pastDues: 76500`.

- Run the **same command again** → `200` with the same result. The same `txnId` is never saved twice.
- **Check in Compass:** the customer's `recentTransactions` holds the bill. The shopkeeper's `todaysBill`, `weeklyBill`, `todaysDues` and `duesTotal` went up.

Record a payment:

```bash
curl -X POST http://localhost:4000/api/transactions \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"kind":"payment","txnId":"test_pay_1","customerId":"'$RAMESH'","method":"upi","amount":20000}'
```

→ Ramesh's `pastDues` goes down by ₹200. Paying more than is due → `400`.

Walk-in cash sale (no customer):

```bash
curl -X POST http://localhost:4000/api/transactions \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"kind":"bill","txnId":"test_walkin_1","method":"cash","items":[{"name":"Sugar","qty":0.5,"unit":"kg","rate":4800}]}'
```

## 7. Clean up test data

In Compass, delete the test shopkeeper and its customers (or drop the `vanni` database) before going live.

---

## Troubleshooting

| Error | Cause / fix |
|---|---|
| `querySrv ENOTFOUND` / `ECONNREFUSED` when connecting to Atlas | DNS problem on your network. `src/config/db.ts` already switches to Google DNS locally. Also check Atlas → Network Access. |
| `MongoServerSelectionError` | Atlas Network Access doesn't include your IP (or `0.0.0.0/0`), or the password in `MONGODB_URI` is wrong. |
| `401 Login required` / `Session expired` | `$TOKEN` is empty (new terminal?). Run the login command again. |
| `502 Speech service rejected our API key or has no credit left` | Check `GNANI_API_KEY` and your credit at app.gnani.ai. |
| `503 Speech service is busy` | Gnani allows one request at a time per account, and the server already retries 3 times. Wait a moment. |
| `502 AI service rejected the request` | Check `LLM_API_KEY` and that `GEMINI_MODEL` (if set) is a model your key can use. |
| `503 AI limit reached` | Gemini free-tier rate limit. Wait a minute. Usage is shown at aistudio.google.com. |
| `413 Recording is too large` | Keep clips under 30 s / 4 MB. |
| The server window shows the real reason | Every Gnani and Gemini failure is logged in the `npm run dev` window. |

> Note: on Gemini's **free tier**, Google may use the requests (transcripts and customer names) to improve its products. A paid tier switches this off.
