# Product Requirements Document
## Music Bot — Migration & Launch

**Status:** Draft  
**Author:** feyyus  
**Scope:** Migrate the MusicGame feature from the private friend-group monolith into a standalone, publicly launchable Telegram bot built on grammY, within a monorepo that also supports future bots and a shared monetization layer.

---

## 1. Background

The existing monolith (`telegraf-bot`) serves a single private friend group. It contains several features (MusicGame, Joker, Food, Sorry, Crafty, Roles) in one process. The music-guessing game is the most complete and interesting feature and is the one worth scaling to the public.

The goal is not to rewrite for the sake of it. The goal is to:
- Launch the music game to arbitrary Telegram groups (not just one hardcoded friend chat)
- Introduce a real-money monetization layer (coins purchased via Telegram payments) for premium features
- Establish a monorepo structure that supports 1–2 additional bots in the future without repeating infrastructure work
- Fix known bugs and design smells discovered during this analysis (see Section 6)

---

## 2. Bots in scope

### 2.1 Music Bot (primary, this migration)
A Telegram group bot for a music-guessing party game. Players upload audio tracks privately; the bot plays each track anonymously in the group; players guess whose track it is by tapping inline buttons.

### 2.2 Future bots (out of scope for this document, but monorepo must accommodate)
One additional bot is anticipated within 6–12 months. Architecture decisions must not require large structural changes to accommodate it.

---

## 3. User roles

**Player** — a member of a Telegram group where the bot is active. Can submit tracks, make guesses, view stats, and ping.

**Organizer** — a player with elevated permissions in a given chat. Can start/end games, manage settings, remove players' tracks, and ping all players. Identified by role assignment, not hardcoded user ID.

**Developer/Admin** — the bot operator (you). Accesses dev-help commands and can manage roles.

---

## 4. User stories

### 4.1 Core game flow

- As a player, I can message the bot privately to select which group I want to submit a track for, so that I can participate in that group's game without exposing my track to other players.
- As a player, I can send an audio file in the private chat after selecting a group, and the bot confirms my submission, so I know my track is queued.
- As a player, I can attach a hint (any media message) to my submission, so the organizer can optionally reveal it during the game.
- As a player, when a round starts, I hear the track and see a list of player names as inline buttons, so I can guess whose track it is.
- As a player, I can tap a name to lock in my guess, and receive immediate feedback (correct/wrong, points earned or lost), so I know how I did.
- As a player, I cannot guess twice in the same round, and I am told so if I try.
- As a player, I can view the current leaderboard and round info at any time via commands.
- As a player, at the end of the game I see a final leaderboard with scores and track difficulty rankings.

### 4.2 Lobby & configuration

- As an organizer, I can open a lobby panel via one command or button, and navigate all game management from there using inline buttons, so I do not need to memorize many commands.
- As an organizer, I can configure hint delay, auto-advance, advance delay, shuffle, scoring preset, and self-guess allowance before starting a game.
- As an organizer, I can see which players have submitted tracks and remove a player's track before the game starts.
- As an organizer, I can ping all players with a single button press.
- As an organizer, I can start the game from the lobby panel.
- As an organizer, I can end an active game early.

### 4.3 Discoverability

- As a new user, I can type `/start` (in private) or `/music` (in a group) and be presented with a button-based menu, so I do not need to remember commands.
- As any user, I can open the Telegram command menu (the `/` button) and see a curated short list of useful commands with descriptions.
- As an organizer, I can access a help page listing available commands for my role.

### 4.4 Monetization (coins)

- As a user, I have a coin wallet tied to my Telegram user ID, shared across all bots in the system.
- As a user, I can purchase coins through the bot using Telegram Payments (provider TBD: Telegram Stars or external).
- As a user, I can spend coins to unlock premium features (e.g., extra game settings, additional rounds, cosmetic options — specific features TBD during implementation).
- As a user, I can check my coin balance at any time.
- As the operator, every coin credit and debit is recorded in an immutable transaction log so disputes can be audited.
- As the operator, double-crediting from duplicate payment webhooks is prevented at the database level (idempotency key unique constraint), not only at the application level.

### 4.5 Membership sync

