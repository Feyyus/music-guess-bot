# Implementation Plan
## Music Bot Migration

**Status:** Draft  
**Depends on:** spec.md, requirements.md  
**Approach:** Phases are ordered so each one produces a working, testable state. Do not start a phase until the previous one's checkboxes are complete. Bugs B1–B5 from requirements.md are called out inline where they are fixed.

---

## Phase 0 — Monorepo scaffold
*Goal: empty-but-wired repo where `pnpm install` works and packages can import each other.*

- [ ] Create repo root with `pnpm-workspace.yaml` listing `apps/*` and `packages/*`
- [ ] Create `packages/db/` — copy `prisma/schema.prisma` from old repo, add `package.json` (`name: "@feyyus/db"`)
- [ ] Add `prisma generate` and `prisma migrate` scripts to `packages/db/package.json`
- [ ] Create stub `packages/wallet/` with `package.json` (`name: "@feyyus/wallet"`) and empty `src/index.ts`
- [ ] Create stub `packages/scheduler/` with `package.json` (`name: "@feyyus/scheduler"`) and empty `src/index.ts`
- [ ] Create stub `packages/bot-kit/` with `package.json` (`name: "@feyyus/bot-kit"`) and empty `src/index.ts`
- [ ] Create `apps/music-bot/` with `package.json` listing `@feyyus/db`, `@feyyus/wallet`, `@feyyus/scheduler`, `@feyyus/bot-kit` as workspace dependencies
- [ ] Add root `tsconfig.base.json` with path aliases; extend it in each package and app
- [ ] Run `pnpm install` from root — confirm workspace links resolve
- [ ] Add `infra/docker-compose.yml` with `postgres` and `redis` services only (no bot yet)
- [ ] Confirm `docker compose up postgres redis` starts both services cleanly

---

## Phase 1 — Database schema migration
*Goal: Prisma schema in `packages/db` is clean, migrated, and exports a working client.*

- [ ] Copy current `schema.prisma` into `packages/db/prisma/schema.prisma`
- [ ] **Fix B3:** Remove `Chat.activeGameId`, `Chat.activeGame` relation, and `Game.activeInChat` opposite relation. Write migration.
- [ ] **Fix B1 (prerequisite):** Verify `GameRound.startedAt` column exists and is nullable `DateTime`. It does — no migration needed, but annotate it in schema comments: "Set to NOW() exactly when phase transitions DRAFT→LIVE. Used for scoring time-elapsed calculation."
- [ ] **Rename cleanup:** Rename `Game.currentRound` → `Game.currentSequence` and `GameRound.roundIndex` → `GameRound.sequence` in schema. Write migration. Update all usages in repository (find: `currentRound`, `roundIndex` — grep across old codebase to catch all callsites before porting them).
- [ ] **Add Wallet tables:** Add `Wallet` and `WalletTransaction` models per spec Section 4.1. Write migration.
- [ ] **Enum rename:** Rename `GameStatus.COMPLETED` → `GameStatus.ENDED` for consistency with current service code that uses `'ENDED'` as a string literal in some places (or vice versa — pick one, fix both). Write migration.
- [ ] Run `pnpm --filter @feyyus/db prisma migrate dev` against local Postgres — confirm clean migration history
- [ ] Run `pnpm --filter @feyyus/db prisma generate` — confirm client generates without errors
- [ ] Write and export Prisma singleton client from `packages/db/src/client.ts`:
  ```typescript
  import { PrismaClient } from '@prisma/client';
  export const prisma = new PrismaClient();
  ```
- [ ] Export from `packages/db/src/index.ts`: re-export `prisma`, re-export all `@prisma/client` types
- [ ] Write one smoke-test: import `prisma` from `@feyyus/db` in a throwaway script, run `prisma.user.findFirst()`, confirm it returns without error

---

## Phase 2 — Wallet package
*Goal: `@feyyus/wallet` is usable and correct before any bot code touches it.*

