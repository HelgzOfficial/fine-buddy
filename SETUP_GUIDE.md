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
4. Drag every file from this folder in (index.html, app.js, config.js, manifest.json, sw.js, vercel.json, signup.html, icon-192.png, icon-512.png, icon-180.png). You can skip `schema.sql` and this guide — they're not part of the live site.
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

## Step 5 — Take real payments (PayPal + bank transfer)

1. Go to paypal.me and set up a free PayPal.me link for your club's PayPal account (e.g. `paypal.me/RiversideFC`) — no business account or approval process needed.
2. In the app, go to **Team Settings** and paste that link into **PayPal.me Link**, then fill in your bank details too, then **Save settings**.
3. When a player taps Pay, the app automatically appends their exact outstanding balance to the PayPal link, so it opens PayPal with the right amount already filled in.

Note: neither PayPal.me nor bank transfer update the app automatically when a payment lands — there's no automatic wallet support here either (that was a Stripe-specific perk we traded away by not using Stripe). Both work the same way: the player pays, then taps "I've paid — mark my balance as paid" in the app as an honesty-system confirmation, and you can always double check against your actual PayPal/bank activity as admin.

## Step 6 — Set up the team

1. Team Settings → upload your crest, confirm the team name, add your bank details for the transfer option.
2. Fines tab → add your fines (or use "Bulk import" and paste a list).
3. Players tab → **Invite a player** → copy the link and send it to your squad (WhatsApp, group chat, wherever). Each player opens it, enters their email, taps the link Supabase emails them, and they're in — no app store, no install, no password to remember.
4. Ask each player to add it to their home screen (Share → Add to Home Screen on iPhone, or the "Install app" prompt on Android Chrome) so it behaves like a proper app icon.

## Step 7 — Set up the Committee & Court

Court lets any player dispute a fine in front of a panel of "Committee" members, who discuss it in a live chat thread and then vote guilty or not guilty. Once every eligible Committee member has voted, the case closes itself automatically — a not-guilty verdict even waives the disputed fine on its own.

1. **Re-run `schema.sql`** in the Supabase SQL Editor (Step 1) — this update adds the Court tables, so if you already ran an older version of this file, you need to run the new one too. It's always safe to re-run.
2. Players tab → open a player's profile → **Make Committee member**. Do this for however many people you want deciding disputes (admins count as Committee automatically, no need to flag yourself).
3. That's it — every player now sees a **Take it to Court** button on their Dashboard whenever they owe money, and a **Court** tab in the bottom navigation.

Note on "notifications": there's no push-notification server here (that would need a backend holding device tokens, which this no-backend setup deliberately avoids). Instead, Court uses Supabase's live Realtime feed — while a Committee member has the app open, a new case pops up as an instant on-screen alert and a red dot on the Court tab. If their phone is locked or the app is closed, they'll see it the next time they open Fine Buddy, not before.

## Step 8 — Set up Event suggestions & polls

The Events tab now also lets any player suggest a social event, and lets admins put up a poll (e.g. "where should we go?") for the whole squad to vote on.

1. **Re-run `schema.sql`** in the Supabase SQL Editor (Step 1) — this update adds the Event suggestions/polls tables, so if you already ran an older version of this file, you need to run the new one too. It's always safe to re-run.
2. That's it — every player now sees a "Suggest an event" box on the Events tab, and admins get a "+ Create a poll" button there too.

## Step 9 — Share a one-tap signup link (`signup.html`)

There's now a second page in this folder, `signup.html`, meant purely for sharing in your team's WhatsApp group. It's a lightweight standalone page — not part of the main app — that shows your crest and team name, lets a player type their email and get a sign-in link, and has its own compact "add to home screen" instructions at the bottom (already tailored to whatever phone/browser they open it on).

