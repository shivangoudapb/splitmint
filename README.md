# SplitMint

SplitMint is a fullstack web app for managing shared group expenses. It implements authentication, groups, participants, expense splitting, balances, settlements, search, filters, charts, and the optional MintSense natural-language helper.

## How to run locally

```bash
npm start
```

If `npm` is not available, run the same app directly:

```bash
node server.js
```

Then open `http://localhost:3000`.

The app uses a dependency-free Node backend and stores data in `data/splitmint.json` by default.

## Implemented features

- Register and login with an email and password.
- Password hashing with Node `crypto.pbkdf2`.
- Bearer-token authenticated API routes.
- Create, edit, and delete groups.
- Keep each group to the primary user plus up to 3 participants.
- Store participant name, color, and generated initials.
- Add, edit, and remove participants.
- Cascade-delete linked expenses when deleting a group.
- Clean up linked split records when participants are removed.
- Add, edit, and delete expenses with amount, description, date, payer, group, and participants.
- Split by equal amount, custom amount, or percentage.
- Recalculate balances automatically after every change.
- Round uneven splits consistently to cents.
- Compute net balances and minimal settlement suggestions.
- Show total spent, amount the user owes, amount owed to the user, and expense count.
- Show balance table, transaction history, contribution chart, share chart, and color-coded ledger rows.
- Search expenses by text and filter by participant, date range, or amount range.
- MintSense parses simple natural-language statements into the expense form and assigns basic categories.

## API overview

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/me`
- `GET /api/groups`
- `POST /api/groups`
- `GET /api/groups/:id/dashboard`
- `PUT /api/groups/:id`
- `DELETE /api/groups/:id`
- `POST /api/groups/:id/expenses`
- `PUT /api/expenses/:id`
- `DELETE /api/expenses/:id`

## Deploy on Render

1. Push this folder to GitHub.
2. Create a new Render Blueprint from the repo.
3. Render will use `render.yaml`, run `npm start`, generate `TOKEN_SECRET`, and persist the JSON database on a 1 GB disk mounted at `/var/data`.

## Demo notes

This is built as an assignment-ready fullstack prototype. The file-backed database is convenient for demos and small deployments. A larger production version should move the persistence layer to Postgres or another managed database.