- [ ] Implement `WalletService` in `packages/wallet/src/wallet.service.ts` per spec Section 5:
  - `credit(userId, amount, reason, idempotencyKey)` — Prisma `$transaction`: upsert `Wallet`, insert `WalletTransaction`, update `Wallet.balance`. Catch unique constraint error on `idempotencyKey` and return existing transaction.
  - `debit(userId, amount, reason, idempotencyKey)` — same transaction pattern, throw `InsufficientFundsError` if `Wallet.balance < amount`.
  - `getBalance(userId)` — read `Wallet.balance` (cached, fast path).
  - `getHistory(userId)` — read `WalletTransaction[]` ordered by `createdAt DESC`.
- [ ] Implement `InsufficientFundsError extends Error`
- [ ] Export both from `packages/wallet/src/index.ts`
- [ ] Write unit tests for `WalletService` (use a real test DB or Prisma mock):
  - [ ] `credit` twice with same idempotencyKey → only one `WalletTransaction` row inserted, balance credited once
  - [ ] `debit` with sufficient balance → succeeds, balance decremented
  - [ ] `debit` with insufficient balance → throws `InsufficientFundsError`
  - [ ] `getBalance` matches sum of `WalletTransaction.amount` (reconciliation test)

---

## Phase 3 — Scheduler package
*Goal: `@feyyus/scheduler` wraps BullMQ and can enqueue/cancel delayed jobs.*

- [ ] Add `bullmq` to `packages/scheduler/package.json` dependencies
- [ ] Implement `SchedulerService` in `packages/scheduler/src/scheduler.service.ts`:
  - Constructor takes `redisUrl: string`, creates BullMQ `Queue` instances per queue name
  - `scheduleOnce(jobId, dueAt, queue, data)` — adds job with `delay = dueAt - Date.now()`, `jobId` as BullMQ job name (enables deduplication/replace)
  - `cancel(jobId, queue)` — removes job by name if it exists
- [ ] Export `SchedulerService` from `packages/scheduler/src/index.ts`
- [ ] Manual test: enqueue a job with 5-second delay, confirm it appears in BullMQ dashboard (or Redis CLI), confirm it fires after 5 seconds

---

## Phase 4 — bot-kit package
*Goal: shared middleware extracted and working independently of any specific bot.*

- [ ] Port `MemberService` from old codebase to `packages/bot-kit/src/member/member.service.ts` (it has no bot-specific imports, only Prisma — straightforward move)
- [ ] Port `TextService` (i18n lookup) to `packages/bot-kit/src/text/text.service.ts`
- [ ] Write `membershipSyncMiddleware` in `packages/bot-kit/src/middleware/membership-sync.ts`:
  - Extract exact logic from current `bot.ts` inline middleware (upsert user, chat, membership on group updates)
  - Accept `MemberService` as a constructor param (not a container — plain DI)
  - Return a grammY `MiddlewareFn<BotContext>`