1. **Re-run `schema.sql`** in the Supabase SQL Editor (Step 1) — this update adds a new "public read" policy for the `team_info` table (just the team name + crest, nothing sensitive) so this page can show your crest/name before a player has signed in. It's always safe to re-run, and it doesn't remove the existing authenticated-only policy — it just adds an extra, more permissive one alongside it.
2. Once `signup.html` is uploaded to GitHub and deployed the same way as the rest of the folder (Steps 2–3), its shareable link is simply your app's URL with `/signup.html` on the end — e.g. `https://fine-buddy-yourname.vercel.app/signup.html`.
3. Paste that link straight into your WhatsApp squad chat. Anyone who taps it sees who it's for, can request their own sign-in link with one tap, and gets told exactly how to add it to their home screen for their specific phone/browser — no separate instructions needed from you.

## Step 10 — Clear out test Court cases

If you (or your teammates) opened any test disputes while trying out Court, there's now a one-tap way to wipe them before going live.

1. **Re-run `schema.sql`** in the Supabase SQL Editor (Step 1) — this update adds permission for an admin to delete Court cases, which wasn't allowed before (on purpose — verdicts could previously only be resolved automatically, never deleted). It's always safe to re-run.
2. Go to **Team Settings → Danger zone → Reset Court (clear all cases)**. This permanently deletes every Court case along with its chat messages and votes. Fines, players, and everything else are untouched — it only wipes Court history, same honesty-checked double-confirmation as the existing "Reset all fines & payments" button.

## Step 11 — New player first-login profile screen

New players now see a quick one-time "set up your profile" screen the very first time they sign in (right after clicking their magic link) — they can confirm/edit their name and optionally add a profile picture before they see the normal dashboard. There's a "Skip for now" option too, so nobody gets stuck if they don't want to fill anything in right away — they can always do it later from **My Profile**.

1. **Re-run `schema.sql`** in the Supabase SQL Editor (Step 1) — this update adds a new `onboarded` column on the `players` table that the app uses to know whether someone still needs this screen. It's always safe to re-run. Anyone who's already added a profile photo is automatically marked as already onboarded, so no existing player gets unexpectedly interrupted by this — only genuinely new signups see it.
2. That's it — nothing else to configure. Existing players notice nothing different; new players just get this one extra screen the first time they ever open the app.

## Step 12 — Remove a player from the team

