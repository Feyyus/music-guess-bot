# Technical Specification
## Music Bot Migration

**Status:** Draft  
**Depends on:** requirements.md  

---

## 1. Repository structure

Pnpm workspaces monorepo. One repo, separate deployable processes, shared packages imported directly (no npm publish step, no version-bump dance).

```
repo-root/
├── apps/
│   └── music-bot/              # grammY bot process
├── packages/
│   ├── db/                     # Prisma schema, client, migrations, seed
│   ├── wallet/                 # Coin ledger — credit, debit, balance, idempotency
│   ├── scheduler/              # BullMQ wrapper — enqueue, define workers
│   └── bot-kit/                # Shared grammY middleware (session, membership sync, permissions, i18n)
├── infra/
│   └── docker-compose.yml      # postgres, redis, music-bot (expandable to more bots)
├── pnpm-workspace.yaml
└── turbo.json                  # (optional) Turborepo for build caching
```

Package scope: `@feyyus/*` (or whatever short handle you settle on — pick once, stay consistent).

Internal dependency graph:
```
music-bot  →  bot-kit, wallet, scheduler, db
bot-kit    →  db
wallet     →  db
scheduler  →  (redis only, no db dependency)
db         →  (leaf — prisma client, no app dependencies)
```

No circular dependencies. `db` is the only package that touches Prisma directly; everything else goes through it.

---

## 2. Technology decisions

| Concern          | Choice                         | Rationale                                                                                                                                                                       |
| ---------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bot framework    | grammY                         | Better TypeScript types, active maintenance, plugin ecosystem. Composer pattern preserved.                                                                                      |
| ORM              | Prisma (keep)                  | Working schema + migrations. No pain points justify switching mid-migration. Revisit Drizzle after the bot is launched.                                                         |
| Database         | Single PostgreSQL              | Relational integrity, transactional wallet operations, foreign key enforcement. Split only if independently scaling domains (not applicable now).                               |
| Job scheduling   | BullMQ + Redis                 | Fixes B2 (stale ctx) and the silent-drop-on-restart bug. Redis is the only justified new infra addition.                                                                        |
| DI container     | Inversify (keep for now)       | Cost of removing it simultaneously with framework + repo migration is too high. Deferred simplification: replace with plain constructor factories once bot is stable on grammY. |
| Monorepo tooling | pnpm workspaces                | Simplest path. Add Turborepo build caching later only if build times actually become painful.                                                                                   |
| Deployment       | Docker Compose on homelab      | One container per bot process, shared Postgres + Redis containers.                                                                                                              |
| Payment provider | TBD — Telegram Stars preferred | Keeps users in-app, no payment compliance burden. Evaluate Stars API limits before committing.                                                                                  |

---

## 3. Architecture: apps/music-bot

### 3.1 Entry point

`src/index.ts` — creates the grammY `Bot<BotContext>`, registers middleware stack, starts polling or webhook, registers BullMQ workers.

```
Bootstrap sequence:
  1. Load config (env vars, fail fast on missing)
  2. Init Prisma client (from @feyyus/db)
  3. Init BullMQ connection (from @feyyus/scheduler)
  4. Build DI container (Inversify, same pattern as current container.ts)
  5. Register middleware stack on bot
  6. Register BullMQ workers (hint worker, advance worker)
  7. bot.start() — long polling
  8. Graceful shutdown handler: drain queue workers, stop bot, disconnect Prisma
```

### 3.2 Middleware stack

Grammy middleware runs top-to-bottom. Order matters.

```
bot.use(session(...))                    // grammY session, same shape as current BotSession
bot.use(membershipSyncMiddleware)        // from bot-kit: upsert user, chat, membership on every group update
bot.use(router)                          // route private-chat updates to upload flow, group updates to game flow
```

The current `if (ctx.chat.type === 'private')` branch in `bot.ts` becomes a grammY `Router` from `@grammyjs/router`, which is the idiomatic Grammy equivalent.

### 3.3 Context type

Replace Telegraf's generic-heavy `NarrowedContext<IBotContext, Update.X>` with grammY's flavor composition:

```typescript
import { Context, SessionFlavor } from 'grammy';

interface SessionData {
  selectedChatId?: number;
}

export type BotContext = Context & SessionFlavor<SessionData>;
```

Handler signatures become `(ctx: BotContext) => Promise<void>`. Filter narrowing is handled by grammY's `ctx.has()` / `filter()` inside handlers, not at the type level.

### 3.4 Command/UX entry points

Following the one-command-per-context requirement (PRD 5.4):

**In private chat:**
- `/start` → show group selector (same as current `handleStartCommand`)
- Everything else is button-driven from there

