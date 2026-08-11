# WAGSS — Single-Account WhatsApp Gateway

Gateway WhatsApp ber-akun tunggal yang dioperasikan lewat **web UI** oleh
beberapa user yang login. Remake dari [wag](https://github.com/vermaysha/wag)
(multi-session) menjadi single-account, dengan Postgres, penyimpanan pesan
& kontak persisten, typing indikator real-time, dan balasan yang
mencantumkan username user yang membalas.

## Fitur

- **Satu akun WhatsApp**, dikelola bersama oleh banyak user web
- **Login multi-user** (username + password, cookie JWT HttpOnly)
- **Semua pesan tersimpan** di Postgres (incoming + outgoing, tanpa cap)
- **Kontak tersimpan** di Postgres, auto-sync dari event Baileys
- **Full history**: `syncFullHistory` aktif — riwayat chat lama ikut tersimpan
- **Media on-demand ala WhatsApp Web**: metadata + thumbnail (blur) disimpan,
  file asli diunduh saat tombol Download ditekan (`GET /media/...?download=1`),
  sticker auto-download. View-once tidak diunduh.
- **Groups + participants**, **reactions**, **message status timeline**
  (sent → delivered → read, per penerima) tersimpan semua.
- **Realtime** (SSE, tanpa refresh): pesan masuk, reaksi, read tick, typing,
  presence, kontak, grup, hapus/edit pesan.
- **Edit & hapus pesan**: protocolMessage `MESSAGE_EDIT`/`REVOKE` diproses —
  teks diedit (`edited_at` + badge "(diedit)") atau ditandai dihapus
  ("Pesan dihapus"), realtime via SSE.
- **Labels kontak** (`labels.edit`/`labels.association`) disimpan di `contacts.labels`.
- **Metadata grup lanjutan**: invite code, member-add mode, join-approval mode,
  subject/desc owner + waktu.
- **Read receipt**: `read_at` di DB + `sendReceipt` ke WhatsApp
- **Typing real-time** dua arah: antar operator (UI↔UI) & ke WhatsApp
  (`sendPresenceUpdate composing/paused`)
- **Reply attribution**: outgoing menampilkan `-username` pembalas
  (mis. `WAGSS : Halo -reno`)
- **User management** via UI: user yang login bisa membuat user lain
- QR code / pairing code untuk menghubungkan akun
- **Anti-spam QR**: jika QR/pairing tidak kunjung selesai dalam 60 detik
  (default, atur `QR_TIMEOUT_SECONDS`), proses Baileys berhenti total —
  tidak regenerate QR 24/7. Mulai ulang manual lewat tombol
  "Pairing via QR Code" atau "Pairing via Number".
- **Toggle Baileys online/offline** di web UI (Start / Stop)

## Teknologi

- [Bun](https://bun.sh/) 1.2+ runtime
- [Elysia.js](https://elysiajs.com/) web framework
- [Baileys](https://github.com/WhiskeySockets/Baileys) WhatsApp Web API
- Postgres (driver [postgres-js](https://github.com/porsager/postgres))
- Password: `Bun.password` (argon2id), sesi: JWT via `jose`

## Instalasi

### 1. Prasyarat

- Bun 1.2+
- Postgres lokal (peer auth / unix socket) — buat database:

```sh
createdb whatsapp
```

Atau beri koneksi di `.env` untuk Postgres remote (Neon, Supabase, dsb).

### 2. Setup

```sh
bun install
cp .env.example .env   # set JWT_SECRET, PORT, HOSTNAME, DATABASE_URL (opsional)
bun run db:migrate     # buat tabel
# User default `root` / `password` dibuat otomatis saat boot pertama
# (atur via DEFAULT_USERNAME/DEFAULT_PASSWORD di .env, atau kosongkan untuk disable)
```

### 3. Jalankan

```sh
bun run src/index.ts
```

Buka `http://127.0.0.1:3000`, login dengan `root` / `password`.

> Server bind ke `127.0.0.1` secara default. Untuk akses jarak, set
> `HOSTNAME=0.0.0.0` di `.env`.

## Perintah

| Perintah                                                      | Fungsi                        |
| ------------------------------------------------------------- | ----------------------------- |
| `bun run db:migrate`                                          | Jalankan migration Postgres   |
| `bun run db:seed --username X --password Y [--displayName Z]` | Buat user tambahan (opsional) |
| `bun run lint` / `format`                                     | Prettier check / write        |

## Skema Database (ringkasan)

Tabel utama (lihat `src/db/migrations/001_init.sql`):

- `auth_state` — creds & keys Baileys (JSONB)
- `messages` — semua pesan (type/text/device/forwarded/quoted/media meta), `sent_by_user`, `read_at`
- `message_reactions` — reaksi emoji per pesan
- `message_status` — timeline sent/delivered/read per penerima
- `contacts` — profil kontak/grup (notify, verified, business, about, dll.)
- `whatsapp_groups` + `group_participants` — metadata grup + anggota + admin
- `users` — akun web (username, password_hash argon2id, display_name)
- `schema_migrations` — tracking migration

## API (di-konsumsi web UI saja, semua butuh auth)

```
POST   /auth/login | POST /auth/logout | GET /auth/me | POST /auth/register
GET    /users | PATCH /users/:id | DELETE /users/:id
POST   /session/start {phoneNumber?} | POST /session/stop | POST /session/logout
GET    /session | GET /session/qr-code | POST /session/set-online {online}
POST   /session/refresh-groups
GET    /messages | GET /messages/:chatJid    POST /messages/send-text
POST   /messages/send-reply | /delete | /forward | /read
GET    /messages/:chatJid/status | /reactions
GET    /groups | /groups/:id | /groups/:id/participants
GET    /contacts | GET /contacts/:jid | GET /contacts/:jid/avatar
GET    /media/:chatJid/:messageId            # ?download=1 utk unduh bytes
POST   /presence/typing {jid,typing}
GET    /sse/live            # event: status, message, reaction, message_status,
                            # chat, typing, presence, group, contact, history_done
GET    /system/info
```

## Lisensi

MIT
