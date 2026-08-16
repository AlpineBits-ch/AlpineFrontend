# Rolling profile and message cache

**Status:** design, approved for spec review
**Date:** 2026-08-16

## The problem, stated precisely

Opening the app shows raw user ids - `user_riadh9fz3'04iwfefi` - for people the client has
resolved hundreds of times before. Avatars re-download on every paint. Neither is a bug in one
place; both are the absence of a cache, and they have different causes that need different fixes.

### Why the id appears

`ProfileService` holds two in-memory `signal` maps, `byProfileId` and `byUserId`. They are
unbounded and they are wiped on every reload. There is no bulk endpoint - `ProfileController`
exposes only `GET me`, `GET {id}` and `GET by-user/{id}` - so N distinct users on screen is N
round trips, on every launch, forever.

The service has already grown three mitigations *around* the missing cache:

- request coalescing (`inFlightByUserId`), so one change-detection pass does not fire ten GETs
  for the same id
- a 60s negative cache, so a failed id is not re-asked on every repaint
- a circuit breaker that, after three failures, hands back `FALLBACK_PROFILE` - literally
  `userName: 'Unknown User'`

Those exist because cold start floods the endpoint. When resolution has not landed yet, or when
the breaker is open, callers fall through to raw ids. This is not one call site, it is roughly
thirty:

| Site | Fallback |
|---|---|
| `system-message.component.ts:80` | `?? this.message().authorId` |
| `guild-member-list.component.ts:194` | `?? member.userId.slice(0, 8) + '…'` |
| `voice-channel.service.ts:943` | `?? e.userId` |
| `message.component.ts:340` | `?? 'Unknown'` |

The fallbacks are correct as written. The cache under them is what is missing.

### Why avatars re-download

`GET /api/v1/profiles/{id}/avatar` (`AvatarController.cs:16`) is anonymous and **302-redirects to
a presigned S3 URL minted fresh per request** (`FileService.cs:82`, `Expires = now + 10min`).
That URL carries `X-Amz-Date`, `X-Amz-Expires` and `X-Amz-Signature` query parameters that differ
on every request.

Browsers key the HTTP cache on the full URL *including query string*. The URL never repeats, so
the cache can never hit. There is no `Cache-Control` on the 302 either. **Every avatar render
re-downloads the full image from object storage.**

This is the single largest bandwidth item in the client, and it dictates a hard constraint on
everything below: any cache must key on the stable app-level URL, never on the presigned URL, or
it will miss exactly as reliably as the browser's does.

### What already exists and is fine

`MlsService` persists decrypted message *bodies* (mls.service.ts:765-901), sealed, keyed
`contextId#generation#messageId`, pruned oldest-first at `MESSAGE_CACHE_LIMIT = 5_000`. It is
bounded by entry count rather than bytes, and it holds only the body - no author, timestamp,
reactions, attachments or embeds - so a full hit still cannot render a message list.

**This cache stays exactly as it is.** It is sealed under the keychain key, it is part of the §D
backup envelope, and its security properties must not be inherited by a general cache. Its bytes
do not count against the budget below.

The storage layer is in good shape and is reused rather than rebuilt: `idb.ts` (typed KV over
IndexedDB) and `mls-local-store.web.ts` (memory mirror, cross-tab Web Locks, revision-marker
revalidation).

## Decisions

| Question | Decision |
|---|---|
| Budget | 100MB, covering profile metadata, profile images, and message metadata |
| Message scope | DTOs persisted minus the body (see Phase 3), used only to fill gaps; the server page always wins |
| Profile freshness | Always revalidate in background; cache paints first |
| MLS plaintext cache | Untouched, separate, uncounted |
| Backend | In scope, and goes first; local cache scope is reassessed after measurement |
| At rest | Metadata sealed; image bytes plain |

### On "always revalidate"

This is safer with a cache than without. Today a 429 storm is fatal - blank names and raw ids.
With the cache already painted, the same storm is cosmetic: names are briefly stale. Revalidation
must therefore be throttled and strictly off the critical path, so it never crowds out the app's
own requests.

### On sealing

The sealing key is `localStateKey` (mls.service.ts:935), held by `SecureStore` - the OS keychain
on desktop, IndexedDB on web. It is **not** derived from a vault unlock, so it is available at
boot and does not delay cold-start hydration.

