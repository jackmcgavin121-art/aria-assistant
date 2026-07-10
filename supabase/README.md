# ARIA cloud workspace — setup (Stage 2)

The cloud workspace is optional. It replaces passing the organisation-profile
file around with a small server that holds **logins, workspace membership and
the subscription status only**. Conversations, documents, tasks — all business
data — never leave each PC.

## One-time setup (about 10 minutes, free)

1. **Create a Supabase project** (free tier is fine): https://supabase.com →
   New project. Pick a strong database password (you won't need it day-to-day)
   and a region near you.
2. **Run the schema**: in the project, open **SQL Editor → New query**, paste
   the whole of [`schema.sql`](./schema.sql), and Run. It creates three tables
   (organisations, memberships, invites), row-level security so members can
   only ever see their own workspace, and the join/invite functions.
3. **(Recommended) turn off email confirmation** so staff can join with just
   an invite code: **Authentication → Sign In / Up → Email → disable "Confirm
   email"**. If you leave it on, staff get a confirmation email and must click
   it before their first sign-in — supported, just slower.
4. **Copy the connection details**: **Settings (project) → Data API** — you
   need the **Project URL** (`https://xxxx.supabase.co`) and the **anon /
   publishable key**. The anon key is designed to be public; row-level
   security is what protects the data.

## Connect ARIA (admin, once)

In ARIA: **Settings → Team access → Cloud workspace** →

1. Paste the Project URL and anon key → **Connect**.
2. **Create account** with your admin email + password (this is your cloud
   identity — it can be the same email as your local login).
3. **Create workspace** — you become its admin.
4. Create **cloud invites** from the same section and hand the codes to staff.

Then export a fresh **organisation profile** (same section) — it now carries
the cloud connection, so a staff PC is cloud-ready after one import.

## Staff PCs

1. Install ARIA, open it → the sign-in screen appears.
2. **Staff → Import organisation profile…** (one time, file from the admin) —
   or the admin can type the URL + key under Settings → Cloud workspace.
3. **Join with an invite code** → pick a password → in. From then on they sign
   in from any PC with just email + password; no more file passing.

## Shared company setup

Admins can **publish the company setup** (Settings → Team access → Cloud
workspace): agents and their instructions, business profile, and the org
chart. Every member's ARIA pulls it automatically at sign-in and twice a day.
The confidentiality line is hard-coded: conversations, documents, tasks,
learnings, accounts and password hashes are **never** part of the published
payload — confidential data stays on each PC.

## How it behaves offline

Every successful sign-in caches the account and the workspace's status
locally. If the server is unreachable, sign-in falls back to that cache and
the app keeps working for **14 days** since the last successful check, then
asks for a connection. A cancelled subscription blocks the app (data stays on
disk untouched).

## Stage 3 (later): billing

`organisations.plan / status / seat_limit` are already enforced (seat limits
on invite redemption, status check at sign-in). Stripe integration will update
those columns from a webhook — no app changes needed for enforcement.