**In group chat:**
- `/music` → render lobby panel (replaces `/music_lobby` as the single entry point)
- Power-user commands retained in `setMyCommands` (group scope): `/music_stats`, `/music_help`, `/music_ping`
- All other current commands (`/music_game`, `/music_lobby`, `/music_start`, `/music_end`, `/music_info`, `/music_list`, `/music_players`, `/music_organizer_help`, `/music_dev_help`) become buttons within the lobby panel flow, not slash commands

`bot.api.setMyCommands()` called at startup with scoped lists:
```typescript
// Private chat scope
[{ command: 'start', description: 'Select a group and submit your track' }]

// Group chat scope  
[
  { command: 'music', description: 'Open the music game lobby' },
  { command: 'music_stats', description: 'Show current game stats' },
  { command: 'music_ping', description: 'Ping all players' },
  { command: 'music_help', description: 'How to play' },
]
```

### 3.5 Feature modules

Same decomposition as current, ported to grammY Composer:

```
src/
├── features/
│   ├── upload/         # Private chat: group select, audio submission, hint upload
│   │   └── upload.composer.ts
│   ├── lobby/          # Group: lobby panel, settings, player management
│   │   ├── lobby.handler.ts
│   │   └── lobby.ui.ts
│   ├── gameplay/       # Group: round flow, guess processing, hint display
│   │   ├── gameplay.handler.ts
│   │   └── gameplay.ui.ts
│   └── info/           # Group: stats, leaderboard, player list, help
│       ├── info.handler.ts
│       └── info.ui.ts
├── workers/
│   ├── hint.worker.ts          # BullMQ worker: fires showHint for a roundId
│   └── advance.worker.ts       # BullMQ worker: fires advanceToNextRound for a gameId
├── services/
│   ├── music-game.service.ts
│   ├── game-lifecycle.service.ts
│   ├── round-orchestrator.service.ts
│   └── guess.service.ts
├── repository/
│   └── music-game.repository.ts
├── codec/
│   └── action.codec.ts
├── container.ts
├── context.ts
└── index.ts
```

---

## 4. Architecture: packages/db

Single Prisma schema for the entire system. All bots and the wallet share one schema, one migration history, one client.

### 4.1 Schema changes from current

**Remove `Chat.activeGameId` (fixes B3).**  
Active game is queried exclusively by `Game.status = ACTIVE AND Game.chatId = X`. The `activeGameId` FK and `activeGame` / `activeInChat` relations on both `Chat` and `Game` are dropped. This eliminates the dual-source-of-truth divergence that caused `GameLifecycleService`'s multi-attempt re-fetch logic.

**Fix `GameRound.startedAt` reliability (required for B1 fix).**  
`startedAt` exists but is set inconsistently. Add a Prisma middleware or explicit service call to guarantee `startedAt = NOW()` at the exact moment `phase` transitions from `DRAFT → LIVE`. `GuessService` will use `startedAt` for elapsed-time scoring instead of `createdAt`.

**Rename for clarity (non-breaking, do in one migration):**
- `Game.currentRound` → `Game.currentSequence` (matches TODO in schema)
- `GameRound.roundIndex` → `GameRound.sequence` (matches TODO in schema)

**Add Wallet domain (new tables):**

```prisma
model Wallet {
  id        Int      @id @default(autoincrement())
  userId    BigInt   @unique  // Telegram user ID — the shared key across all bots
  balance   Int      @default(0)  // Cached sum; always reconcilable from transactions
  updatedAt DateTime @updatedAt

  user         User               @relation(fields: [userId], references: [id])
  transactions WalletTransaction[]
}

model WalletTransaction {
  id             Int      @id @default(autoincrement())
  createdAt      DateTime @default(now())
  walletId       Int
  amount         Int      // Positive = credit, negative = debit
  reason         String   // e.g. "purchase:stars", "spend:extra_round", "refund:..."
  relatedEntityId String? // e.g. payment provider transaction ID, game ID, etc.
  idempotencyKey  String  @unique  // Provider tx ID or generated key; DB-enforced uniqueness

  wallet Wallet @relation(fields: [walletId], references: [id])
}
```

`Wallet` is auto-created on first use (`upsert` on credit). Balance is a cached denormalization; the authoritative value is always `SUM(amount) FROM WalletTransaction WHERE walletId = X`.

### 4.2 Package exports

```typescript
// @feyyus/db
export { PrismaClient, prisma } from './client'   // singleton client
export * from '@prisma/client'                      // re-export all generated types
```

All Prisma type imports in `music-bot` and `wallet` come from `@feyyus/db`, not directly from `@prisma/client`, so there is one generated client across the monorepo.

---

## 5. Architecture: packages/wallet

Thin domain layer over the `WalletTransaction` table. No HTTP server. Imported directly by bots as a package.