One hard rule follows. `SecureStore` reads collapse every error to `null`, so a *locked* keychain
is indistinguishable from an *absent* key. The cache must reuse `localStateKey` and must **never
mint a key on a failed read**: minting there would silently orphan the entire cache. A failed key
read degrades to today's behaviour - empty cache, raw ids - and nothing worse.

Image bytes are plain because avatars are already served anonymously to anyone holding a profile
id. Sealing them protects nothing that is not already public, and it would force every avatar
onto an async decrypt → `Blob` → object URL path, rewriting ~30 `[src]` bindings for no security
gain.

## Phase 0 - server fix, then measure

Goes first. Its result decides how much of Phase 2 is still worth building.

**Make the presigned URL stable.** Rather than proxying bytes through the API, round `Expires` to
a bucket boundary so every request inside the window mints an identical URL:

```
Expires = ceil(now / 1h) * 1h + 1h    // same URL for every caller in this hour
```

The trailing `+ 1h` is deliberate, not double-rounding: without it a URL minted at 10:59 expires
sixty seconds later. Rounding fixes the *identity* of the URL; the extra hour is what keeps the
URL minted at the end of a window usable for as long as the one minted at its start. Validity
therefore ranges from one to two hours, and the redirect's `max-age` must be set from the
remaining lifetime rather than a constant, or the browser will cache a redirect to an already
expired signature.

Add `Cache-Control` to the 302 so the redirect itself is cacheable for the same window. The
browser's own HTTP cache then works, on every client, with no client change at all.

**Add validators to the profile JSON routes.** `ETag` and `Cache-Control` on `GET /profiles/{id}`
and `GET /profiles/by-user/{id}`, so Phase 1's background revalidation costs a 304 rather than a
full body. This is what makes "always revalidate" affordable.

**Measure**, before and after: avatar bytes per cold launch, profile requests per cold launch,
and how long the WebView retains avatars before its own cache evicts them.

> **The server fix does not fix the reported symptom.** Raw ids come from profile *JSON* not being
> persisted locally and from N users costing N GETs against a rate limit. Cache headers make
> repeat launches cheaper; the in-memory map is still empty at first paint. Phase 1 is required
> regardless of what Phase 0 measures.

## Phase 1 - persistent profile metadata cache

This is the phase that removes the raw ids.

### Storage

A new `CacheStore`, sealed under `localStateKey`, over the existing IndexedDB layer. The web
adapter's Web Locks plus revision-marker revalidation from `mls-local-store.web.ts` carries over
wholesale, so two tabs of one account cannot serve each other stale entries. Store file names
carry the device id, exactly as the MLS stores do - that is what keeps cached profiles from
crossing account slots.

### Hydration

`ProfileService` gains a boot hydrate that loads cached profiles into `byUserId` and
`byProfileId` during `AppReadyService`, before first paint. `getCachedByUserId` is already the
read path every component uses, so nothing downstream changes: the maps are simply populated on
arrival instead of empty.

### Revalidation

On hydrate, every hydrated id is enqueued for background refetch through the existing
`coalesce` path, so the breaker and the negative cache still apply. The queue is throttled -
bounded concurrency and a rate ceiling - and yields to foreground requests. With Phase 0's `ETag`
in place these are 304s.

`updatedAt` on the response drives avatar cache-busting via the existing `cacheBustedUrl` helper,
so a changed avatar corrects itself as soon as revalidation lands.

### Eviction

Profile metadata is small - a `ProfileDto` is 300-500 bytes of JSON, more when `mutualFriends` or
`mutualServers` are populated. Even 5,000 distinct users is roughly 2.5MB, well inside the
reserve below.

## Phase 2 - images

**Default position after Phase 0: do nothing.** If the stable URL plus `Cache-Control` makes the
WebView's own HTTP cache retain avatars adequately, that is the whole feature - zero client code,
zero `[src]` churn, and it fixes venta-mobile and the browser build at the same time.

Build a local image store only if measurement shows the WebView cache evicting too aggressively
to hold the working set. If it does:

- Key on the stable app URL plus `updatedAt`, **never** the presigned URL
- Bytes stored plain, so they can be served as object URLs without a decrypt on the paint path
- Consumers move to the `auth-image.directive` pattern; `AuthImageService`'s discipline of
  holding `Blob`s rather than object URLs (auth-image.service.ts:26-32) is the precedent - an
  object URL handed to two elements is revoked by whichever unmounts first, blanking the other

This is where the bulk of the 100MB goes if it is built at all.

## Phase 3 - message metadata

### Store metadata only, never the body

`MessageDto` is persisted **without `content`**. The body already lives in the MLS plaintext
cache: sealed, backed up under §D, keyed by context and generation. Storing it again would put a
second copy of every plaintext at rest, duplicate several megabytes, and drag the §D envelope
into this design.

The two caches compose instead - metadata from this one, body from the existing one. No new
plaintext at rest, and §D is untouched.

### Gap-fill only

`loadForConversation` paints the cached page immediately, then the network page replaces it
wholesale on arrival. The server is authoritative: cached entries absent from the network page
for that offset range are dropped, which is what keeps deleted and moderated messages from
resurrecting. Pagination cursors are never restored from cache - `conversationMeta.offset` is a
cursor into server-side history and a stale one would make the next page skip real messages.

## Budget: 100MB with reserves

Not a single LRU pool. Profiles are tiny and are the thing whose absence you actually see; in one
shared pool a busy channel's message flood would evict the very profiles needed to render it, and
the raw-id symptom would return precisely when the app is busiest.

| Domain | Reserve | Behaviour |
|---|---|---|
| Profile metadata | 5MB | Guaranteed; another domain can never evict it |
| Message metadata | 15MB | Guaranteed; another domain can never evict it |
| Images | remainder | LRU within whatever the other two are not currently using |

"Reserve" means a floor, not an allocation. Images may grow into the 20MB the other two have not
filled, and must give it back: when a profile or message write needs space inside its own
reserve, the eviction it triggers falls on images first and only then on its own domain's LRU
tail. A domain never evicts another domain below that domain's floor.

### The mistake not to repeat

`pruneMessageCache` (mls.service.ts:888) calls `entries()` - reading **every** payload - on every
message cached. At 5,000 small entries that is tolerable. At 100MB it is not: it would
deserialize and decrypt the entire cache to decide one eviction, on the path that renders a
conversation.

The new store keeps a **separate index** - key → `{bytes, lastAccess, domain}` - as its own
entry. Eviction reads the index and deletes by key; it never touches a payload. Byte counts are
recorded at write time from the serialized length.

## Risks

- **Sealing key unreadable.** Cache is unreadable, cold start behaves as it does today. Must not
  mint a replacement key (see above); must not wipe.
- **Multi-account leakage.** Mitigated by device-id-scoped file names, the same rule the MLS
  stores follow. This needs an explicit test - a cache that crossed account slots would be a
  privacy failure, not a performance bug.
- **Two tabs.** Reuses the Web Locks and revision-marker pattern rather than re-deriving it.
- **Quota exhaustion on web.** IndexedDB writes can reject with `QuotaExceededError`; `idb.ts`
  already types it. A failed cache write must be a no-op, never an error surfaced to the user.
- **Phase 0 changes a public route's caching.** A stale avatar after an upload is the failure
  mode; the `updatedAt` cache-bust already in `cacheBustedUrl` is what bounds it.

## Testing

- Hydration populates the maps before first paint, and a component reading `getCachedByUserId`
  sees a name rather than an id on a cold start with the network refusing every request
- Eviction respects reserves: filling images to the ceiling does not evict a single profile
- Eviction never reads payloads (assert on the store's read count, not just on the outcome)
- A cache written under account A is invisible to account B
- A failed `localStateKey` read yields an empty cache and no minted key
- The network page wins: a message deleted server-side does not resurrect from cache
- Phase 0: two avatar requests in the same hour produce byte-identical URLs

## Out of scope

- Offline message composition or send queueing
- Cache-first rendering of conversations (explicitly rejected; gap-fill only)
- Any change to the MLS plaintext cache, its sealing, or the §D envelope
- A bulk profile endpoint. It would help, but it is a larger backend change than Phase 0 and is
  not required for any phase here.
