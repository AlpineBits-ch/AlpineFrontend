# Web Push — backend contract needed for the browser client

Status: **requested, not implemented.** Written from the client side on 2026-08-11 while porting the
app to run in a browser. Port this into the Echo repo's `docs/specs/` alongside the other frontend
guides; it lives here so it is not lost in the meantime.

## Why

`UserTokenService` mints only `Fcm` (Android/desktop) and `ApnsVoip` (iOS). A browser can do neither.
Without a third kind, a web user gets **no notification at all once the tab is closed** — the client
shows foreground toasts while a tab is open and nothing beyond that. Everything below is blocked on
the server; the client-side service worker is our work and is gated on items 1–3.

## 1. A `WebPush` token kind

Accepted on `POST /api/v1/identity/users/self/push-token` and on the corresponding `DELETE`
(currently `?token=&kind=`).

## 2. It is not a token

A browser hands us a `PushSubscription`, not a string:

```
{ endpoint: URL, expirationTime: number | null, keys: { p256dh: string, auth: string } }
```

- `endpoint` — the routable identity. The host varies by browser vendor: `fcm.googleapis.com`,
  `web.push.apple.com`, `*.notify.windows.com`.
- `p256dh` — base64url uncompressed P-256 point, 87 chars.
- `auth` — 16 random bytes, 22 chars base64url.

**Please add explicit nullable `endpoint`, `p256dh` and `auth` fields, required when
`kind == WebPush`**, rather than stuffing JSON into `token`. A JSON blob in a string column cannot be
indexed on `endpoint`, which is what deletion and dead-subscription cleanup need to key on.

For `DELETE`, key on `endpoint` (or on `deviceId + kind`). The client can re-read its subscription at
sign-out, which is what the local store copy is for.

## 3. A VAPID keypair, server-generated and stable

The P-256 **public** key must be fetchable by the client — `PushManager.subscribe` requires it as
`applicationServerKey`. Either a dedicated endpoint (`GET /api/v1/identity/push/vapid-public-key`) or
a field in the existing config document.

**Rotating it invalidates every existing subscription**, so treat it as effectively permanent.

## 4. Sender side

RFC 8030 `POST` to the endpoint. Payload encrypted `aes128gcm` per RFC 8188 / RFC 8291.
`Authorization: vapid t=<ES256 JWT>, k=<pubkey>` per RFC 8292. `TTL` header required.

Payload ceiling is ~4 KB (≈3993 usable). `Topic` gives server-side coalescing and is the natural
mapping for the client's existing notification `tag`.

## 5. Dead-subscription handling

**410 Gone or 404 from the push service means the subscription is dead** — delete that device row,
exactly as `UNREGISTERED` is handled for FCM. Also handle 413 (payload too large) and
429 with `Retry-After`.

## 6. A decision only the server can make: silent pushes

**Chrome enforces `userVisibleOnly: true`.** Every Web Push must produce a visible notification, or
the browser shows its own "site updated in the background" toast instead.

So data-only pushes — MLS commit nudges, presence updates — **cannot be delivered to web the way
they are to mobile.** Either they carry a user-visible notification, or `WebPush` rows are excluded
from them. This needs an explicit server-side choice; there is no client workaround.

## 7. No CallKit analogue

An `ApnsVoip`-style ring has no web equivalent. A web call ring is an ordinary notification, with
whatever latency and dismissal behaviour that implies.

## Client-side prerequisites (our work, blocked on 1–3)

- A service worker at origin scope with `push` and `notificationclick` handlers, posting the tag back
  to the page so click routing still resolves to a conversation.
- HTTPS, which the deployment already requires for other reasons.

## What a web user gets before any of this lands

Foreground toasts while a tab is open — title, body, avatar icon, per-conversation coalescing via
`tag`, click to focus and navigate, notification sounds, and all existing category and cooldown
filtering. A denied permission is reported rather than retried, because
`Notification.requestPermission()` on a denied origin resolves `denied` without prompting.

The `backgroundPush` capability flag is false on web for exactly this reason, and is distinct from
`nativeToasts`: a tab _can_ show a toast, it just cannot receive one while closed. Settings copy must
say "notifications only arrive while Venta is open" rather than "notifications unavailable".