```typescript
// @feyyus/wallet
export class WalletService {
  // Credit coins. Idempotent: duplicate idempotencyKey is a no-op (returns existing tx).
  async credit(userId: bigint, amount: number, reason: string, idempotencyKey: string): Promise<WalletTransaction>

  // Debit coins. Throws InsufficientFundsError if balance < amount.
  async debit(userId: bigint, amount: number, reason: string, idempotencyKey: string): Promise<WalletTransaction>

  // Current balance (from cached Wallet.balance, fast).
  async getBalance(userId: bigint): Promise<number>

  // Full transaction history (from WalletTransaction log, authoritative).
  async getHistory(userId: bigint): Promise<WalletTransaction[]>
}

export class InsufficientFundsError extends Error {}
```

Both `credit` and `debit` run inside a Prisma `$transaction` that updates `Wallet.balance` and inserts `WalletTransaction` atomically. The `idempotencyKey` unique constraint on `WalletTransaction` is the last line of defence against double-crediting — it will throw a Prisma unique constraint error on the second call, which `credit()` catches and converts to a silent return of the existing transaction.

---

## 6. Architecture: packages/scheduler

BullMQ wrapper. Replaces `SchedulerService`'s in-memory `setTimeout` map with Redis-backed durable delayed jobs.

```typescript
// @feyyus/scheduler
export class SchedulerService {
  // Enqueue a delayed job. Idempotent by jobId: replaces existing job with same id.
  async scheduleOnce(jobId: string, dueAt: Date, queue: string, data: unknown): Promise<void>

  // Cancel a scheduled job.
  async cancel(jobId: string, queue: string): Promise<void>
}
```

**Critical design constraint (fixes B2):** Jobs carry only plain serializable data (`{ roundId, chatId }`, `{ gameId, chatId }`). They do not carry `ctx` or any Telegraf/grammY context object. Workers in `apps/music-bot/src/workers/` receive the job data, create a fresh `bot.api` call or call a service method that uses `bot.api` directly, not a captured context.

```typescript
// apps/music-bot/src/workers/hint.worker.ts
worker.on('hint', async (job) => {
  const { roundId, chatId } = job.data;
  await roundOrchestratorService.showHintById(roundId, chatId, bot.api);
});
```

`RoundOrchestratorService` gets a new method `showHintById(roundId, chatId, api)` that fetches fresh state from DB and uses the provided `api` object rather than a stale `ctx.telegram`.

---

## 7. Architecture: packages/bot-kit

Shared grammY middleware used by all bots. Keeps common concerns out of individual bot codebases.

```
bot-kit/
├── middleware/
│   ├── membership-sync.ts    # Upsert user + chat + membership on group updates
│   └── permissions.ts        # Permission check helper (port of RequirePermission decorator)
├── text/
│   └── text.service.ts       # i18n text lookup (port of current TextService)
└── index.ts
```

The membership sync middleware is extracted verbatim from the current `bot.ts` inline middleware — this is already the right logic, just in the wrong place.

---

## 8. Scheduler: hint and auto-advance flow (replaces stale-ctx pattern)

Current (broken for restarts):
```
startRound(ctx) → scheduleOnce(key, dueAt, async () => showHint(ctx, chatId))
                                                         ^^^^ stale ctx captured
```

New (durable, ctx-free):
```
startRound(chatId, api):
  → gameRepository.setRoundLive(roundId, startedAt: NOW())   // B1 fix: set startedAt
  → playRound(chatId, api, participants, round)
  → scheduler.scheduleOnce(`hint:${roundId}`, dueAt, 'hints', { roundId, chatId })
  → scheduler.scheduleOnce(`advance:${gameId}`, dueAt, 'advance', { gameId, chatId })

hint worker receives { roundId, chatId }:
  → roundOrchestrator.showHintById(roundId, chatId, bot.api)

advance worker receives { gameId, chatId }:
  → roundOrchestrator.advanceToNextRound(gameId, chatId, bot.api)
```

