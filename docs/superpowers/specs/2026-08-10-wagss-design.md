# wagss — Single-Account WhatsApp Gateway Design

Date: 2026-08-10
Status: Approved

## Purpose

Remake of `wag` (WhatsApp Multi-Session API Gateway, fork of
`vermaysha/wag`) into a **single-account** WhatsApp gateway, consumed
exclusively through its bundled **web UI** (no external API clients).
Multiple web users can log in and jointly operate one WhatsApp account;
outgoing replies are attributed to the logged-in user.

## Stack

Bun + Elysia.js + Baileys + Postgres (local, `DATABASE_URL` env).
Passwords via built-in `Bun.password` (argon2id). JWT via `@elysiajs/jwt`.

## Key decisions (from questions)

- Postgres: local install, `DATABASE_URL` in `.env`.
- Web auth: username + password, HttpOnly JWT cookie.
- User management: flat — any logged-in user can create other users.
- Messages: all messages persisted, no cap.
- Read: persist `read_at` in DB **and** send read receipt to WhatsApp.
- Typing: both UI↔UI between operators and WA composing presence.
- First user: CLI seed command `bun run db:seed`.

## DB Schema

See `src/db/migrations/001_init.sql`:
`auth_state`, `messages`, `contacts`, `users`, `schema_migrations`.
Messages carry `sent_by_user` (username) + `sender_name` for reply
attribution. Read state = `read_at TIMESTAMPTZ`.

## API surface (no deviceId anywhere)

Auth `/auth/*`, Users `/users/*`, Session `/session/*`,
Messages `/messages/*`, Contacts `/contacts/*`,
Presence `/presence/typing`, SSE `/sse/live` (single multi-event stream),
System `/system/info`.

All routes require auth except `/auth/login`.

## SSE events

`status`, `message`, `typing` (UI↔UI), `presence` (WA), `chats`, `contacts`.

## Reply attribution

Outgoing: `sent_by_user = username`, `sender_name = displayName`.
UI renders `Pengirim : halo` (incoming) / `WAGSS : Halo -reno` (outgoing).

## Dropped from wag

`MAX_SESSIONS`, `connections` table, `SessionManager` Map, all `deviceId`
params, `webhookUrl` + `/test-callback` + webhook send + `dailyMessage*`,
per-device log/db dirs, in-memory message cap, UI Add-Device/Devices
modals + `currentDevice`.

## Kept from wag

`whatsapp-session.ts` Baileys internals (reconnect, retry queue, heartbeat)
refactored for single account + Postgres auth-state; `validate-phone-number.ts`;
`whatsapp-logger.ts` (single log path); SSE architecture (expanded to
multi-event); chat view UI structure.

## Implementation order (DB first)

1. DB layer (`db/client.ts`, `db/migrate.ts`, `001_init.sql`, `config.ts`)
2. Postgres auth-state adapter
3. Web auth (password, jwt, middleware, `/auth/*`, seed script, `/users/*`)
4. Message + contact stores (Postgres)
5. Session holder + whatsapp-session refactor (single account)
6. API routes (session, messages, contacts, presence, sse, server index)
7. Web UI (login, single-account chat, reply attribution, typing, read receipts, user mgmt)
