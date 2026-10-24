# DSE ICT Past-Paper Question Bank

Data files for the DSE ICT Past Paper Drilling Platform. The platform loads
these JSON files at runtime, so updating the bank = updating these files.

- `question-bank.json` — verified past-paper questions with official marking
  schemes (built by `build_db.py` from per-paper JSON extractions).
- `faq.json` — common questions paired with standard marking-scheme keywords,
  mined from the same official schemes.

Do not edit these files by hand; they are generated.

## Vercel AI proxy setup (for secret AI config)

The frontend now calls `POST /api/ai` for AI chat and AI marking.  
Set these environment variables in Vercel so model/provider details stay server-side:

- `AI_BASE_URL` (required), e.g. `https://your-provider.example/v1`
- `AI_MODEL` (optional)
- `AI_API_KEY` (optional; sent as `Authorization: Bearer ...` when present)

If `AI_BASE_URL` is missing, AI stays disabled in the UI and the rest of the app still works normally.

## Vercel Firebase config endpoint

The frontend can auto-load Firebase Web config from `GET /api/firebase-config`.
Set these Vercel environment variables:

- `FIREBASE_API_KEY` (required)
- `FIREBASE_AUTH_DOMAIN` (required)
- `FIREBASE_PROJECT_ID` (required)
- `FIREBASE_APP_ID` (required)
- `FIREBASE_STORAGE_BUCKET` (optional)
- `FIREBASE_MESSAGING_SENDER_ID` (optional)
- `FIREBASE_MEASUREMENT_ID` (optional)

If these vars are missing, the endpoint returns `503` and cloud sync stays disabled in the UI.