`startRound` no longer accepts a grammY `Context` — it accepts `chatId: number` and `api: Api` (grammY's bot API client). All callers updated accordingly.

---

## 9. grammY migration notes

### 9.1 What survives unchanged
- Overall Composer-per-feature decomposition
- Service / repository separation
- Inversify DI container pattern
- ActionCodec encode/decode logic (add length guard per B4)
- Scoring strategy pattern
- All Prisma repository methods (modulo schema changes in Section 4.1)
- Session shape (`{ selectedChatId?: number }`)

### 9.2 Mechanical changes (tedious but not risky)

**Filter syntax.** Every `message('audio')`, `message('text')`, etc. (Telegraf filter imports) becomes grammY's `:message:audio`, `:message:text` filter query strings via `bot.on()` / `composer.on()`.

```typescript
// Telegraf
this.on(message('audio'), handler)

// grammY
this.on(':message:audio', handler)
// or equivalently
this.on('message:audio', handler)
```

**Callback query handler.** `callbackQuery('data')` (Telegraf) → `'callback_query:data'` filter (grammY).

**Context narrowing.** `NarrowedContext<IBotContext, Update.X>` → grammY's `Filter<BotContext, 'message:audio'>` or simply `BotContext` with `ctx.has()` guard inside the handler. The type complexity reduces substantially.

**`replyWithAudio`.** Telegraf's `ctx.replyWithAudio(fileId, opts)` → grammY's `ctx.replyWithAudio(fileId, opts)` — same signature, same name. This specific one is a free port.

**Telegraf-specific imports.** `Markup.inlineKeyboard`, `Markup.button.callback` → grammY builds inline keyboards as plain objects (same structure Telegram expects):
```typescript
// Telegraf
Markup.inlineKeyboard([Markup.button.callback('text', 'data')])

// grammY (plain object — no import needed)
{ inline_keyboard: [[{ text: 'text', callback_data: 'data' }]] }
```

**`answerCbQuery`.** `ctx.answerCbQuery(text)` → `ctx.answerCallbackQuery(text)` (grammY rename).

**`copyMessage`.** `ctx.telegram.copyMessage(...)` → `ctx.api.copyMessage(...)` (grammY uses `ctx.api` instead of `ctx.telegram`).

### 9.3 Scenes
`IBotContext` declares `scene: Scenes.SceneContextScene<...>` but no handler in the reviewed code actually calls `ctx.scene.enter()` or similar. Confirm this is dead code before migration. If unused: remove `SceneSessionData` from `SessionData`, drop the `scene` property. If used somewhere not reviewed: port to `@grammyjs/conversations`.

### 9.4 grammY plugins in use
- `@grammyjs/router` — replaces the `if (ctx.chat.type === 'private')` branch in bot entry
- `grammy` sessions (built-in) — direct replacement for Telegraf session
- `@grammyjs/storage-redis` — optional: Redis session storage adapter, useful if you want sessions to survive restarts (currently session state is only `selectedChatId`, which is non-critical, so in-memory default is fine to start)

---

## 10. ActionCodec: length guard (B4 fix)

```typescript
encode(action: string, ...args: (string | number | bigint)[]): string {
  const data = [action, ...args.map(String)].join(':');
  if (Buffer.byteLength(data, 'utf8') > 64) {
    throw new Error(`callback_data exceeds 64 bytes: "${data}" (${Buffer.byteLength(data, 'utf8')} bytes)`);
  }
  return data;
}
```

Throws at development time. Caught in tests. Never silently truncates in production.

---

## 11. Deployment

### 11.1 docker-compose.yml (infra/)

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: botdb
      POSTGRES_USER: bot
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U bot"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data
    command: redis-server --appendonly yes

  music-bot:
    build:
      context: ..
      dockerfile: apps/music-bot/Dockerfile
    environment:
      DATABASE_URL: postgresql://bot:${POSTGRES_PASSWORD}@postgres:5432/botdb
      REDIS_URL: redis://redis:6379
      BOT_TOKEN: ${MUSIC_BOT_TOKEN}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_started
    restart: unless-stopped

volumes:
  postgres_data:
  redis_data:
```

### 11.2 Dockerfile (apps/music-bot/)

Multi-stage build: install deps at root (pnpm workspace), build all packages, copy only the built output and production node_modules into the final image.

### 11.3 Environment variables per bot

Each bot container gets only the env vars it needs. `MUSIC_BOT_TOKEN` is only in the `music-bot` container; a future bot gets its own `*_BOT_TOKEN`. `DATABASE_URL` and `REDIS_URL` are shared (same Postgres/Redis, different app-level schemas if needed later).

---

## 12. What is explicitly deferred (not in this migration)

- **Replacing Inversify with plain factory functions.** Correct direction, wrong timing. Revisit after grammY migration is stable.
- **Drizzle ORM.** No evidence of Prisma pain that would justify the migration cost now.
- **Web dashboard / non-Telegram wallet access.** Requires account-linking layer not needed until there is a web surface.
- **Multi-instance / horizontal scaling of bots.** BullMQ solves the immediate timer problem; horizontal scaling of the bot process itself is not needed at hundreds-of-chats scale.
- **Splitting Postgres into per-domain databases.** No independent scaling requirement exists now.
- **Payment provider selection.** Telegram Stars preferred but not confirmed. Wallet package is provider-agnostic; the provider only determines what calls `wallet.credit()`.