1. **Re-run `schema.sql`** in the Supabase SQL Editor (Step 1) — this update adds permission for an admin to delete a player, which wasn't allowed before. It's always safe to re-run.
2. Players tab → open the player's profile → **Remove [name] from the team**, at the bottom, with the same two-step "are you sure" confirmation used elsewhere. This wipes their fines, court history, and votes. You can't remove yourself this way (ask another admin) — there always needs to be someone who can undo a mistake.
3. One honest limitation: this removes them from the app's roster, but it can't reach into Supabase Auth and delete their actual login (that needs a privileged server key this no-backend setup deliberately doesn't hold). In practice that's harmless — if someone you've removed ever opens the app again with an old link, they simply start over as a brand-new player, with no memory of their old fines or history.

Also fixed in that update: a couple of admin actions (clearing a balance, saving a name, promoting to admin/Committee) used to fail silently if something went wrong — for example, if you hadn't re-run the latest `schema.sql` yet and a database permission was missing. Now you'll get a clear on-screen message explaining what went wrong instead of the button just seeming to do nothing.

## Step 13 — Sign in with a code instead of a link (fixes the Home Screen icon)

iPhones treat Safari and an app "saved to Home Screen" as two separate lockers, and tapping the link in a sign-in email always opens Safari — never the Home Screen icon directly, even if that's where you asked for the link from. That combination means a link-only sign-in can never actually reach the icon's own storage, which is why it kept sending you back to the sign-in screen no matter what.

The fix: the app now also emails a plain 6-digit code alongside the link. Typing that code back into whichever screen you're already on (the icon included) finishes sign-in right there, with no jump through Safari to lose the session along the way. **This is a one-time thing per icon** — once you've typed the code in once, that icon stays signed in indefinitely afterwards, exactly like a normal browser tab does. Nobody has to do this every time they open the app.

1. Update `index.html` and `app.js` from this folder (Steps 2–3).
2. In your Supabase dashboard, go to **Authentication → Email Templates → Magic Link**. Supabase's default template only includes the clickable link, not the code, so add a line to the template body that includes `{{ .Token }}` — for example:
   ```html
   <h2>Sign in to Fine Buddy</h2>
   <p><a href="{{ .ConfirmationURL }}">Tap here to sign in</a></p>
   <p>Or enter this code in the app: <strong>{{ .Token }}</strong></p>
   ```
   Click **Save**. No `schema.sql` re-run needed for this step — it's an email setting, not a database change.
3. That's it. From now on, the sign-in email includes both options: the link (fastest on a regular phone browser) and the code (the one that actually works from a Home Screen icon).

## Step 14 — Make sure Home Screen icons actually pick up future updates

Every time I send you an update from here on, two things need to happen for it to actually show up on a phone that's already got Fine Buddy saved to its Home Screen:

1. **This one's on the hosting side, and only needs doing once:** this update adds a new file, `vercel.json`, which tells Vercel not to cache `sw.js`, `index.html`, and `manifest.json` too aggressively. Without it, phones could keep using an old cached copy of the app indefinitely and never notice a new version was published, no matter how many times you reopen it. Upload `vercel.json` to GitHub alongside the other files (Step 2) and it'll take effect on the next deploy — nothing to configure inside it.
2. **This one's a habit for every future update, on each phone:** on iPhones, just tapping away from the app and back doesn't count as reopening it — iOS often just resumes whatever was already running in the background, old version and all. After any update goes live, fully close the app first (open the app switcher, swipe the Fine Buddy card away) and then tap the Home Screen icon again. That forces a genuinely fresh load, which is what lets it notice and grab the new version.

## Step 15 — Evidence in Court disputes (photos, video, voice notes)

The Court chat (Step 7) now supports more than typed text — anyone in an open case can attach a photo, a short video, or record a voice note right in the app, so a dispute can include the actual evidence (a screenshot, a video clip, a spoken explanation) rather than just a written message.

1. Update `index.html` and `app.js` from this folder (Steps 2–3).
2. Re-run `schema.sql` in the Supabase SQL editor (Step 1). It's safe to re-run the whole file — this update only adds two new columns (`media_url`, `media_type`) to the existing `court_messages` table; nothing else changes or gets deleted.
3. That's it — no new storage bucket or settings needed, since this reuses the same `media` bucket that photo uploads elsewhere in the app already use.

How it works for players: inside an open case, alongside the message box there are two buttons — **📎 Photo / Video** (opens the phone's photo/camera picker) and **🎙️ Voice note** (records straight from the phone's microphone, with a Stop & send / Cancel option while recording). Attachments show up inline in the chat log for everyone in the case. Once a case is closed (guilty/not guilty), attaching is turned off the same way typing already was — it becomes a read-only record of the discussion and evidence.

Size limits: photos up to 8MB, video and voice notes up to 40MB — plenty for a phone photo or a short clip, while keeping storage costs sane.

## What's deliberately simple in this version

- **Payment confirmation**: both PayPal and bank transfer are confirmed on the honour system — the player taps "I've paid" after paying, same as the original prototype. A fully automatic reconciliation (the app updating itself the instant money arrives) would need a payment processor with webhook support, like Stripe, which is a good "phase two" if you want it later.
- **Notifications**: in-app and live while Fine Buddy is open (see Step 7) rather than true push notifications to a locked phone.
- **One team per deployment**: this setup is built for your club specifically, not as a multi-team platform. If another team wants Fine Buddy, they'd get their own copy of this same folder and their own free Supabase/Stripe/Vercel projects.
- **Security model**: good enough for a trusted group of teammates. It is not audited for handling sensitive financial data at scale — for a five-a-side or grassroots club it's solid; I wouldn't put a professional club's full accounting through it untouched.

## If something doesn't work

The most common snags: forgetting to create the `media` storage bucket (Step 1.4), forgetting to flip `is_admin` to `true` for yourself (Step 4.3), or a typo when pasting `schema.sql`. Re-running `schema.sql` is always safe if you need to start over on the database part.
