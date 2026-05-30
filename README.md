# Crazy Cash Rush — Cloudflare Pages + D1

## Files

- `index.html` — the game page
- `styles.css` — visual styling
- `game.js` — game logic, sounds, account UI, rewarded-ad client hook
- `functions/api/[[path]].js` — Cloudflare Pages Functions API for login, balances, rewards, admin actions
- `migrations/0001_schema.sql` — D1 schema
- `wrangler.toml` — Cloudflare config template

## Cloudflare D1 setup

1. Install Wrangler and log in:
   ```bash
   npm install -g wrangler
   wrangler login
   ```

2. Create the database:
   ```bash
   wrangler d1 create crazy-cash-rush-db
   ```

3. Copy the returned `database_id` into `wrangler.toml`.

4. Apply the schema:
   ```bash
   wrangler d1 execute crazy-cash-rush-db --file=./migrations/0001_schema.sql
   ```

5. Deploy through Cloudflare Pages. In the Pages project settings, add a D1 binding:
   - Binding name: `DB`
   - Database: `crazy-cash-rush-db`

6. For local testing with Pages Functions:
   ```bash
   wrangler pages dev . --d1 DB=crazy-cash-rush-db
   ```

## Accounts

- Guest players can play, but their balance is not saved to D1.
- Registered players are stored in D1.
- Usernames are unique and case-insensitive.
- Passwords are salted and SHA-256 hashed server-side.
- Admin login:
  - Username: `AdminLee`
  - Password: `AdminLee`

For a public production game, move spin outcomes fully server-side before using real money or anything convertible to value. This demo still calculates gameplay in the browser.

## Rewarded ads

The game has the rewarded-ad flow wired to `window.adBreak`. In `index.html`, uncomment the AdSense / Ad Placement API script and replace the publisher ID.

The reward is granted only from the ad callback in the browser. Logged-in users receive the +1000 balance update through `/api/reward-ad`; guests receive it locally.

