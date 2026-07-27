# Fine Buddy — Go-Live Guide

Everything in this folder is the real, working app. You don't need to write or understand any code — just follow these steps in order, all done through normal websites in your browser.

## Step 1 — Set up your database (Supabase)

1. Go to your Supabase project dashboard (the one ending `xvjnwgkaxizmcuhvsfgx`).
2. Click **SQL Editor** in the left sidebar → **New query**.
3. Open `schema.sql` from this folder, copy the whole thing, paste it into the query box, and click **Run**.
4. Still in Supabase, click **Storage** in the left sidebar → **New bucket** → name it exactly `media` → turn **Public bucket** ON → **Create bucket**. (This is where crests and profile photos are stored — the SQL you just ran already set the permissions for it, but the bucket itself has to be created by hand.)

## Step 2 — Put the code on GitHub

1. Go to github.com, sign in, click the **+** in the top right → **New repository**.
2. Name it `fine-buddy`, keep it Public or Private (either is fine), don't add a README, click **Create repository**.
3. On the next page click **uploading an existing file**.
4. Drag every file from this folder in (index.html, app.js, config.js, manifest.json, sw.js, icon-192.png, icon-512.png, icon-180.png). You can skip `schema.sql` and this guide — they're not part of the live site.
5. Click **Commit changes**.

## Step 3 — Publish it (Vercel)

1. Go to vercel.com, sign in, click **Add New → Project**.
2. Choose **Import Git Repository** and pick the `fine-buddy` repo you just created.
3. Leave all settings as default (it's a static site, no build step needed) and click **Deploy**.
4. After a few seconds you'll get a live link like `fine-buddy-yourname.vercel.app` — that's your app's real address.

## Step 4 — Become the first admin

1. Open your new live link. Enter your own email and tap **Send me a sign-in link**.
2. Check your email, click the link — you're now signed in as a regular player.
3. Go back to Supabase → **Table Editor** → `players` table. Find the row with your email/name, click into the `is_admin` column, and set it to `true`.
4. Refresh the app — you'll now see the Admin tabs (Fines, Players, Team, etc). From here on, you can promote any other player to admin from inside the app itself (open their profile from the Players tab → "Make team admin"), so this manual database step is only needed once, ever.

## Step 5 — Take real payments (Stripe)

1. In your Stripe Dashboard, go to **Payment links** → **Create payment link**.
2. Choose **Customer chooses price**, give it a name like "Fine Buddy fine payment", set a reasonable min/max (e.g. £1–£200).
3. Save it, copy the link.
4. In the app, go to **Team Settings** and paste it into **Stripe Payment Link**, then **Save settings**.
5. Apple Pay and Google Pay both appear automatically on that Stripe checkout page for players on supported devices/browsers — there's nothing extra to configure for either of those.

## Step 6 — Set up the team

1. Team Settings → upload your crest, confirm the team name, add your bank details for the transfer option.
2. Fines tab → add your fines (or use "Bulk import" and paste a list).
3. Players tab → **Invite a player** → copy the link and send it to your squad (WhatsApp, group chat, wherever). Each player opens it, enters their email, taps the link Supabase emails them, and they're in — no app store, no install, no password to remember.
4. Ask each player to add it to their home screen (Share → Add to Home Screen on iPhone, or the "Install app" prompt on Android Chrome) so it behaves like a proper app icon.

## What's deliberately simple in this version

- **Payment confirmation**: Stripe payments are instant and automatic (the checkout page itself handles Apple Pay/Google Pay/card). Bank transfers are confirmed on the honour system — the player taps "I've paid" after transferring, same as the prototype. A fully automatic bank-transfer reconciliation would need a proper accounting integration, which is a good "phase two" if you want it.
- **One team per deployment**: this setup is built for your club specifically, not as a multi-team platform. If another team wants Fine Buddy, they'd get their own copy of this same folder and their own free Supabase/Stripe/Vercel projects.
- **Security model**: good enough for a trusted group of teammates. It is not audited for handling sensitive financial data at scale — for a five-a-side or grassroots club it's solid; I wouldn't put a professional club's full accounting through it untouched.

## If something doesn't work

The most common snags: forgetting to create the `media` storage bucket (Step 1.4), forgetting to flip `is_admin` to `true` for yourself (Step 4.3), or a typo when pasting `schema.sql`. Re-running `schema.sql` is always safe if you need to start over on the database part.
