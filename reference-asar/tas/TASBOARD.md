).
# TAS Board — community leaderboard for driven / input-edited runs

The TAS tool **never** touches PolyTrack's official leaderboard. Instead it has
its own community board (shown **next to the real leaderboard** in-game) that
anyone can upload to and view, with each run tagged `driven` (drove to the finish
— legit or savestate) or `edited` (manually edited at least one input — full TAS)
and the **full recording attached** (so any run can be re-watched / verified). You
can **filter by tag**, and it shows each player's best per category.

This board is hosted on **Supabase** (free Postgres + an auto-generated REST
API). The project URL + anon key are **embedded in the tool** (`BOARD_URL` /
`BOARD_KEY` in [tas/tas.js](tas.js)), so everyone who runs the tool is on the
same board automatically — no per-person setup. The anon key is safe to ship:
the table's RLS only allows **read + insert** (no update/delete).

> **You only need the steps below once, as the project owner**, and only to
> (a) create the table the first time, or (b) move the board to a different
> Supabase project (then update `BOARD_URL`/`BOARD_KEY` in tas.js).
> Everyone else just opens the board (**F2**) and it works.

---

## 1. Create the Supabase project

1. Go to <https://supabase.com> → sign in (GitHub login is fine) → **New project**.
2. Pick a name + a database password (any) + a region near you. Free tier is plenty.
3. Wait ~1 minute for it to provision.

## 2. Create the table + policies

Open **SQL Editor** (left sidebar) → **New query** → paste this and **Run**:

```sql
create table public.runs (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  track_id    text   not null,           -- the PolyTrack track id
  track_name  text,                       -- optional friendly name
  category    text   not null check (category in ('driven','edited')),
  nickname    text,                        -- shown name (the player's PolyTrack nickname)
  user_id     text,                        -- the player's userTokenHash (stable id; dedupe key)
  car_style   text,
  frames      bigint not null,            -- run time in frames (= ms)
  recording   text   not null            -- base64url recording (re-watchable)
);

-- fast "best runs for this track + category + player" queries
create index runs_lookup on public.runs (track_id, category, frames);
create index runs_user   on public.runs (track_id, category, user_id, frames);

-- Row Level Security: anyone (anon key) may READ and INSERT; nobody may
-- update/delete (so runs can't be tampered with via the public key).
alter table public.runs enable row level security;
create policy "public read"   on public.runs for select to anon using (true);
create policy "public insert" on public.runs for insert to anon with check (true);
```

**Two categories:** `driven` (drove to the finish — legit or savestate, never hand-edited inputs; auto-uploaded on finish) and `edited` (at least one input manually edited — full TAS; uploaded with the panel button). The board shows each player's **best per category** (it stores every personal best but de-dupes the view by `user_id`).

> **Already created the table with the old 3-category schema?** Run this migration
> instead (it converts the old `legit`/`savestate`/`tas` rows and adds `user_id`):
>
> ```sql
> alter table public.runs drop constraint runs_category_check;
> update public.runs set category = 'driven' where category in ('legit','savestate');
> update public.runs set category = 'edited' where category = 'tas';
> alter table public.runs add constraint runs_category_check check (category in ('driven','edited'));
> alter table public.runs add column if not exists user_id text;
> create index if not exists runs_user on public.runs (track_id, category, user_id, frames);
> ```

> Want to wipe the board later? `delete from public.runs;` in the SQL editor
> (that runs as the table owner, not the anon key, so it's allowed).

## 3. Get the URL + anon key (only if changing projects)

**Project Settings → API**:
- **Project URL** — looks like `https://abcdefgh.supabase.co`
- **anon public** key — a long `eyJ…` string.

The current board's values are already baked into [tas/tas.js](tas.js):

```
BOARD_URL = "https://vosvidewunkqxgjybinh.supabase.co"
BOARD_KEY = "eyJ…"   // anon public
```

To move the board to a different project, replace those two constants.

## 4. Using it (everyone)

The TAS leaderboard appears **next to the game's real leaderboard** automatically
(every track). It's already connected — nothing to set up. Your runs are credited
to your **PolyTrack nickname + userTokenHash** (read from the game), so there's no
login.

- **Driven** runs upload **automatically when you cross the finish line while
  driving** (legit *or* savestate) — only when it's a new personal best.
- **Edited** runs (full TAS) upload via the **Simulate finish → upload TAS**
  button in the TAS panel: it simulates your editor inputs to the line, reads the
  real finish time, and posts it.
- Toggle auto-upload in **Settings → TAS Tool → TAS leaderboard**. Filter the twin
  by **Driven / Edited**; click any row to load that run into the editor.

(Preferences are stored in `localStorage`; the backend is shared.)

---

## Notes on trust

This is a **community sharing board, not anti-cheat**. The tool auto-tags the
category from what it observed (savestate used? whole run from an editor
script?), but anyone could spoof a tag — that's expected. Because the **full
recording is attached to every run**, anything suspicious can be re-watched in
the tool and judged by eye.

## Abuse / cost

Free tier Supabase is generous, but the anon key allows inserts, so in theory
someone could spam rows. If that happens you can:
- add a `created_at`-based rate limit via a Postgres trigger, or
- rotate the anon key (Settings → API → "Reset") and re-share, or
- `delete from public.runs where …` to clean up.

Ask me and I'll add a simple per-IP/per-minute insert limit (a small SQL trigger
or an Edge Function) if it becomes a proble