- [ ] Write `requirePermission` helper in `packages/bot-kit/src/middleware/permissions.ts`:
  - Port logic from current `RequirePermission` decorator
  - grammY idiom: a function that returns a middleware, not a class decorator (decorators work in grammY too, but a middleware factory is more idiomatic and doesn't require `reflect-metadata`)
- [ ] Export all from `packages/bot-kit/src/index.ts`

---

## Phase 5 — Port music game repository
*Goal: `MusicGameRepository` works against the updated schema in the new monorepo.*

- [ ] Copy `music-game.repository.ts` into `apps/music-bot/src/repository/`
- [ ] Update all imports: `@prisma/client` types → `@feyyus/db`, Prisma client import → `@feyyus/db`
- [ ] **Fix B3 (repository side):** Remove any query that references `Chat.activeGameId` or uses the `activeGame` / `activeInChat` relation. Replace `getCurrentGameByChatId` with a query on `Game.status`:
  ```typescript
  async getCurrentGameByChatId(chatId: number) {
    return this.prisma.game.findFirst({
      where: {
        chatId: BigInt(chatId),
        status: { in: [GameStatus.LOBBY, GameStatus.ACTIVE] },
      },
      orderBy: { createdAt: 'desc' },
      include: { rounds: { include: { guesses: true, user: true } } },
    });
  }
  ```
  This replaces the current multi-attempt re-fetch logic in `GameLifecycleService` entirely.
- [ ] **Fix B1 (repository side):** Add `setRoundLive(roundId: number)` method:
  ```typescript
  async setRoundLive(roundId: number) {
    return this.prisma.gameRound.update({
      where: { id: roundId },
      data: { phase: RoundPhase.LIVE, startedAt: new Date() },
    });
  }
  ```
- [ ] Update all `currentRound` → `currentSequence` and `roundIndex` → `sequence` references (from Phase 1 rename)
- [ ] Confirm TypeScript compiles against updated schema types

---

## Phase 6 — Port services to grammY-agnostic shape
*Goal: game services have no Telegraf imports and pass `api` instead of `ctx` where scheduling is involved.*

- [ ] Copy `guess.service.ts` → `apps/music-bot/src/services/guess.service.ts`
  - Update imports only (Prisma types from `@feyyus/db`, no Telegraf)
  - **Fix B1:** Change `round.createdAt` to `round.startedAt` in time-elapsed calculation. Handle `startedAt` being null (round not yet live) by returning `0` or early-exiting.
  - No other logic changes required.

- [ ] Copy `game-lifecycle.service.ts` → `apps/music-bot/src/services/game-lifecycle.service.ts`
  - **Fix B3 (service side):** Remove all the multi-attempt re-fetch blocks. `getCurrentGameByChatId` now returns reliably. `start()` simplifies to: check for ACTIVE game → check for tracks → find or create LOBBY game → `startGameFromLobby()`. The 50-line re-fetch fallback block is deleted entirely.
  - Replace `ctx.chat.id` with `chatId: number` parameter (services should not take `ctx` — they are framework-agnostic)
  - No Telegraf imports remain.

- [ ] Copy `round-orchestrator.service.ts` → `apps/music-bot/src/services/round-orchestrator.service.ts`
  - **Fix B2:** Replace `ctx` parameter with `chatId: number, api: Api` (grammY `Api` type from `grammy`)
  - Replace all `ctx.reply(...)` → `api.sendMessage(chatId, ...)`
  - Replace all `ctx.telegram.copyMessage(...)` → `api.copyMessage(...)`
  - Replace `ctx.replyWithAudio(...)` → `api.sendAudio(chatId, ...)`
  - Remove scheduler callbacks that capture `ctx`. Replace with:
    ```typescript
    await this.scheduler.scheduleOnce(
      `hint:${round.id}`,
      new Date(Date.now() + game.hintDelaySec * 1000),
      'hints',
      { roundId: round.id, chatId },
    );
    ```
  - Add `showHintById(roundId: number, chatId: number, api: Api)` method for the worker to call
  - **Fix B1 (orchestrator side):** Call `gameRepository.setRoundLive(round.id)` at the start of `startRound`, before sending audio. This is the single reliable place `startedAt` is set.

- [ ] Copy `music-game.service.ts` → `apps/music-bot/src/services/music-game.service.ts`
  - Replace Telegraf `Context` / `CommandContext` / `CallbackQueryContext` type imports with grammY equivalents
  - All method signatures that took `ctx: CommandContext` now take `ctx: BotContext` (grammY)
  - Methods that delegated to `roundOrchestrator.startRound(ctx, chatId)` now pass `chatId` and `ctx.api`
  - Remove dead scoring helper methods (`calculatePointsTimeBased`, `calculatePointsAdvanced`, `calculatePoints`) — these exist in `MusicGameService` but are never called; actual scoring is in `GuessService` via `scoringByPreset`. Delete to reduce confusion.

---

## Phase 7 — ActionCodec port and length guard
*Goal: ActionCodec works in grammY, B4 fixed.*

- [ ] Copy `action.codec.ts` → `apps/music-bot/src/codec/action.codec.ts`
- [ ] **Fix B4:** Add byte-length guard to `encode()`:
  ```typescript
  encode(action: string, ...args: (string | number | bigint)[]): string {
    const data = [action, ...args.map(String)].join(':');
    if (Buffer.byteLength(data, 'utf8') > 64) {
      throw new Error(`callback_data exceeds 64 bytes: "${data}" (${Buffer.byteLength(data, 'utf8')} bytes)`);
    }
    return data;
  }
  ```
- [ ] Write tests for `encode` / `decode` round-trips for all existing action patterns (guess, lobby, settings, players, gameplay)
- [ ] Write test that confirms `encode` throws when output would exceed 64 bytes

---

## Phase 8 — BullMQ workers
*Goal: hint and auto-advance fire from Redis jobs, not in-memory timers.*

- [ ] Add `bullmq` to `apps/music-bot/package.json`
- [ ] Implement `apps/music-bot/src/workers/hint.worker.ts`:
  ```typescript
  // Receives: { roundId: number, chatId: number }
  // Calls: roundOrchestratorService.showHintById(roundId, chatId, bot.api)
  ```
- [ ] Implement `apps/music-bot/src/workers/advance.worker.ts`:
  ```typescript
  // Receives: { gameId: number, chatId: number }
  // Calls: roundOrchestratorService.advanceToNextRound(gameId, chatId, bot.api)
  ```
- [ ] Both workers must handle errors gracefully: log, do not crash the worker process, do not retry indefinitely (configure BullMQ `attempts: 3, backoff: { type: 'exponential', delay: 5000 }`)
- [ ] Register both workers in `apps/music-bot/src/index.ts` bootstrap sequence, after bot is initialized (workers need `bot.api`)

---

## Phase 9 — grammY composers (feature modules)
*Goal: all handlers ported to grammY syntax, wired into the bot.*

### 9.0 Context and container setup
- [ ] Write `apps/music-bot/src/context.ts` with `BotContext = Context & SessionFlavor<SessionData>` and `SessionData = { selectedChatId?: number }`
- [ ] Port `container.ts` — same Inversify bindings, update import paths to new package structure, remove bindings for modules not in this bot (FoodModule, JokerModule, SorryModule, CraftyModule, etc.)
- [ ] Confirm `SceneSessionData` usage — if `ctx.scene` is never called in any ported handler, remove it from `SessionData`

### 9.1 Upload composer (private chat)
- [ ] Create `apps/music-bot/src/features/upload/upload.composer.ts` extending grammY `Composer<BotContext>`
- [ ] Port `handleStartCommand` (group selector) — same logic, `ctx.from.id`, `ctx.reply()` unchanged in grammY
- [ ] Port `handleChatSelectAction` — filter `'callback_query:data'` + regex match
- [ ] Port `handleAudioMessage` — filter `':message:audio'`
- [ ] Port `handleHintMessage` — filter `':message'` (or enumerate subtypes)
- [ ] Replace `message('audio')` style imports with grammY filter strings throughout
- [ ] Replace `ctx.telegram` → `ctx.api` for any raw API calls

### 9.2 Lobby handler/UI
- [ ] Create `apps/music-bot/src/features/lobby/lobby.handler.ts`
- [ ] Port `LobbyHandler` — replace Telegraf types with grammY types, `answerCbQuery` → `answerCallbackQuery`
- [ ] Port `LobbyUi` — no framework imports, pure object construction; copy verbatim
- [ ] Add `/music` as the new entry command (replaces `/music_lobby` as the single group entry point)

### 9.3 Gameplay handler/UI
- [ ] Port `GameplayHandler` to grammY (paste code first — not reviewed yet)
- [ ] Port `GameplayUi`
- [ ] Confirm all callback_data patterns are registered in `ActionHelper` / `ActionCodec`

### 9.4 Info handler/UI
- [ ] Port `InfoHandler` to grammY (paste code first — not reviewed yet)
- [ ] Port `InfoUi`
- [ ] Remove commands that are now button-driven; keep only the ones listed in spec Section 3.4

### 9.5 Main composer wiring
- [ ] Create `apps/music-bot/src/index.ts`:
  - Init bot: `new Bot<BotContext>(token)`
  - Register `session()` middleware
  - Register `membershipSyncMiddleware` from `@feyyus/bot-kit`
  - Register `Router` for private/group split (from `@grammyjs/router`)
  - Register feature composers
  - Call `bot.api.setMyCommands()` with scoped command lists (spec Section 3.4)
  - Start BullMQ workers
  - `bot.start()`
  - Graceful shutdown: `bot.stop()`, drain workers, `prisma.$disconnect()`
- [ ] Smoke test: start bot locally, send `/start` in private — confirm group selector appears
- [ ] Smoke test: `/music` in a test group — confirm lobby panel renders

---

## Phase 10 — Docker and deployment
*Goal: `docker compose up` in infra/ starts the full stack.*

- [ ] Write `apps/music-bot/Dockerfile` (multi-stage: pnpm install at root → build packages → copy to final image)
- [ ] Add `music-bot` service to `infra/docker-compose.yml` per spec Section 11.1
- [ ] Test: `docker compose up` from `infra/` — confirm all three services (postgres, redis, music-bot) start and bot responds to `/start`
- [ ] Test: `docker compose restart music-bot` while a game is mid-round with scheduled hints — confirm hints fire after restart (validates BullMQ durability)
- [ ] Add `.env.example` at repo root documenting all required env vars

---

## Phase 11 — End-to-end game flow validation
*Goal: a full game can be played by real humans in a test group.*

- [ ] At least 2 test users submit audio tracks via private chat
- [ ] Organizer opens `/music` → lobby panel → starts game
- [ ] Both users receive the round audio with guess buttons
- [ ] Both users guess — correct/wrong feedback appears
- [ ] Hint fires automatically after `hintDelaySec` (confirm from Redis job, not setTimeout)
- [ ] Organizer advances to next round manually
- [ ] Game ends, leaderboard appears
- [ ] Restart bot mid-round, confirm auto-advance still fires from BullMQ
- [ ] All bugs B1–B5 verified fixed:
  - [ ] B1: Elapsed time in scoring uses `startedAt`, not `createdAt`
  - [ ] B2: Hint fires after bot restart (not from in-memory timer)
  - [ ] B3: No re-fetch loops in `GameLifecycleService.start()`
  - [ ] B4: `ActionCodec.encode()` throws in test for >64 byte output
  - [ ] B5: (Acknowledged, not behaviorally fixable — documented in requirements)

---

## Phase 12 — Wallet integration (after game is stable)
*Do not start this phase until Phase 11 is complete and the bot is deployed.*

- [ ] Decide payment provider (Telegram Stars vs external)
- [ ] Implement payment handler in `apps/music-bot/src/features/payment/`
- [ ] On successful payment: call `walletService.credit(userId, amount, 'purchase:stars', providerTxId)`
- [ ] Implement balance check command `/balance` or button in `/start` menu
- [ ] Identify first purchasable feature (e.g. extra game config option, more rounds) — implement the `wallet.debit()` call at the point of use
- [ ] Write integration test: payment webhook fires twice with same tx ID → balance credited exactly once

---

## Deferred (tracked, not planned)

- Replace Inversify with plain factory functions (post-stabilization)
- Drizzle ORM evaluation (post-launch)
- `@grammyjs/conversations` for multi-step flows if Scenes are found to be load-bearing
- Redis session storage adapter (`@grammyjs/storage-redis`) if session loss on restart becomes a real user complaint
- Turborepo build caching if `pnpm build` times become painful
- Second bot scaffolding (reuse `bot-kit`, `wallet`, `scheduler` packages — no new infrastructure work needed)