- As the system, when any user sends a message in a group where the bot is active, their user record, the chat record, and their membership are automatically upserted, so game features always have current membership data without requiring explicit registration.

---

## 5. Acceptance criteria

### 5.1 Game correctness
- A player's guess is only accepted if the round is in `LIVE` phase and the game is `ACTIVE`. Any other state returns a clear inline query response (no silent failure).
- Points are calculated using `startedAt` (when the round went LIVE), not `createdAt` (when the round row was inserted). These differ when a game is pre-staged in LOBBY.
- A player cannot guess in a round that belongs to their own submission (unless `allowSelfGuess` is enabled).
- All three scoring presets (classic, aggressive, gentle) produce correct output per their documented formulas.

### 5.2 Scheduler durability
- Hint and auto-advance timers survive a bot process restart. If the bot restarts mid-round, scheduled events fire when due, not silently drop.
- Timers do not double-fire if two instances of the bot process are running simultaneously (e.g., during a rolling deploy).

### 5.3 Wallet integrity
- A coin credit operation called twice with the same idempotency key results in exactly one credit, enforced at the DB layer.
- Coin balance is always derivable from the transaction log (balance = sum of credits minus debits for that user).

### 5.4 UX
- Users need to remember at most one command per context (private: `/start`; group: `/music`). All other actions are reachable via inline buttons from that entry point.
- `setMyCommands` is configured with scoped command lists (private vs group).

### 5.5 Deployment
- Each bot runs as an independent Docker container.
- Shared infrastructure (Postgres, Redis) runs as separate containers in the same `docker-compose` stack.
- A bot container can be restarted without affecting other bot containers or the database.

---

## 6. Known bugs to fix during migration (not new features)

These are defects identified in the current code that must be corrected in the new implementation, not deferred.

**B1 — Scoring uses `createdAt` instead of `startedAt` for time-elapsed calculation.**  
`GuessService` computes `(Date.now() - round.createdAt.getTime()) / 1000`. `createdAt` is set when the `GameRound` row is inserted (during track upload, in LOBBY), not when the round goes LIVE. For games with pre-staged tracks, this systematically overcounts elapsed time. Fix: use `round.startedAt` and set it reliably when a round transitions to `LIVE` phase.

**B2 — Scheduler callbacks close over a stale Telegraf `ctx`.**  
`RoundOrchestratorService.startRound` captures `ctx` in the `scheduleOnce` callbacks for hint display and auto-advance. By the time the timer fires (30–150 seconds later), the `ctx` object — and specifically `ctx.telegram`, `ctx.chat` — is from a long-dead HTTP update context. This works coincidentally today (the Telegraf Bot instance is the same object in memory, and `ctx.telegram` delegates to it), but it is conceptually broken and will fail under BullMQ or any worker-pool architecture. Fix: store only `chatId` and `gameId` as plain data in the scheduled job; resolve a fresh bot API client in the job handler.

**B3 — Two sources of truth for "active game."**  
The schema has both `Chat.activeGameId` (a FK pointer) and `Game.status` to identify the active game. `GameLifecycleService.start` contains multiple re-fetch attempts and a direct Prisma fallback specifically because these two fields can diverge. Fix: remove `Chat.activeGameId`. Query active game exclusively by `Game.status = ACTIVE AND Game.chatId = X`. One source of truth, one query, no re-fetch loops.

**B4 — `ActionCodec` has no max-length guard.**  
Telegram caps `callback_data` at 64 bytes. `encode('guess', roundId, userId)` produces e.g. `guess:1234567890:9876543210` = 27 bytes, safe today. But multi-argument paths (e.g. `settings:delay:hintDelaySec:120`) can grow. Fix: add a length assertion in `encode()` that throws at development time rather than silently truncating in production.

**B5 — `Guess.points` stored redundantly.**  
Points are stored on the `Guess` row but are fully derivable from `Guess.isCorrect`, `round.startedAt`, `round.hintShownAt`, and `game.scoringPreset`. This means changing a scoring preset after guesses exist produces an inconsistent historical record. For the migration: keep storing points (needed for leaderboard queries without recalculation), but document clearly that points are a denormalized cache of the scoring formula at guess time, not a mutable field.
