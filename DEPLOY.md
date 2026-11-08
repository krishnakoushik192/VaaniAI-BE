# Deploying vanni-backend to Vercel

Repo: `github.com/krishnakoushik192/VaaniAI-BE` (branch `master`). Allow about 20 minutes.

What is already set up in the code:
- `src/index.ts` exports the Express app. Vercel's **Express** preset finds it automatically, compiles the TypeScript and runs it as one serverless function.
- `vercel.json` runs the function in **Mumbai (`bom1`)**, next to an Atlas cluster in Mumbai (`ap-south-1`). Every request talks to MongoDB several times, so keeping them in the same city makes requests noticeably faster.
- `package.json` pins **Node 24** (`engines`), the same version you run locally.
- The database connection is reused between requests, and the Google DNS workaround only applies on your PC, not on Vercel.

Limits to know (Hobby plan, per Vercel's docs):
- A request may take up to 300 s. A voice bill takes about 2 s.
- Upload size is limited to **4.5 MB**. The API itself accepts recordings up to 4 MB / 30 s.

---

## Step 1: Pre-flight on your PC

```bash
npm run typecheck
npm run smoke
npm run voice-test
```

All three must pass (see TESTING.md). Then commit and push everything:

```bash
git status
```

`.env` must **not** appear in that list (it's in `.gitignore`). `.env.example` is fine.

```bash
git add .
git commit -m "Voice billing APIs and Vercel config"
git push origin master
```

## Step 2: Check Atlas

1. **Network Access** must have `0.0.0.0/0` (you already added it). Vercel has no fixed IP addresses.
2. **Cluster region:** go to Atlas → Clusters and check the region under your cluster name.
   - If it is **Mumbai (ap-south-1)**, keep `vercel.json` as it is.
   - If it is somewhere else, change `"bom1"` in `vercel.json` to the Vercel region closest to it: Singapore `sin1`, Frankfurt `fra1`, Washington `iad1`. Then commit and push again.
3. Optional but cleaner: in **Database Access**, create a second database user just for production (e.g. `vanni-prod`) with a new password, and use it only in Vercel. If one connection string ever leaks, you can delete that user without breaking the other environment.

## Step 3: Make a production JWT secret

Use a **different** secret from your local `.env`, so tokens from testing don't work in production:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Copy the output. You'll need it in step 4.

## Step 4: Create the Vercel project

1. Go to https://vercel.com and choose **Sign up / Log in → Continue with GitHub**.
2. **Add New… → Project**.
3. Under *Import Git Repository*, find **VaaniAI-BE** and click **Import**.
   If it's not listed, click **Adjust GitHub App Permissions** and give Vercel access to that repo.
4. On the configure screen:
   - **Project Name:** e.g. `vaani-api`. Your URL becomes `https://vaani-api.vercel.app`.
   - **Framework Preset:** **Express** (detected automatically; if not, pick it from the list).
   - **Root Directory:** `./`
   - **Build and Output Settings:** leave everything empty / default.
5. Open **Environment Variables** and add these. Tip: you can paste several `KEY=value` lines at once into the first *Key* box.

   | Key | Value |
   |---|---|
   | `MONGODB_URI` | your Atlas connection string (the production user, if you made one) |
   | `MONGODB_DB` | `vanni` |
   | `JWT_SECRET` | the new secret from step 3 |
   | `GNANI_API_KEY` | your Gnani key |
   | `LLM_API_KEY` | your Google AI Studio key |
   | `GEMINI_MODEL` | *(optional)* `gemini-3.5-flash-lite` |

   Don't add `PORT` or `VERCEL`: Vercel sets those itself.
6. Click **Deploy** and wait about 1 minute for "Congratulations!".

## Step 5: Check the live API

Use your project's URL in Git Bash:

```bash
API=https://vaani-api.vercel.app
curl $API/api/health
```

→ `{"status":"ok","db":false}`

Register a shop. This writes to your **real** Atlas database:

```bash
curl -X POST $API/api/auth/register -H "content-type: application/json" \
  -d '{"shopName":"Test Shop","shopkeeperName":"Koushik","mobileNumber":"9876543210","passcode":"1234","language":"te"}'
```

Log in and try a voice bill:

```bash
TOKEN=$(curl -s -X POST $API/api/auth/login -H "content-type: application/json" \
  -d '{"mobileNumber":"9876543210","passcode":"1234"}' | node -pe "JSON.parse(require('fs').readFileSync(0)).token")

curl -X POST $API/api/voice/bill -H "authorization: Bearer $TOKEN" \
  -F "audio=@test-audio/en-ramesh-khata.wav"
```

You should get a `transcript` and a `draft` with ₹385. "Ramesh" will be `customer: null` until you add him.
Every other command in **TESTING.md** works the same way: replace `http://localhost:4000` with `$API`.

The first request after a quiet period can take 1–3 s extra (a cold start plus the MongoDB connection). Later requests are fast.

## Step 6: Point the app at it

In the React Native app, set the API base URL to `https://vaani-api.vercel.app/api`. Use HTTPS, so Android needs no special network settings.

---

## Updating later

- **Code:** run `git push origin master` and Vercel redeploys production automatically (about 1 minute). Pushes to other branches get their own **preview** URLs, which are handy for testing changes first.
- **Environment variables:** after changing one in *Settings → Environment Variables*, go to **Deployments → ⋯ → Redeploy**. Changes are **not** applied to deployments that already exist.
- **Roll back:** *Deployments* → pick an older working deployment → **⋯ → Promote to Production**.

## Troubleshooting

Find errors in *Project → Logs* (live) or *Deployments → (deployment) → Build Logs*. Every Gnani, Gemini and MongoDB error is printed there.

| Symptom | Fix |
|---|---|
| Build fails with a TypeScript error | Run `npm run typecheck` locally, fix it, push again. |
| `500 Something went wrong` + `MONGODB_URI is not set` / `JWT_SECRET is not set` in Logs | The environment variable is missing or misspelled. Add it, then **Redeploy**. |
| Logs show `MongoServerSelectionError` / timeouts | Atlas Network Access lacks `0.0.0.0/0`, or the password in the URI is wrong. URL-encode special characters or use a letters-and-digits password. |
| `502 Speech service rejected our API key…` | `GNANI_API_KEY` is wrong, or there's no Gnani credit left. |
| `502 AI service rejected the request` | `LLM_API_KEY` is wrong, or `GEMINI_MODEL` is set to a model your key can't use. Delete it to use the default. |
| `413 FUNCTION_PAYLOAD_TOO_LARGE` | The recording is over 4.5 MB. Record shorter clips (≤30 s) or in a compressed format (m4a/aac). |
| `404 NOT_FOUND` page from Vercel (not JSON) | Wrong URL. All routes start with `/api/…`. |
| Everything is slow (more than 1 s even for `/api/health`) | The region doesn't match Atlas. Check step 2. |

## Before real shopkeepers use it

- **Vercel Hobby is for personal, non-commercial use.** When real shops use the app for business, move the project to the **Pro** plan.
- **Gemini free tier:** Google may use the requests (transcripts, customer names) to improve its products. Enable billing on the AI Studio key so this stops. Flash-Lite costs very little.
- **Rate limit voice requests per shop.** At the moment one account could use up your Gnani credit.
- **Keys:** if a key ever appears in a screenshot, chat or commit, rotate it right away (create a new one, update Vercel, redeploy, delete the old one).
- Delete the test shopkeepers and customers from Atlas.
