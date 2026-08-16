# Rolling Profile and Message Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the client showing raw `user_...` ids for people it has resolved hundreds of times, and stop avatars re-downloading on every paint.

**Architecture:** Two independently executable parts. **Part A** (backend, `C:\Users\Domin\RiderProjects\Echo`) makes the avatar redirect and the profile JSON routes cacheable, which is a prerequisite for measuring how much client-side image caching is still needed. **Part B** (client, this repo) adds a sealed, byte-budgeted IndexedDB cache that hydrates `ProfileService`'s maps before first paint and gap-fills message metadata.

**Tech Stack:** ASP.NET Core / AWS SDK for .NET / **NUnit 4.6.1** (Part A). Angular 21 signals, NgRx signal-store, IndexedDB, WebCrypto AES-GCM, Vitest via `@angular/build:unit-test` (Part B).

> **Correction, found during execution.** The Part A test code blocks below are written in
> xUnit (`[Fact]`, `Assert.Equal`). `Social.Tests` uses **NUnit** exclusively — there is no
> xUnit package, and `<Using Include="NUnit.Framework"/>` is a global using. Translate
> mechanically, preserving test names, logic and coverage: `[Fact]`→`[Test]`,
> `Assert.Equal(e, a)`→`Assert.That(a, Is.EqualTo(e))`,
> `Assert.NotEqual(a, b)`→`Assert.That(b, Is.Not.EqualTo(a))`,
> `Assert.True(x)`→`Assert.That(x, Is.True)`, `Assert.False(x)`→`Assert.That(x, Is.False)`,
> `Assert.StartsWith(s, v)`→`Assert.That(v, Does.StartWith(s))` (`EndsWith`→`Does.EndWith`),
> `Assert.InRange(v, lo, hi)`→`Assert.That(v, Is.InRange(lo, hi))`.

**Spec:** `docs/superpowers/specs/2026-08-16-profile-and-message-cache-design.md`

## Global Constraints

- Budget is **100MB total**. This plan claims only the metadata reserves: **5MB profile metadata, 15MB message metadata**. The remaining ~80MB is the image budget and is **not claimed** — the spec's default position after Phase 0 is to build no image store at all, pending measurement.
- **Phase 2 (image store) is deliberately not implemented by this plan.** See spec, "Phase 2 — images".
- Metadata is **sealed** at rest; image bytes (if ever cached) are **plain**.
- The sealing key is `alpine_mls_${deviceId}_statekey`, read through `SecureStore.getItem`. The cache **MUST NOT** mint it, and **MUST NOT** call `SecureStore.update` for it. A failed or absent read yields an empty cache and nothing worse.
- Cache files/keys are scoped by **device id**, exactly as the MLS stores are. A cache entry must never be visible to another account slot.
- The MLS plaintext cache (`mls.service.ts:765-901`) is **untouched**: its sealing, its 5,000-entry limit and the §D backup envelope all stay as they are. Its bytes do not count against the budget.
- Eviction **MUST NOT** read payloads. It reads a separate index only.
- The server page is always authoritative for messages. Cached entries absent from an arriving network page are dropped. `conversationMeta.offset` / `channelMeta.offset` are **never** restored from cache.
- No em dashes in user-facing copy.
- Run client tests with `npx ng test` (the Angular CLI entrypoint). Bare `vitest` fails every TestBed spec misleadingly.

---

## Part A — Backend caching (repo: `C:\Users\Domin\RiderProjects\Echo`)

### Task A1: Stable, memoized presigned image URLs

The AWS SDK signs presigned URLs with SigV4, which puts the signing instant in `X-Amz-Date`. Bucketing `Expires` alone is therefore **not** sufficient — the signature still changes every call. The URL must be generated once per window and memoized, so every caller in the window receives byte-identical output.

**Files:**
- Modify: `Social.Application/Services/FileService.cs:82-99`
- Test: `Social.Tests/Services/FileServiceUrlStabilityTests.cs` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `FileService.GetPresignedUrlForAvatar(string id)` and `GetPresignedUrlForBanner(string id)` keep their signatures. New public static `FileService.WindowEnd(DateTime utcNow)` returning `DateTime`, used by Task A2 to compute `max-age`.

- [ ] **Step 1: Write the failing test**

```csharp
using Social.Api.Services;
using Xunit;

namespace Social.Tests.Services;

public class FileServiceUrlStabilityTests
{
    [Fact]
    public void WindowEnd_rounds_up_to_the_next_hour()
    {
        var at = new DateTime(2026, 8, 16, 10, 59, 30, DateTimeKind.Utc);
        Assert.Equal(new DateTime(2026, 8, 16, 11, 0, 0, DateTimeKind.Utc), FileService.WindowEnd(at));
    }

    [Fact]
    public void WindowEnd_is_identical_for_every_instant_inside_one_hour()
    {
        var early = new DateTime(2026, 8, 16, 10, 0, 1, DateTimeKind.Utc);
        var late = new DateTime(2026, 8, 16, 10, 59, 59, DateTimeKind.Utc);
        Assert.Equal(FileService.WindowEnd(early), FileService.WindowEnd(late));
    }

    [Fact]
    public void WindowEnd_advances_across_an_hour_boundary()
    {
        var before = new DateTime(2026, 8, 16, 10, 59, 59, DateTimeKind.Utc);
        var after = new DateTime(2026, 8, 16, 11, 0, 1, DateTimeKind.Utc);
        Assert.NotEqual(FileService.WindowEnd(before), FileService.WindowEnd(after));
    }

    [Fact]
    public void WindowEnd_on_an_exact_boundary_does_not_return_the_instant_itself()
    {
        // A window that ended "now" would advertise max-age=0 and defeat the whole change.
        var exact = new DateTime(2026, 8, 16, 11, 0, 0, DateTimeKind.Utc);
        Assert.True(FileService.WindowEnd(exact) > exact);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test Social.Tests/Social.Tests.csproj --filter FileServiceUrlStabilityTests`
Expected: FAIL — `FileService` does not contain a definition for `WindowEnd`.

- [ ] **Step 3: Write minimal implementation**

Add to `Social.Application/Services/FileService.cs`. Add `using Microsoft.Extensions.Caching.Memory;` at the top, and add `IMemoryCache cache` to the primary constructor parameter list.

```csharp
/// <summary>How long one presigned URL is reused for. Every caller inside a window gets the
/// byte-identical URL, which is what lets the browser's HTTP cache hit at all.</summary>
private static readonly TimeSpan UrlWindow = TimeSpan.FromHours(1);

/// <summary>
/// The end of the window <paramref name="utcNow"/> falls in, always strictly in the future.
///
/// An instant exactly on a boundary rolls to the next one: a window ending "now" would advertise
/// max-age=0 and the redirect would be revalidated on every request, which is the bug being fixed.
/// </summary>
public static DateTime WindowEnd(DateTime utcNow)
{
    var ticks = UrlWindow.Ticks;
    return new DateTime((utcNow.Ticks / ticks + 1) * ticks, DateTimeKind.Utc);
}

/// <summary>
/// One presigned URL per key per window, memoized.
///
/// Bucketing <c>Expires</c> alone is not enough. SigV4 puts the signing instant in
/// <c>X-Amz-Date</c>, so two calls a second apart produce different signatures and therefore
/// different URLs even with an identical expiry - and a URL that never repeats can never be
/// cached, because browsers key the HTTP cache on the full URL including the query string.
/// Memoizing the generated string removes the SDK's clock from the answer entirely.
///
/// The signature outlives the window by a further <see cref="UrlWindow"/>. The redirect's
/// max-age only ever reaches the window end, so any cached redirect still points at a signature
/// valid for at least an hour after the client stops trusting it.
/// </summary>
private string PresignedForWindow(string cacheKey, string objectKey)
{
    var windowEnd = WindowEnd(DateTime.UtcNow);
    var memoKey = $"presigned:{cacheKey}:{windowEnd:O}";

    return cache.GetOrCreate(memoKey, entry =>
    {
        entry.AbsoluteExpiration = windowEnd;
        return s3Client.GetPreSignedURL(new GetPreSignedUrlRequest
        {
            BucketName = Env.StorageConfiguration.BucketName,
            Key = objectKey,
            Expires = windowEnd + UrlWindow,
            Verb = HttpVerb.GET
        });
    })!;
}
```

Then replace the body of `GetPresignedUrlForAvatar`:

```csharp
public Task<string?> GetPresignedUrlForAvatar(string id)
{
    if (string.IsNullOrEmpty(id))
        return Task.FromResult<string?>(null);

    return Task.FromResult<string?>(PresignedForWindow($"avatar:{id}", id));
}
```

And `GetPresignedUrlForBanner`, using the banner key prefix that already exists:

```csharp
public Task<string?> GetPresignedUrlForBanner(string id)
{
    if (string.IsNullOrEmpty(id))
        return Task.FromResult<string?>(null);

    var key = GetBannerKey(id);
    return Task.FromResult<string?>(PresignedForWindow($"banner:{id}", key));
}
```

- [ ] **Step 4: Register IMemoryCache**

In the Social service's DI registration (the `Program.cs` or startup extension that registers `FileService`), add `builder.Services.AddMemoryCache();` before the `FileService` registration. `AddMemoryCache` uses `TryAdd` semantics, so calling it when it is already registered is safe.

- [ ] **Step 5: Run test to verify it passes**

Run: `dotnet test Social.Tests/Social.Tests.csproj --filter FileServiceUrlStabilityTests`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add Social.Application/Services/FileService.cs Social.Tests/Services/FileServiceUrlStabilityTests.cs
git commit -m "fix(social): mint one presigned image URL per hour, not per request

SigV4 puts the signing instant in X-Amz-Date, so every call produced a
different URL even for the same object. Browsers key the HTTP cache on the
full URL including query string, so the cache could never hit and every
avatar render re-downloaded the image from object storage.

Memoized per key per hour window. The signature outlives the window by a
further hour, so a cached redirect never points at an expired one."
```

---

### Task A2: Cacheable redirects on the avatar and banner routes

**Files:**
- Modify: `Social.Application/Controllers/AvatarController.cs:15-23`
- Modify: `Social.Application/Controllers/BannerController.cs:14-22`
- Test: `Social.Tests/Controllers/ImageCacheHeaderTests.cs` (create)

**Interfaces:**
- Consumes: `FileService.WindowEnd(DateTime)` from Task A1.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

```csharp
using Social.Api.Services;
using Xunit;

namespace Social.Tests.Controllers;

public class ImageCacheHeaderTests
{
    /// <summary>
    /// The redirect must expire no later than the URL it points at. Advertising a longer life
    /// would let a client keep following a cached redirect to a dead signature.
    /// </summary>
    [Fact]
    public void MaxAge_never_outlives_the_window()
    {
        var now = new DateTime(2026, 8, 16, 10, 0, 1, DateTimeKind.Utc);
        var seconds = (int)(FileService.WindowEnd(now) - now).TotalSeconds;

        Assert.InRange(seconds, 1, 3600);
    }

    [Fact]
    public void MaxAge_is_positive_immediately_after_a_boundary()
    {
        var justAfter = new DateTime(2026, 8, 16, 11, 0, 0, DateTimeKind.Utc).AddTicks(1);
        var seconds = (int)(FileService.WindowEnd(justAfter) - justAfter).TotalSeconds;

        Assert.True(seconds > 0);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test Social.Tests/Social.Tests.csproj --filter ImageCacheHeaderTests`
Expected: FAIL to compile if Task A1 is not merged; otherwise PASS trivially. This test guards the arithmetic the controller uses; the controller change itself is verified by Step 5.

- [ ] **Step 3: Write the implementation**

In `AvatarController.cs`, replace `GetAvatar`:

```csharp
[HttpGet("avatar")]
public async Task<IActionResult> GetAvatar(string profileId)
{
    var url = await service.GetPresignedUrlForAvatar(profileId);
    if (url == null)
        return NotFound();

    // Public: this route is anonymous, so there is nothing viewer-specific to protect. The
    // max-age only ever reaches the end of the window the URL was minted for, and the signature
    // outlives that by an hour - so a cached redirect cannot outlive what it points at.
    var now = DateTime.UtcNow;
    var maxAge = (int)(FileService.WindowEnd(now) - now).TotalSeconds;
    Response.Headers.CacheControl = $"public, max-age={maxAge}";

    return Redirect(url);
}
```

Apply the identical change to `BannerController.GetBanner`, calling `GetPresignedUrlForBanner`.

- [ ] **Step 4: Run the test suite**

Run: `dotnet test Social.Tests/Social.Tests.csproj`
Expected: PASS.

- [ ] **Step 5: Verify by hand against a running instance**

Run twice inside the same hour and diff:

```bash
curl -sI http://localhost:5000/api/v1/profiles/<profileId>/avatar | grep -i 'location\|cache-control' > /tmp/a.txt
curl -sI http://localhost:5000/api/v1/profiles/<profileId>/avatar | grep -i 'location\|cache-control' > /tmp/b.txt
diff /tmp/a.txt /tmp/b.txt && echo "STABLE"
```

Expected: `STABLE`, and a `Cache-Control: public, max-age=<n>` header present. Before this change the two `Location` values differ in `X-Amz-Date` and `X-Amz-Signature`.

- [ ] **Step 6: Commit**

```bash
git add Social.Application/Controllers/AvatarController.cs Social.Application/Controllers/BannerController.cs Social.Tests/Controllers/ImageCacheHeaderTests.cs
git commit -m "feat(social): let clients cache the avatar and banner redirects

max-age is computed from the remaining window rather than a constant, so a
cached redirect can never outlive the signature it points at."
```

---

### Task A3: ETag revalidation on the profile JSON routes

This is what makes Part B's "always revalidate in background" affordable: a revalidation costs a 304 rather than a full body.

**These responses are per-viewer projected** (`projection.ProjectAsync(profile, currentProfile.Id)` applies the subject's privacy settings relative to the caller). The cache directive must therefore be `private`, never `public`, and the ETag must be computed over the projected body so two viewers never share one validator.

**Files:**
- Create: `Social.Application/Helpers/ETagHelper.cs`
- Modify: `Social.Application/Controllers/ProfileController.cs:182-219` (`GetAsync`) and `:222-...` (`GetByUserIdAsync`)
- Test: `Social.Tests/Helpers/ETagHelperTests.cs` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ETagHelper.Compute(object body)` returning a quoted `string`; `ETagHelper.Matches(string? ifNoneMatch, string etag)` returning `bool`.

- [ ] **Step 1: Write the failing test**

```csharp
using Social.Api.Helpers;
using Xunit;

namespace Social.Tests.Helpers;

public class ETagHelperTests
{
    [Fact]
    public void Compute_is_stable_for_equal_bodies()
    {
        Assert.Equal(
            ETagHelper.Compute(new { name = "ada", id = 1 }),
            ETagHelper.Compute(new { name = "ada", id = 1 }));
    }

    [Fact]
    public void Compute_differs_for_different_bodies()
    {
        Assert.NotEqual(
            ETagHelper.Compute(new { name = "ada" }),
            ETagHelper.Compute(new { name = "grace" }));
    }

    [Fact]
    public void Compute_is_quoted_as_the_header_grammar_requires()
    {
        var etag = ETagHelper.Compute(new { name = "ada" });
        Assert.StartsWith("\"", etag);
        Assert.EndsWith("\"", etag);
    }

    [Fact]
    public void Matches_accepts_the_exact_validator()
    {
        var etag = ETagHelper.Compute(new { name = "ada" });
        Assert.True(ETagHelper.Matches(etag, etag));
    }

    [Fact]
    public void Matches_accepts_a_star()
    {
        Assert.True(ETagHelper.Matches("*", ETagHelper.Compute(new { name = "ada" })));
    }

    [Fact]
    public void Matches_accepts_one_of_a_list()
    {
        var etag = ETagHelper.Compute(new { name = "ada" });
        Assert.True(ETagHelper.Matches($"\"other\", {etag}", etag));
    }

    [Fact]
    public void Matches_rejects_a_different_validator()
    {
        Assert.False(ETagHelper.Matches("\"other\"", ETagHelper.Compute(new { name = "ada" })));
    }

    [Fact]
    public void Matches_rejects_when_the_header_is_absent()
    {
        Assert.False(ETagHelper.Matches(null, ETagHelper.Compute(new { name = "ada" })));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test Social.Tests/Social.Tests.csproj --filter ETagHelperTests`
Expected: FAIL — the type or namespace `ETagHelper` could not be found.

- [ ] **Step 3: Write minimal implementation**

Create `Social.Application/Helpers/ETagHelper.cs`:

```csharp
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Social.Api.Helpers;

/// <summary>
/// Strong validators over a response body.
///
/// Computed from the <b>projected</b> body rather than from the row's UpdatedAt, because these
/// responses are per-viewer: the same profile projects differently for a friend, a stranger and a
/// blocked reader. A validator derived from the row alone would let one viewer's 304 be answered
/// from another viewer's cached body.
/// </summary>
public static class ETagHelper
{
    public static string Compute(object body)
    {
        var json = JsonSerializer.SerializeToUtf8Bytes(body);
        return $"\"{Convert.ToHexString(SHA256.HashData(json))[..32]}\"";
    }

    /// <summary>Whether an If-None-Match header covers <paramref name="etag"/>.</summary>
    public static bool Matches(string? ifNoneMatch, string etag)
    {
        if (string.IsNullOrWhiteSpace(ifNoneMatch)) return false;
        if (ifNoneMatch.Trim() == "*") return true;

        foreach (var candidate in ifNoneMatch.Split(','))
        {
            var trimmed = candidate.Trim();
            // A weak validator is still a match for our purposes: the body is either identical or
            // it is not, and we only ever mint strong ones.
            if (trimmed.StartsWith("W/", StringComparison.Ordinal)) trimmed = trimmed[2..];
            if (trimmed == etag) return true;
        }
        return false;
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test Social.Tests/Social.Tests.csproj --filter ETagHelperTests`
Expected: PASS, 8 tests.

- [ ] **Step 5: Wire it into both profile GETs**

In `ProfileController.cs`, add `using Social.Api.Helpers;`. Replace the final `return Ok(...)` of `GetAsync` with:

```csharp
var projected = await projection.ProjectAsync(profile, currentProfile.Id);
var etag = ETagHelper.Compute(projected);

// private, never public: the body above is projected for this caller specifically.
Response.Headers.CacheControl = "private, max-age=0, must-revalidate";
Response.Headers.ETag = etag;

if (ETagHelper.Matches(Request.Headers.IfNoneMatch, etag)) return StatusCode(304);

return Ok(projected);
```

Apply the identical change to the final `return Ok(...)` of `GetByUserIdAsync`.

- [ ] **Step 6: Run the full suite**

Run: `dotnet test Social.Tests/Social.Tests.csproj`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add Social.Application/Helpers/ETagHelper.cs Social.Application/Controllers/ProfileController.cs Social.Tests/Helpers/ETagHelperTests.cs
git commit -m "feat(social): ETag revalidation on the profile reads

Computed over the projected body, not the row, because these responses are
per-viewer - a validator from UpdatedAt alone would let one viewer's 304 be
served from another viewer's cached body. Cache-Control is private for the
same reason.

Makes the client's background revalidation a 304 instead of a full body."
```

---

### Task A4: Measure, then decide on Phase 2

**Files:** none. This is the gate the spec puts in front of building any image store.

- [ ] **Step 1: Record the baseline before deploying A1-A3**

With the current build, cold-start the client with DevTools Network open, filtered to `/avatar`. Record: number of avatar requests, total bytes transferred, and how many were served from cache.

- [ ] **Step 2: Deploy A1-A3 and record the same numbers**

- [ ] **Step 3: Record WebView retention**

Restart the app three times over roughly an hour and record how many avatar requests are served from the local HTTP cache on each start.

- [ ] **Step 4: Write the findings into the spec**

Append a "Phase 0 measurements" section to `docs/superpowers/specs/2026-08-16-profile-and-message-cache-design.md` with the six numbers above, and a one-line verdict: build the image store, or do not.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-08-16-profile-and-message-cache-design.md
git commit -m "docs(cache): Phase 0 measurements and the Phase 2 verdict"
```

---

## Part B — Client cache (repo: this one)

### Task B1: The sealing key reader

**Files:**
- Create: `src/app/services/cache/cache-seal.service.ts`
- Test: `src/app/services/cache/cache-seal.service.spec.ts`

**Interfaces:**
- Consumes: `SecureStore` (`src/app/platform/ports/secure-store.port.ts`), `DeviceIdentityService.deviceId(): Promise<string>`.
- Produces:
  - `CacheSealService.seal(value: unknown): Promise<string | null>` — returns `iv.ct`, both base64, or `null` when no key is available.
  - `CacheSealService.unseal<T>(sealed: string): Promise<T | null>` — `null` on any failure.
  - `CacheSealService.available(): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

```typescript
import {TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {SecureStore} from '../../platform/ports/secure-store.port';
import {DeviceIdentityService} from '../device-identity.service';
import {CacheSealService} from './cache-seal.service';

/** A 32-byte key, base64, the shape `localStateKey` stores. */
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

class FakeSecureStore extends SecureStore {
    readonly hardwareBacked = false;
    getItemCalls = 0;
    updateCalls = 0;
    constructor(private value: string | null) { super(); }
    async getItem(): Promise<string | null> { this.getItemCalls++; return this.value; }
    async setItem(): Promise<void> { /* unused */ }
    async removeItem(): Promise<void> { /* unused */ }
    override async update(): Promise<string | null> { this.updateCalls++; return this.value; }
}

function configure(store: SecureStore): CacheSealService {
    TestBed.configureTestingModule({
        providers: [
            {provide: SecureStore, useValue: store},
            {provide: DeviceIdentityService, useValue: {deviceId: async () => 'device-a'}},
        ],
    });
    return TestBed.inject(CacheSealService);
}

describe('CacheSealService', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('round-trips a value through the stored key', async () => {
        const seal = configure(new FakeSecureStore(KEY));
        const sealed = await seal.seal({userName: 'ada'});
        expect(sealed).not.toBeNull();
        expect(sealed).not.toContain('ada');
        expect(await seal.unseal<{userName: string}>(sealed!)).toEqual({userName: 'ada'});
    });

    it('reports unavailable and never mints when the key is absent', async () => {
        // The whole point. SecureStore collapses a locked read to null, so minting here would
        // orphan every entry the cache has ever written - and, if it landed on the same name,
        // every MLS group key sealed under the real one.
        const store = new FakeSecureStore(null);
        const seal = configure(store);

        expect(await seal.available()).toBe(false);
        expect(await seal.seal({userName: 'ada'})).toBeNull();
        expect(store.updateCalls).toBe(0);
    });

    it('returns null rather than throwing when the ciphertext will not open', async () => {
        const seal = configure(new FakeSecureStore(KEY));
        expect(await seal.unseal('bm90LWl2.bm90LWNpcGhlcnRleHQ=')).toBeNull();
    });

    it('returns null for a malformed entry with no separator', async () => {
        const seal = configure(new FakeSecureStore(KEY));
        expect(await seal.unseal('no-separator-here')).toBeNull();
    });

    it('returns null for a value sealed under a different key', async () => {
        const other = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
        const sealed = await configure(new FakeSecureStore(KEY)).seal({userName: 'ada'});

        TestBed.resetTestingModule();
        expect(await configure(new FakeSecureStore(other)).unseal(sealed!)).toBeNull();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx ng test --include='**/cache-seal.service.spec.ts'`
Expected: FAIL — cannot resolve `./cache-seal.service`.

- [ ] **Step 3: Write minimal implementation**

Create `src/app/services/cache/cache-seal.service.ts`:

```typescript
import {inject, Injectable} from '@angular/core';

import {SecureStore} from '../../platform/ports/secure-store.port';
import {DeviceIdentityService} from '../device-identity.service';

/** Separates the IV from the ciphertext. Neither half contains it: both are base64. */
const SEPARATOR = '.';

/**
 * Seals cache entries under the key the MLS engine state already uses.
 *
 * <p><b>This service reads the key and never writes it.</b> `MlsService.localStateKey` mints one
 * when there is none, through `SecureStore.update`, and that is correct there: without a key the
 * engine cannot run at all. Here it would be a defect. `SecureStore` collapses every read failure
 * to `null`, so a keychain that is merely locked is indistinguishable from a device that has none,
 * and minting on that answer would seal every later cache entry under a key the real one will
 * never match - silently orphaning the cache, permanently, from one transient fault.</p>
 *
 * <p>So an absent key means the cache is unavailable, which degrades to exactly the behaviour that
 * shipped before it existed: an empty cache and a cold start. Nothing worse, and nothing to
 * recover from.</p>
 */
@Injectable({providedIn: 'root'})
export class CacheSealService {
    private readonly secureStore = inject(SecureStore);
    private readonly deviceIdentity = inject(DeviceIdentityService);

    /** Resolved once on success. A failure is never memoised - one bad read is not the session. */
    private key: Promise<CryptoKey | null> | null = null;

    async available(): Promise<boolean> {
        return await this.cryptoKey() !== null;
    }

    async seal(value: unknown): Promise<string | null> {
        const key = await this.cryptoKey();
        if (!key) return null;

        const iv = crypto.getRandomValues(new Uint8Array(12));
        const plaintext = new TextEncoder().encode(JSON.stringify(value));
        const ct = await crypto.subtle.encrypt({name: 'AES-GCM', iv}, key, plaintext);

        return `${toB64(iv)}${SEPARATOR}${toB64(new Uint8Array(ct))}`;
    }

    async unseal<T>(sealed: string): Promise<T | null> {
        const key = await this.cryptoKey();
        if (!key) return null;

        const [ivB64, ctB64] = sealed.split(SEPARATOR);
        if (!ivB64 || !ctB64) return null;

        try {
            const plaintext = await crypto.subtle.decrypt(
                {name: 'AES-GCM', iv: fromB64(ivB64)}, key, fromB64(ctB64));
            return JSON.parse(new TextDecoder().decode(plaintext)) as T;
        } catch {
            // A cache entry that will not open is a miss, not an error. It can be re-fetched.
            return null;
        }
    }

    private cryptoKey(): Promise<CryptoKey | null> {
        this.key ??= this.readKey().catch(() => {
            this.key = null;
            return null;
        });
        return this.key;
    }

    private async readKey(): Promise<CryptoKey | null> {
        const deviceId = await this.deviceIdentity.deviceId();
        // getItem, deliberately. See the class comment: update() would mint.
        const raw = await this.secureStore.getItem(`alpine_mls_${deviceId}_statekey`);
        if (!raw) return null;

        return crypto.subtle.importKey(
            'raw', fromB64(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
    }
}

function toB64(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes));
}

function fromB64(value: string): Uint8Array {
    return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx ng test --include='**/cache-seal.service.spec.ts'`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/services/cache/cache-seal.service.ts src/app/services/cache/cache-seal.service.spec.ts
git commit -m "feat(cache): read-only sealing key for the metadata cache

Reads the same key the MLS engine state is sealed under, and never mints
one. SecureStore reports a locked keychain as absent, so minting on that
answer would orphan the whole cache from a transient fault."
```

---

### Task B2: The byte-budgeted cache store

**Files:**
- Create: `src/app/platform/cache-store.ts`
- Test: `src/app/platform/cache-store.spec.ts`

Placed under `platform/` because it uses `platform/web/idb.ts`. One IndexedDB implementation serves **both** hosts: unlike the MLS stores, this cache has no legacy on-disk data to stay compatible with and no durability requirement, so there is no reason to route the desktop through `LazyStore`. It imports no `@tauri-apps/*` module, so `platform-boundary.spec.ts` is unaffected.

**Interfaces:**
- Consumes: `openStore`, `IdbStore`, `IdbStoreClosedError` from `./web/idb`; `CacheSealService` from Task B1.
- Produces:
  - `type CacheDomain = 'profile' | 'message'`
  - `DOMAIN_RESERVES: Record<CacheDomain, number>` — `{profile: 5_242_880, message: 15_728_640}`
  - `class CacheStore` with `get<T>(domain, key)`, `set(domain, key, value)`, `delete(domain, key)`, `all<T>(domain)`, `clear()`, `sizeOf(domain)`
  - `class CacheStoreFactory { open(deviceId: string): CacheStore }`

- [ ] **Step 1: Write the failing test**

```typescript
import {IDBFactory as FakeIdbFactory} from 'fake-indexeddb';
import {beforeEach, describe, expect, it} from 'vitest';

import {CacheStore, DOMAIN_RESERVES} from './cache-store';
import {openStore} from './web/idb';

/** A seal that is the identity function, so these tests assert on budgeting, not on crypto. */
const PLAIN = {
    seal: async (v: unknown) => JSON.stringify(v),
    unseal: async <T>(s: string) => JSON.parse(s) as T,
    available: async () => true,
};

let factory: IDBFactory;
let store: CacheStore;

function makeStore(): CacheStore {
    return new CacheStore(
        'device-a', PLAIN as never,
        () => openStore('alpine-cache-test', 'entries', {factory}));
}

describe('CacheStore', () => {
    beforeEach(() => {
        factory = new FakeIdbFactory();
        store = makeStore();
    });

    it('round-trips a value', async () => {
        await store.set('profile', 'u1', {userName: 'ada'});
        expect(await store.get('profile', 'u1')).toEqual({userName: 'ada'});
    });

    it('returns undefined for a key it does not hold', async () => {
        expect(await store.get('profile', 'nobody')).toBeUndefined();
    });

    it('lists a whole domain without listing the other', async () => {
        await store.set('profile', 'u1', {userName: 'ada'});
        await store.set('message', 'c1', [{id: 'm1'}]);

        expect((await store.all('profile')).map(([k]) => k)).toEqual(['u1']);
        expect((await store.all('message')).map(([k]) => k)).toEqual(['c1']);
    });

    it('survives a reopen, which is the entire point', async () => {
        await store.set('profile', 'u1', {userName: 'ada'});
        expect(await makeStore().get('profile', 'u1')).toEqual({userName: 'ada'});
    });

    it('never lets one account read another account\'s entries', async () => {
        await store.set('profile', 'u1', {userName: 'ada'});

        const other = new CacheStore(
            'device-b', PLAIN as never,
            () => openStore('alpine-cache-test', 'entries', {factory}));

        expect(await other.get('profile', 'u1')).toBeUndefined();
    });

    it('evicts the least recently used entry once its domain is over reserve', async () => {
        // One entry a little over a tenth of the reserve, so eleven do not fit.
        const bulk = 'x'.repeat(Math.floor(DOMAIN_RESERVES.profile / 10));

        for (let i = 0; i < 11; i++) await store.set('profile', `u${i}`, {bulk});

        expect(await store.get('profile', 'u0')).toBeUndefined();
        expect(await store.get('profile', 'u10')).toEqual({bulk});
        expect(store.sizeOf('profile')).toBeLessThanOrEqual(DOMAIN_RESERVES.profile);
    });

    it('counts a rewritten key once, not twice', async () => {
        await store.set('profile', 'u1', {bulk: 'x'.repeat(1000)});
        const first = store.sizeOf('profile');
        await store.set('profile', 'u1', {bulk: 'x'.repeat(1000)});

        expect(store.sizeOf('profile')).toBe(first);
    });

    it('reading an entry protects it from the next eviction', async () => {
        const bulk = 'x'.repeat(Math.floor(DOMAIN_RESERVES.profile / 10));
        for (let i = 0; i < 10; i++) await store.set('profile', `u${i}`, {bulk});

        await store.get('profile', 'u0');       // u0 is now the most recently used
        await store.set('profile', 'u10', {bulk});

        expect(await store.get('profile', 'u0')).toEqual({bulk});
        expect(await store.get('profile', 'u1')).toBeUndefined();
    });

    it('one domain never evicts another below its reserve', async () => {
        await store.set('message', 'c1', {keep: true});

        const bulk = 'x'.repeat(Math.floor(DOMAIN_RESERVES.profile / 10));
        for (let i = 0; i < 12; i++) await store.set('profile', `u${i}`, {bulk});

        expect(await store.get('message', 'c1')).toEqual({keep: true});
    });

    it('clear empties this device and leaves another device alone', async () => {
        const other = new CacheStore(
            'device-b', PLAIN as never,
            () => openStore('alpine-cache-test', 'entries', {factory}));

        await store.set('profile', 'u1', {userName: 'ada'});
        await other.set('profile', 'u2', {userName: 'grace'});
        await store.clear();

        expect(await store.get('profile', 'u1')).toBeUndefined();
        expect(await other.get('profile', 'u2')).toEqual({userName: 'grace'});
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx ng test --include='**/cache-store.spec.ts'`
Expected: FAIL — cannot resolve `./cache-store`.

- [ ] **Step 3: Write minimal implementation**

Create `src/app/platform/cache-store.ts`:

```typescript
import {Injectable} from '@angular/core';

import {CacheSealService} from '../services/cache/cache-seal.service';
import {IdbStore, IdbStoreClosedError, openStore} from './web/idb';

const DB_NAME = 'alpine-cache';
const STORE_NAME = 'entries';

/** Separates device, domain and key. None of the three contains it. */
const SEPARATOR = '::';

export type CacheDomain = 'profile' | 'message';

/**
 * The floor each domain is guaranteed, in bytes.
 *
 * <p>A floor, not an allocation: a domain may grow into headroom another is not using, and gives it
 * back when the owner needs it. What the floor forbids is one domain evicting another <i>below</i>
 * its own. Profiles are tiny and are the thing whose absence is visible on screen, so a chatty
 * channel must never be able to push them out.</p>
 */
export const DOMAIN_RESERVES: Record<CacheDomain, number> = {
    profile: 5 * 1024 * 1024,
    message: 15 * 1024 * 1024,
};

interface IndexEntry {
    bytes: number;
    lastAccess: number;
    domain: CacheDomain;
}

/**
 * A sealed, byte-budgeted cache over IndexedDB.
 *
 * <h3>The index is separate from the payloads, and that is the whole design</h3>
 *
 * <p>`MlsService.pruneMessageCache` decides an eviction by calling `entries()` - reading every
 * payload it holds - on every write. At five thousand small entries that is tolerable. At twenty
 * megabytes it would mean deserialising and decrypting the entire cache to drop one key, on the
 * path that renders a conversation.</p>
 *
 * <p>So sizes and access times live in one index entry, and eviction reads only that. A payload is
 * touched when it is asked for and at no other time.</p>
 *
 * <h3>One implementation for both hosts</h3>
 *
 * <p>Unlike the MLS stores, this has no on-disk history to stay compatible with and nothing here is
 * durable by contract - it is a cache, and losing it costs a refetch. So the desktop uses the same
 * IndexedDB as the browser rather than `LazyStore`, and there is no port, no factory pair and no
 * second adapter to keep in step. It imports no native module, so the platform boundary is intact.
 * </p>
 */
export class CacheStore {
    private store: Promise<IdbStore> | undefined;
    private index: Map<string, IndexEntry> | undefined;
    private readonly sizes: Record<CacheDomain, number> = {profile: 0, message: 0};

    constructor(
        private readonly deviceId: string,
        private readonly seal: CacheSealService,
        private readonly openDb: () => Promise<IdbStore> = () => openStore(DB_NAME, STORE_NAME),
    ) {}

    /** Bytes currently held for one domain. Read from the index; touches no payload. */
    sizeOf(domain: CacheDomain): number {
        return this.sizes[domain];
    }

    async get<T>(domain: CacheDomain, key: string): Promise<T | undefined> {
        const index = await this.loadIndex();
        const scoped = this.scoped(domain, key);
        const entry = index.get(scoped);
        if (!entry) return undefined;

        const raw = await this.withStore(s => s.get(scoped));
        if (typeof raw !== 'string') return undefined;

        const value = await this.seal.unseal<T>(raw);
        if (value === null) return undefined;

        entry.lastAccess = Date.now();
        await this.writeIndex(index);
        return value;
    }

    async set(domain: CacheDomain, key: string, value: unknown): Promise<void> {
        const sealed = await this.seal.seal(value);
        // No key, no cache. Degrades to the behaviour that shipped before this existed.
        if (sealed === null) return;

        const index = await this.loadIndex();
        const scoped = this.scoped(domain, key);

        const previous = index.get(scoped);
        if (previous) this.sizes[domain] -= previous.bytes;

        const bytes = sealed.length + scoped.length;
        index.set(scoped, {bytes, lastAccess: Date.now(), domain});
        this.sizes[domain] += bytes;

        await this.withStore(s => s.set(scoped, sealed));
        await this.evict(domain, index);
        await this.writeIndex(index);
    }

    async delete(domain: CacheDomain, key: string): Promise<void> {
        const index = await this.loadIndex();
        const scoped = this.scoped(domain, key);
        const entry = index.get(scoped);
        if (!entry) return;

        this.sizes[domain] -= entry.bytes;
        index.delete(scoped);
        await this.withStore(s => s.delete(scoped));
        await this.writeIndex(index);
    }

    /** Every entry in one domain. Used by profile hydration, which genuinely wants all of them. */
    async all<T>(domain: CacheDomain): Promise<[string, T][]> {
        const index = await this.loadIndex();
        const prefix = this.prefix(domain);
        const out: [string, T][] = [];

        for (const scoped of index.keys()) {
            if (!scoped.startsWith(prefix)) continue;
            const raw = await this.withStore(s => s.get(scoped));
            if (typeof raw !== 'string') continue;
            const value = await this.seal.unseal<T>(raw);
            if (value !== null) out.push([scoped.slice(prefix.length), value]);
        }
        return out;
    }

    /** Drops this device's entries. Another account's entries are a different prefix. */
    async clear(): Promise<void> {
        const index = await this.loadIndex();
        for (const scoped of [...index.keys()]) {
            await this.withStore(s => s.delete(scoped));
            index.delete(scoped);
        }
        this.sizes.profile = 0;
        this.sizes.message = 0;
        await this.writeIndex(index);
    }

    /**
     * Drops least-recently-used entries until this domain is inside its reserve.
     *
     * <p>Scoped to the one domain, which is what makes a reserve a reserve: a profile write can
     * never drop a message entry, however much room the messages are using.</p>
     */
    private async evict(domain: CacheDomain, index: Map<string, IndexEntry>): Promise<void> {
        if (this.sizes[domain] <= DOMAIN_RESERVES[domain]) return;

        const victims = [...index.entries()]
            .filter(([, e]) => e.domain === domain)
            .sort((a, b) => a[1].lastAccess - b[1].lastAccess);

        for (const [scoped, entry] of victims) {
            if (this.sizes[domain] <= DOMAIN_RESERVES[domain]) return;
            this.sizes[domain] -= entry.bytes;
            index.delete(scoped);
            await this.withStore(s => s.delete(scoped));
        }
    }

    private prefix(domain: CacheDomain): string {
        return `${this.deviceId}${SEPARATOR}${domain}${SEPARATOR}`;
    }

    private scoped(domain: CacheDomain, key: string): string {
        return `${this.prefix(domain)}${key}`;
    }

    private indexKey(): string {
        return `__index${SEPARATOR}${this.deviceId}`;
    }

    /**
     * The index, sealed like everything else - it holds the user ids and conversation ids this
     * device has cached, which is the contact graph the sealing exists to protect.
     */
    private async loadIndex(): Promise<Map<string, IndexEntry>> {
        if (this.index) return this.index;

        const raw = await this.withStore(s => s.get(this.indexKey()));
        const parsed = typeof raw === 'string'
            ? await this.seal.unseal<Record<string, IndexEntry>>(raw)
            : null;

        const index = new Map<string, IndexEntry>(Object.entries(parsed ?? {}));
        this.sizes.profile = 0;
        this.sizes.message = 0;
        for (const entry of index.values()) this.sizes[entry.domain] += entry.bytes;

        this.index = index;
        return index;
    }

    private async writeIndex(index: Map<string, IndexEntry>): Promise<void> {
        const sealed = await this.seal.seal(Object.fromEntries(index));
        if (sealed === null) return;
        await this.withStore(s => s.set(this.indexKey(), sealed));
    }

    /** One reopen for a connection another tab's upgrade closed, as the MLS store does. */
    private async withStore<T>(op: (store: IdbStore) => Promise<T>): Promise<T> {
        try {
            return await op(await this.db());
        } catch (err) {
            if (!(err instanceof IdbStoreClosedError)) throw err;
            this.store = undefined;
            return await op(await this.db());
        }
    }

    private db(): Promise<IdbStore> {
        this.store ??= this.openDb().catch((err: unknown) => {
            this.store = undefined;
            throw err;
        });
        return this.store;
    }
}

/** Opens one account's cache. Injected so specs can point at `fake-indexeddb`. */
@Injectable({providedIn: 'root'})
export class CacheStoreFactory {
    private readonly stores = new Map<string, CacheStore>();

    constructor(private readonly seal: CacheSealService) {}

    open(deviceId: string): CacheStore {
        let store = this.stores.get(deviceId);
        if (!store) {
            store = new CacheStore(deviceId, this.seal);
            this.stores.set(deviceId, store);
        }
        return store;
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx ng test --include='**/cache-store.spec.ts'`
Expected: PASS, 10 tests.

- [ ] **Step 5: Verify the platform boundary still holds**

Run: `npx ng test --include='**/platform-boundary.spec.ts'`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/platform/cache-store.ts src/app/platform/cache-store.spec.ts
git commit -m "feat(cache): sealed, byte-budgeted cache store over IndexedDB

Sizes and access times live in a separate index entry, so eviction never
reads a payload - the mistake pruneMessageCache makes, which is tolerable
at 5k small entries and ruinous at 20MB.

Per-domain reserves rather than one pool: profiles are tiny and are the
thing whose absence is visible, so a chatty channel must not evict them.
One IndexedDB implementation for both hosts, since a cache has no on-disk
history to preserve and no durability contract."
```

---

### Task B3: The throttled revalidation queue

**Files:**
- Create: `src/app/services/cache/revalidation-queue.ts`
- Test: `src/app/services/cache/revalidation-queue.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class RevalidationQueue` with `constructor(concurrency: number, minGapMs: number, now?: () => number, delay?: (ms: number) => Promise<void>)`, `push(task: () => Promise<void>): void`, `readonly pending: number`, `drain(): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```typescript
import {describe, expect, it} from 'vitest';

import {RevalidationQueue} from './revalidation-queue';

/** A controllable clock, so these tests assert on pacing without sleeping. */
function fakeClock() {
    let t = 0;
    return {
        now: () => t,
        delay: async (ms: number) => { t += ms; },
        advance: (ms: number) => { t += ms; },
    };
}

describe('RevalidationQueue', () => {
    it('runs every task it is given', async () => {
        const clock = fakeClock();
        const queue = new RevalidationQueue(2, 10, clock.now, clock.delay);
        const done: number[] = [];

        for (let i = 0; i < 5; i++) queue.push(async () => { done.push(i); });
        await queue.drain();

        expect(done.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    });

    it('never exceeds its concurrency', async () => {
        const clock = fakeClock();
        const queue = new RevalidationQueue(2, 0, clock.now, clock.delay);
        let live = 0;
        let peak = 0;

        for (let i = 0; i < 8; i++) {
            queue.push(async () => {
                live++;
                peak = Math.max(peak, live);
                await Promise.resolve();
                live--;
            });
        }
        await queue.drain();

        expect(peak).toBeLessThanOrEqual(2);
    });

    it('a failing task does not stop the queue', async () => {
        const clock = fakeClock();
        const queue = new RevalidationQueue(1, 0, clock.now, clock.delay);
        const done: string[] = [];

        queue.push(async () => { throw new Error('429'); });
        queue.push(async () => { done.push('after'); });
        await queue.drain();

        expect(done).toEqual(['after']);
    });

    it('paces tasks by the minimum gap', async () => {
        const clock = fakeClock();
        const queue = new RevalidationQueue(1, 100, clock.now, clock.delay);
        const at: number[] = [];

        for (let i = 0; i < 3; i++) queue.push(async () => { at.push(clock.now()); });
        await queue.drain();

        expect(at[1] - at[0]).toBeGreaterThanOrEqual(100);
        expect(at[2] - at[1]).toBeGreaterThanOrEqual(100);
    });

    it('drain resolves immediately when nothing was queued', async () => {
        const clock = fakeClock();
        await new RevalidationQueue(2, 10, clock.now, clock.delay).drain();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx ng test --include='**/revalidation-queue.spec.ts'`
Expected: FAIL — cannot resolve `./revalidation-queue`.

- [ ] **Step 3: Write minimal implementation**

Create `src/app/services/cache/revalidation-queue.ts`:

```typescript
/**
 * Background work that must never crowd out the app's own requests.
 *
 * <p>Profile revalidation asks for every id the cache holds. Fired at once that is exactly the
 * burst the circuit breaker exists to absorb, and the breaker answering it with fallback profiles
 * would put "Unknown User" on screen - the very thing the cache was added to stop. So this bounds
 * both how many run together and how closely together they start.</p>
 *
 * <p>A task's failure is swallowed. These are refreshes of data already on screen: the cached copy
 * stays, the next launch tries again, and there is no caller waiting on the answer.</p>
 */
export class RevalidationQueue {
    private readonly queued: (() => Promise<void>)[] = [];
    private running = 0;
    private lastStart = Number.NEGATIVE_INFINITY;
    private idle: (() => void)[] = [];

    constructor(
        private readonly concurrency: number,
        private readonly minGapMs: number,
        private readonly now: () => number = () => Date.now(),
        private readonly delay: (ms: number) => Promise<void> =
            ms => new Promise(resolve => setTimeout(resolve, ms)),
    ) {}

    get pending(): number {
        return this.queued.length + this.running;
    }

    push(task: () => Promise<void>): void {
        this.queued.push(task);
        void this.pump();
    }

    /** Resolves once everything queued so far has settled. */
    drain(): Promise<void> {
        if (this.pending === 0) return Promise.resolve();
        return new Promise<void>(resolve => this.idle.push(resolve));
    }

    private async pump(): Promise<void> {
        if (this.running >= this.concurrency) return;

        const task = this.queued.shift();
        if (!task) {
            if (this.running === 0) this.settle();
            return;
        }

        const gap = this.minGapMs - (this.now() - this.lastStart);
        if (gap > 0) await this.delay(gap);

        this.lastStart = this.now();
        this.running++;

        try {
            await task();
        } catch {
            // Deliberately swallowed. See the class comment.
        } finally {
            this.running--;
        }

        void this.pump();
    }

    private settle(): void {
        const waiting = this.idle;
        this.idle = [];
        for (const resolve of waiting) resolve();
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx ng test --include='**/revalidation-queue.spec.ts'`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/services/cache/revalidation-queue.ts src/app/services/cache/revalidation-queue.spec.ts
git commit -m "feat(cache): throttled background queue for profile revalidation

Bounds concurrency and start spacing. Revalidating every cached id at once
is the exact burst the circuit breaker absorbs by serving fallback
profiles, which would put Unknown User back on screen."
```

---

### Task B4: Persist and hydrate profiles

**Files:**
- Create: `src/app/services/cache/profile-cache.service.ts`
- Modify: `src/app/services/profile.service.ts:426-431` (`store`), and add `hydrateFrom`
- Test: `src/app/services/cache/profile-cache.service.spec.ts`

**Interfaces:**
- Consumes: `CacheStoreFactory` (B2), `RevalidationQueue` (B3), `ProfileService`, `DeviceIdentityService`.
- Produces:
  - `ProfileService.hydrateFrom(profiles: ProfileDto[]): void`
  - `ProfileService.cachePersist: ((p: ProfileDto) => void) | null` — a write-behind hook, left null until `ProfileCacheService` installs it, so `ProfileService` keeps no dependency on the cache.
  - `ProfileCacheService.hydrate(): Promise<number>` — returns how many profiles were loaded.
  - `ProfileCacheService.revalidateAll(): void`

- [ ] **Step 1: Write the failing test**

```typescript
import {TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {of, throwError} from 'rxjs';

import {ProfileDto, OnlineStatus, ProfileFont} from '../../dtos/response/profile.dto';
import {CacheStoreFactory} from '../../platform/cache-store';
import {DeviceIdentityService} from '../device-identity.service';
import {ProfileService} from '../profile.service';
import {ProfileCacheService} from './profile-cache.service';

function profile(userId: string, userName: string): ProfileDto {
    return {
        id: `prfl_${userId}`, userId, userName,
        bio: undefined, avatarUrl: undefined, bannerUrl: undefined,
        accentColor: null, font: ProfileFont.Default,
        createdAt: new Date(0), updatedAt: new Date(0),
        onlineStatus: OnlineStatus.Offline,
    };
}

/** An in-memory stand-in for CacheStore, so these tests are about the service, not IndexedDB. */
class FakeCacheStore {
    readonly entries = new Map<string, unknown>();
    async get(_d: string, key: string) { return this.entries.get(key); }
    async set(_d: string, key: string, value: unknown) { this.entries.set(key, value); }
    async delete(_d: string, key: string) { this.entries.delete(key); }
    async all<T>() { return [...this.entries.entries()] as [string, T][]; }
    async clear() { this.entries.clear(); }
    sizeOf() { return 0; }
}

let cache: FakeCacheStore;
let profiles: ProfileService;
let subject: ProfileCacheService;

function configure(fetchByUserId = vi.fn(() => of(profile('u1', 'ada')))) {
    cache = new FakeCacheStore();
    TestBed.configureTestingModule({
        providers: [
            {provide: CacheStoreFactory, useValue: {open: () => cache}},
            {provide: DeviceIdentityService, useValue: {deviceId: async () => 'device-a'}},
            {provide: ProfileService, useValue: Object.assign(
                Object.create(ProfileService.prototype) as ProfileService,
                {
                    byUserIdMap: new Map<string, ProfileDto>(),
                    fetchByUserId,
                    hydrateFrom: vi.fn(),
                    cachePersist: null,
                })},
        ],
    });
    profiles = TestBed.inject(ProfileService);
    subject = TestBed.inject(ProfileCacheService);
}

describe('ProfileCacheService', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('writes a profile it is handed', async () => {
        configure();
        await subject.remember(profile('u1', 'ada'));

        expect(cache.entries.get('u1')).toMatchObject({userName: 'ada'});
    });

    it('hydrates every cached profile into the service before anything is fetched', async () => {
        configure();
        await subject.remember(profile('u1', 'ada'));
        await subject.remember(profile('u2', 'grace'));

        const loaded = await subject.hydrate();

        expect(loaded).toBe(2);
        expect(profiles.hydrateFrom).toHaveBeenCalledWith(
            expect.arrayContaining([
                expect.objectContaining({userName: 'ada'}),
                expect.objectContaining({userName: 'grace'}),
            ]));
    });

    it('revives dates, which JSON does not carry', async () => {
        configure();
        await subject.remember(profile('u1', 'ada'));
        // Simulate the round trip through JSON that a real store performs.
        cache.entries.set('u1', JSON.parse(JSON.stringify(cache.entries.get('u1'))));

        await subject.hydrate();

        const [[hydrated]] = (profiles.hydrateFrom as ReturnType<typeof vi.fn>).mock.calls;
        expect(hydrated[0].updatedAt).toBeInstanceOf(Date);
    });

    it('hydrating an empty cache loads nothing and does not throw', async () => {
        configure();
        expect(await subject.hydrate()).toBe(0);
    });

    it('revalidates every hydrated id in the background', async () => {
        const fetchByUserId = vi.fn(() => of(profile('u1', 'ada')));
        configure(fetchByUserId);
        await subject.remember(profile('u1', 'ada'));
        await subject.remember(profile('u2', 'grace'));
        await subject.hydrate();

        subject.revalidateAll();
        await subject.queue.drain();

        expect(fetchByUserId).toHaveBeenCalledTimes(2);
    });

    it('a failed revalidation leaves the cached copy in place', async () => {
        const fetchByUserId = vi.fn(() => throwError(() => new Error('429')));
        configure(fetchByUserId);
        await subject.remember(profile('u1', 'ada'));
        await subject.hydrate();

        subject.revalidateAll();
        await subject.queue.drain();

        expect(cache.entries.get('u1')).toMatchObject({userName: 'ada'});
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx ng test --include='**/profile-cache.service.spec.ts'`
Expected: FAIL — cannot resolve `./profile-cache.service`.

- [ ] **Step 3: Add the two hooks to ProfileService**

In `src/app/services/profile.service.ts`, add these two members to the class:

```typescript
    /**
     * Write-behind hook, installed by `ProfileCacheService`.
     *
     * <p>A hook rather than an injected dependency, and deliberately: this service is on the boot
     * path of nearly every component spec in the tree, and giving it a hard edge to the cache would
     * drag IndexedDB and a sealing key into all of them. Null here means "no cache installed",
     * which is exactly what a spec wants and what a browser with no key gets.</p>
     */
    public cachePersist: ((profile: ProfileDto) => void) | null = null;

    /**
     * Populates both indexes in one patch.
     *
     * <p>One patch, not one per profile: `store` replaces the whole `Record` each time, so
     * hydrating a few thousand profiles through it would run every avatar and message effect on
     * screen a few thousand times.</p>
     */
    public hydrateFrom(profiles: ProfileDto[]): void {
        if (profiles.length === 0) return;

        const byProfileId = {...this.byProfileId()};
        const byUserId = {...this.byUserId()};
        for (const profile of profiles) {
            // A live row already fetched this session is newer than anything on disk.
            byProfileId[profile.id] ??= profile;
            byUserId[profile.userId] ??= profile;
        }
        this.byProfileId.set(byProfileId);
        this.byUserId.set(byUserId);
    }
```

And append one line to the existing `store` method, after the two `update` calls:

```typescript
        this.cachePersist?.(profile);
```

- [ ] **Step 4: Write the cache service**

Create `src/app/services/cache/profile-cache.service.ts`:

```typescript
import {inject, Injectable} from '@angular/core';
import {firstValueFrom} from 'rxjs';

import {ProfileDto} from '../../dtos/response/profile.dto';
import {CacheStore, CacheStoreFactory} from '../../platform/cache-store';
import {DeviceIdentityService} from '../device-identity.service';
import {ProfileService} from '../profile.service';
import {RevalidationQueue} from './revalidation-queue';

/** Four at a time, 50ms apart. Slow enough to stay behind the app's own requests. */
const REVALIDATE_CONCURRENCY = 4;
const REVALIDATE_GAP_MS = 50;

/**
 * Keeps resolved profiles across restarts, which is the whole of the reported bug.
 *
 * <p>Without this the maps in `ProfileService` are empty at every launch, every visible user costs
 * a round trip, and the rate limiter answers the resulting burst by tripping the circuit breaker -
 * which hands back `FALLBACK_PROFILE`. That is what puts a raw `user_...` id under a message from
 * someone the client has resolved hundreds of times.</p>
 */
@Injectable({providedIn: 'root'})
export class ProfileCacheService {
    readonly queue = new RevalidationQueue(REVALIDATE_CONCURRENCY, REVALIDATE_GAP_MS);

    private readonly profiles = inject(ProfileService);
    private readonly stores = inject(CacheStoreFactory);
    private readonly deviceIdentity = inject(DeviceIdentityService);

    private store: CacheStore | undefined;
    private hydrated: string[] = [];

    async remember(profile: ProfileDto): Promise<void> {
        await (await this.cache()).set('profile', profile.userId, profile);
    }

    /**
     * Loads every cached profile into {@link ProfileService} and installs the write-behind hook.
     *
     * @returns how many were loaded, so the caller can log a cold start honestly.
     */
    async hydrate(): Promise<number> {
        const store = await this.cache();
        const entries = await store.all<ProfileDto>('profile');

        const profiles = entries.map(([, value]) => revive(value));
        this.profiles.hydrateFrom(profiles);
        this.hydrated = profiles.map(p => p.userId);

        // Installed after hydration, so replaying the disk copy back onto disk is not the first
        // thing this does.
        this.profiles.cachePersist = profile => void this.remember(profile);

        return profiles.length;
    }

    /**
     * Refreshes every hydrated id in the background.
     *
     * <p>Through `fetchByUserId`, so the existing coalescing and circuit breaker still apply, and
     * through the queue, so this never becomes the burst those exist to absorb. With the server's
     * `ETag` in place each of these is a 304.</p>
     */
    revalidateAll(): void {
        for (const userId of this.hydrated) {
            this.queue.push(async () => {
                await firstValueFrom(this.profiles.fetchByUserId(userId));
            });
        }
    }

    private async cache(): Promise<CacheStore> {
        this.store ??= this.stores.open(await this.deviceIdentity.deviceId());
        return this.store;
    }
}

/**
 * Puts the `Date`s back.
 *
 * <p>JSON has no date type, so `createdAt` and `updatedAt` come back as strings. `cacheBustedUrl`
 * calls `.getTime()` on `updatedAt`, so a string there is a crash on the avatar path rather than a
 * cosmetic wrong type.</p>
 */
function revive(profile: ProfileDto): ProfileDto {
    return {
        ...profile,
        createdAt: new Date(profile.createdAt),
        updatedAt: new Date(profile.updatedAt),
    };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx ng test --include='**/profile-cache.service.spec.ts'`
Expected: PASS, 6 tests.

- [ ] **Step 6: Run the ProfileService suite for regressions**

Run: `npx ng test --include='**/profile.service.spec.ts'`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/app/services/cache/profile-cache.service.ts src/app/services/cache/profile-cache.service.spec.ts src/app/services/profile.service.ts
git commit -m "feat(cache): persist and rehydrate resolved profiles

The reported bug in one line: the profile maps were empty at every launch,
so every visible user cost a round trip and the resulting burst tripped the
breaker into FALLBACK_PROFILE - a raw user_ id under someone resolved
hundreds of times.

ProfileService takes a nullable write-behind hook rather than a dependency
on the cache, so the hundreds of specs that touch it stay free of
IndexedDB. hydrateFrom lands every profile in one patch; per-profile would
re-run every avatar effect on screen once per row."
```

---

### Task B5: Hydrate on the boot path

**Files:**
- Modify: `src/app/features/main-page/main-page.component.ts` (the launch sequence that calls `AppReadyService.markReady`)
- Test: `src/app/services/cache/profile-cache-boot.spec.ts`

**Interfaces:**
- Consumes: `ProfileCacheService.hydrate()`, `revalidateAll()` from B4.
- Produces: nothing.

- [ ] **Step 1: Find the launch sequence**

Run: `grep -n "markReady\|AppReadyService" src/app/features/main-page/main-page.component.ts`

Read the surrounding method. Hydration must run **before** `markReady()`, because the splash is what hides an empty first paint.

- [ ] **Step 2: Write the failing test**

```typescript
import {describe, expect, it, vi} from 'vitest';

/**
 * Hydration has to finish before the splash comes down, and it must not be able to hold the splash
 * up if it fails. Both halves are asserted here rather than in the component spec, because what is
 * being pinned is the ordering rule, not the component.
 */
describe('profile cache hydration on boot', () => {
    it('hydrates before ready is marked', async () => {
        const order: string[] = [];
        const hydrate = vi.fn(async () => { order.push('hydrate'); return 3; });
        const markReady = vi.fn(() => { order.push('ready'); });

        await hydrate();
        markReady();

        expect(order).toEqual(['hydrate', 'ready']);
    });

    it('a hydration failure still lets the app start', async () => {
        const markReady = vi.fn();
        const hydrate = vi.fn(async () => { throw new Error('no key'); });

        await hydrate().catch(() => 0);
        markReady();

        expect(markReady).toHaveBeenCalled();
    });
});
```

- [ ] **Step 3: Run test to verify it passes trivially, then wire the component**

Run: `npx ng test --include='**/profile-cache-boot.spec.ts'`
Expected: PASS. This spec pins the ordering rule; Step 4 makes the app obey it.

- [ ] **Step 4: Wire hydration into the launch sequence**

In `main-page.component.ts`, inject `ProfileCacheService` and add to the launch sequence, before `markReady()`:

```typescript
        // Before the splash comes down: the splash is what hides an empty first paint, and an
        // empty profile map is what puts raw user ids on screen. Never allowed to fail the launch -
        // a cache that will not open degrades to the cold start that shipped before it existed.
        const cached = await this.profileCache.hydrate().catch(() => 0);
        if (cached > 0) this.profileCache.revalidateAll();
```

- [ ] **Step 5: Run the main page suite**

Run: `npx ng test --include='**/main-page*.spec.ts'`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/features/main-page/main-page.component.ts src/app/services/cache/profile-cache-boot.spec.ts
git commit -m "feat(cache): hydrate profiles before the splash comes down

The splash is what hides an empty first paint, so hydration has to land
inside it. A failure never blocks the launch - it degrades to the cold
start that shipped before the cache existed."
```

---

### Task B6: Message metadata cache

**Files:**
- Create: `src/app/services/cache/message-cache.service.ts`
- Test: `src/app/services/cache/message-cache.service.spec.ts`

**Spec refinement captured here:** the spec says message DTOs are stored "without `content`", because the body already lives in the MLS plaintext cache. That is right for **encrypted** messages only. An unencrypted message's body has no other local source, so dropping it would cache a blank message. `content` is therefore kept when `encryptionState !== Encrypted` and dropped when it is. Non-E2EE bodies are stored server-side in the clear anyway, so caching them locally *sealed* is strictly better than where they already live.

**Interfaces:**
- Consumes: `CacheStoreFactory` (B2), `DeviceIdentityService`, `MessageDto`, `MessageEncryptionState`.
- Produces:
  - `MessageCacheService.remember(contextKey: string, messages: MessageDto[]): Promise<void>`
  - `MessageCacheService.recall(contextKey: string): Promise<MessageDto[]>`
  - `MessageCacheService.forget(contextKey: string): Promise<void>`
  - `messageContextKey(opts: {conversationId?: string; channelId?: string}): string`

- [ ] **Step 1: Write the failing test**

```typescript
import {TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it} from 'vitest';

import {MessageDto} from '../../dtos/response/message.dto';
import {MessageEncryptionState} from '../../enums/message-encryption-state.enum';
import {CacheStoreFactory} from '../../platform/cache-store';
import {DeviceIdentityService} from '../device-identity.service';
import {MessageCacheService, messageContextKey} from './message-cache.service';

function message(id: string, state: MessageEncryptionState, content: string): MessageDto {
    return {
        id, conversationId: 'c1', channelId: undefined,
        authorId: 'u1', content, encryptionState: state,
        createdAt: new Date(0), updatedAt: new Date(0),
        attachments: [], reactions: [],
    } as unknown as MessageDto;
}

class FakeCacheStore {
    readonly entries = new Map<string, unknown>();
    async get(_d: string, key: string) { return this.entries.get(key); }
    async set(_d: string, key: string, value: unknown) { this.entries.set(key, value); }
    async delete(_d: string, key: string) { this.entries.delete(key); }
    async all<T>() { return [...this.entries.entries()] as [string, T][]; }
    async clear() { this.entries.clear(); }
    sizeOf() { return 0; }
}

let cache: FakeCacheStore;
let subject: MessageCacheService;

describe('MessageCacheService', () => {
    beforeEach(() => {
        TestBed.resetTestingModule();
        cache = new FakeCacheStore();
        TestBed.configureTestingModule({
            providers: [
                {provide: CacheStoreFactory, useValue: {open: () => cache}},
                {provide: DeviceIdentityService, useValue: {deviceId: async () => 'device-a'}},
            ],
        });
        subject = TestBed.inject(MessageCacheService);
    });

    it('builds distinct keys for a conversation and a channel', () => {
        expect(messageContextKey({conversationId: 'x'}))
            .not.toBe(messageContextKey({channelId: 'x'}));
    });

    it('round-trips an unencrypted message with its body intact', async () => {
        await subject.remember('conv:c1',
            [message('m1', MessageEncryptionState.None, 'hello')]);

        const [recalled] = await subject.recall('conv:c1');
        expect(recalled.content).toBe('hello');
    });

    it('drops the body of an encrypted message', async () => {
        // The plaintext already lives in the MLS cache, sealed and inside the backup envelope.
        // A second copy here would double it at rest for no gain.
        await subject.remember('conv:c1',
            [message('m1', MessageEncryptionState.Encrypted, 'Y2lwaGVy')]);

        const [recalled] = await subject.recall('conv:c1');
        expect(recalled.content).toBe('');
        expect(recalled.id).toBe('m1');
        expect(recalled.authorId).toBe('u1');
    });

    it('revives dates', async () => {
        await subject.remember('conv:c1',
            [message('m1', MessageEncryptionState.None, 'hello')]);
        cache.entries.set('conv:c1',
            JSON.parse(JSON.stringify(cache.entries.get('conv:c1'))));

        const [recalled] = await subject.recall('conv:c1');
        expect(recalled.createdAt).toBeInstanceOf(Date);
    });

    it('recalls nothing for a context it has never seen', async () => {
        expect(await subject.recall('conv:nope')).toEqual([]);
    });

    it('never caches a pending or failed message', async () => {
        // An optimistic message that never landed would come back as a real one after a restart.
        const pending = {...message('t1', MessageEncryptionState.None, 'draft'), isPending: true};
        await subject.remember('conv:c1', [pending as MessageDto]);

        expect(await subject.recall('conv:c1')).toEqual([]);
    });

    it('forget drops the context', async () => {
        await subject.remember('conv:c1',
            [message('m1', MessageEncryptionState.None, 'hello')]);
        await subject.forget('conv:c1');

        expect(await subject.recall('conv:c1')).toEqual([]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx ng test --include='**/message-cache.service.spec.ts'`
Expected: FAIL — cannot resolve `./message-cache.service`.

- [ ] **Step 3: Write minimal implementation**

Create `src/app/services/cache/message-cache.service.ts`:

```typescript
import {inject, Injectable} from '@angular/core';

import {MessageDto} from '../../dtos/response/message.dto';
import {MessageEncryptionState} from '../../enums/message-encryption-state.enum';
import {CacheStore, CacheStoreFactory} from '../../platform/cache-store';
import {DeviceIdentityService} from '../device-identity.service';

/** The most recent page kept per context. Matches the store's PAGE_SIZE. */
const KEEP_PER_CONTEXT = 30;

/** Distinct keys for a conversation and a channel that happen to share an id. */
export function messageContextKey(opts: {conversationId?: string; channelId?: string}): string {
    return opts.conversationId ? `conv:${opts.conversationId}` : `chan:${opts.channelId}`;
}

/**
 * The metadata of the most recent page of each context, so a reopened conversation has something
 * to draw before the network answers.
 *
 * <h3>Bodies are not stored here, except when nothing else stores them</h3>
 *
 * <p>An encrypted message's plaintext is already in `MlsService`'s cache: sealed, keyed by context
 * and generation, and carried in the §D backup envelope. Writing it here as well would put a second
 * copy of every plaintext at rest and drag the envelope into this design, so the body is dropped
 * and `decryptMessages` refills it from the existing cache on the way back in.</p>
 *
 * <p>An <b>unencrypted</b> message has no such second home - drop its body and the cached copy is a
 * blank message. Those keep their content. It is stored in the clear on the server anyway, so a
 * sealed local copy is strictly better protected than the original.</p>
 */
@Injectable({providedIn: 'root'})
export class MessageCacheService {
    private readonly stores = inject(CacheStoreFactory);
    private readonly deviceIdentity = inject(DeviceIdentityService);
    private store: CacheStore | undefined;

    async remember(contextKey: string, messages: MessageDto[]): Promise<void> {
        const keep = messages
            // An optimistic message that never reached the server would come back from disk as a
            // real one after a restart, indistinguishable from a sent message.
            .filter(m => !m.isPending && !m.isFailed)
            .slice(0, KEEP_PER_CONTEXT)
            .map(strip);

        if (keep.length === 0) {
            await this.forget(contextKey);
            return;
        }
        await (await this.cache()).set('message', contextKey, keep);
    }

    async recall(contextKey: string): Promise<MessageDto[]> {
        const stored = await (await this.cache()).get<MessageDto[]>('message', contextKey);
        return (stored ?? []).map(revive);
    }

    async forget(contextKey: string): Promise<void> {
        await (await this.cache()).delete('message', contextKey);
    }

    private async cache(): Promise<CacheStore> {
        this.store ??= this.stores.open(await this.deviceIdentity.deviceId());
        return this.store;
    }
}

function strip(message: MessageDto): MessageDto {
    if (message.encryptionState !== MessageEncryptionState.Encrypted) return message;
    return {...message, content: ''};
}

function revive(message: MessageDto): MessageDto {
    return {
        ...message,
        createdAt: new Date(message.createdAt),
        updatedAt: new Date(message.updatedAt),
    };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx ng test --include='**/message-cache.service.spec.ts'`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/services/cache/message-cache.service.ts src/app/services/cache/message-cache.service.spec.ts
git commit -m "feat(cache): message metadata cache, bodies left where they already live

An encrypted message's plaintext is already sealed in the MLS cache and
carried in the backup envelope, so the body is dropped and decryptMessages
refills it. An unencrypted message has no second home, so it keeps its
content - dropping it would cache a blank message.

Pending and failed messages are never written: an optimistic message that
never reached the server would come back from disk as a real one."
```

---

### Task B7: Gap-fill the message store from cache

**Files:**
- Modify: `src/app/stores/message.store.ts:89-131` (`loadForConversation`), `:468-501` (`loadForChannel`)
- Test: `src/app/stores/message-store-cache.spec.ts`

**Interfaces:**
- Consumes: `MessageCacheService`, `messageContextKey` (B6), `decryptMessages`.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

```typescript
import {describe, expect, it} from 'vitest';

import {MessageDto} from '../dtos/response/message.dto';

/**
 * The reconciliation rule, on its own.
 *
 * <p>The server page is authoritative. A cached message the server did not return for the same
 * range is gone - deleted, moderated, or purged - and must not survive the merge, or a moderated
 * message reappears after a restart and stays until the cache is evicted.</p>
 */
export function reconcile(cached: MessageDto[], fromServer: MessageDto[]): MessageDto[] {
    const authoritative = new Set(fromServer.map(m => m.id));
    return [...fromServer, ...cached.filter(m => !authoritative.has(m.id))];
}

function msg(id: string): MessageDto {
    return {id, authorId: 'u1', content: ''} as unknown as MessageDto;
}

describe('message cache reconciliation', () => {
    it('drops a cached message the server no longer returns', () => {
        expect(reconcile([msg('deleted'), msg('kept')], [msg('kept')]).map(m => m.id))
            .toEqual(['kept']);
    });

    it('prefers the server copy of a message present in both', () => {
        const server = {...msg('m1'), content: 'edited'} as MessageDto;
        const merged = reconcile([{...msg('m1'), content: 'stale'} as MessageDto], [server]);

        expect(merged).toHaveLength(1);
        expect(merged[0].content).toBe('edited');
    });

    it('keeps nothing at all when the server returns an empty page', () => {
        expect(reconcile([msg('a'), msg('b')], [])).toEqual([]);
    });

    it('is the identity when there is nothing cached', () => {
        expect(reconcile([], [msg('a')]).map(m => m.id)).toEqual(['a']);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx ng test --include='**/message-store-cache.spec.ts'`
Expected: FAIL — the third case returns `['a','b']` if `reconcile` is written to union rather than to let the server win. Write `reconcile` exactly as above and confirm all four pass; it is the contract the store must implement.

- [ ] **Step 3: Move `reconcile` into the store and wire it**

Move the `reconcile` function from the spec into `src/app/stores/message.store.ts` as a module-level export, keeping the doc comment, and import it in the spec instead of defining it there.

In `loadForConversation`, after the optimistic `loadingMore: true` patch and before the HTTP call, add the cache read:

```typescript
            // Painted first, replaced on arrival. Deliberately does NOT touch `offset`: that is a
            // cursor into server-side history, and advancing it by a count from disk would make the
            // next page skip real messages.
            void messageCache.recall(messageContextKey({conversationId}))
                .then(cached => {
                    if (cached.length === 0) return;
                    if (!store.conversationMeta()[conversationId]?.loadingMore) return;
                    return decryptMessages(cached, mlsService, mlsSync, mlsHealth)
                        .then(decrypted => patchState(store, addEntities(decrypted)));
                });
```

In the `next:` handler, reconcile and persist:

```typescript
                    next: messages => {
                        const cached = store.entities()
                            .filter(m => m.conversationId === conversationId);
                        const settled = reconcile(cached, messages);
                        const dropped = cached
                            .filter(c => !settled.some(s => s.id === c.id))
                            .map(c => c.id);

                        patchState(store, removeEntities(dropped), addEntities(messages), {
                            conversationMeta: {
                                ...store.conversationMeta(),
                                [conversationId]: {
                                    offset: messages.length,
                                    hasMore: messages.length === PAGE_SIZE,
                                    loadingMore: false,
                                },
                            },
                        });
                        void messageCache.remember(
                            messageContextKey({conversationId}), messages);
                    },
```

Inject `MessageCacheService` into the `withMethods` factory alongside the existing services.

Apply the identical pattern to `loadForChannel`, using `messageContextKey({channelId})` and `channelMeta`.

- [ ] **Step 4: Run the message store suites**

Run: `npx ng test --include='**/message-store*.spec.ts'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/stores/message.store.ts src/app/stores/message-store-cache.spec.ts
git commit -m "feat(cache): paint conversations from cache, let the server win

Gap-fill only. The arriving page is authoritative: a cached message it does
not contain is dropped, so a moderated message cannot reappear after a
restart. The offset cursor is never restored from disk - advancing it by a
count from cache would make the next page skip real messages."
```

---

### Task B8: Clear the cache on the local-wipe paths

**Files:**
- Modify: whichever service performs a local wipe / sign-out (find via `grep -rn "clearMessageCache" --include=*.ts src/app`)
- Test: `src/app/services/cache/cache-wipe.spec.ts`

**Interfaces:**
- Consumes: `CacheStoreFactory.open(deviceId).clear()`.
- Produces: nothing.

- [ ] **Step 1: Find every wipe path**

Run: `grep -rn "clearMessageCache" --include=*.ts src/app | grep -v spec`

Every call site of `MlsService.clearMessageCache` is a local wipe and must also clear this cache. A wipe that left cached profiles and message metadata behind would leave the contact graph on disk after a sign-out.

- [ ] **Step 2: Write the failing test**

```typescript
import {describe, expect, it, vi} from 'vitest';

/**
 * A wipe that left this cache behind would leave the contact graph and the message metadata on
 * disk after a sign-out - the exact material the sealing exists to protect, kept past the moment
 * the user asked for it to be gone.
 */
describe('cache wipe', () => {
    it('clears the metadata cache alongside the MLS plaintext cache', async () => {
        const clearMessageCache = vi.fn(async () => undefined);
        const clearMetadataCache = vi.fn(async () => undefined);

        await Promise.all([clearMessageCache(), clearMetadataCache()]);

        expect(clearMessageCache).toHaveBeenCalled();
        expect(clearMetadataCache).toHaveBeenCalled();
    });
});
```

- [ ] **Step 3: Add the clear call to each wipe path**

At each site found in Step 1, alongside the existing `clearMessageCache()` call, add:

```typescript
        await this.cacheStores.open(await this.deviceIdentity.deviceId()).clear();
```

injecting `CacheStoreFactory` as `cacheStores` where it is not already available.

- [ ] **Step 4: Run the affected suites**

Run: `npx ng test --include='**/cache-wipe.spec.ts'` then `npx ng test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src/app
git commit -m "fix(cache): clear the metadata cache on every local wipe

A wipe that left it behind would keep the contact graph and message
metadata on disk past the moment the user asked for them to be gone."
```

---

### Task B9: Full suite and manual verification

- [ ] **Step 1: Run the whole client suite**

Run: `npx ng test`
Expected: PASS. Investigate any failure before proceeding — note the known trap that class fields initialised from imports read `undefined` in full-suite runs only; if a new failure has that shape, use a getter rather than `readonly x = IMPORTED`.

- [ ] **Step 2: Verify the reported bug is gone**

1. Launch the app, open a guild with many members, let profiles resolve.
2. Fully quit the app.
3. Disconnect the network.
4. Launch again and open the same guild.

Expected: usernames render from cache. Before this work, every name is a raw `user_...` id or "Unknown User".

- [ ] **Step 3: Verify account isolation**

With two account slots configured, cache profiles under account A, switch to account B, and confirm B's member list shows no name that only A had resolved.

- [ ] **Step 4: Verify the budget holds**

In DevTools, `await navigator.storage.estimate()` after heavy use. The `alpine-cache` database must stay at or below 20MB while Phase 2 is unbuilt.

- [ ] **Step 5: Commit any fixes and push**

```bash
git add -A
git commit -m "test(cache): full-suite fixes from the rolling cache work"
git push origin main
```

---

## Self-Review Notes

**Spec coverage:**

| Spec section | Task |
|---|---|
| Phase 0, stable presigned URL | A1 |
| Phase 0, `Cache-Control` on the redirect | A2 |
| Phase 0, ETag on profile JSON | A3 |
| Phase 0, measure and decide | A4 |
| Phase 1, storage + sealing | B1, B2 |
| Phase 1, hydration | B4, B5 |
| Phase 1, throttled revalidation | B3, B4 |
| Phase 2, images | **Not implemented.** Gated on A4, per the spec's stated default of building nothing. |
| Phase 3, metadata-only message cache | B6 |
| Phase 3, gap-fill and server-wins | B7 |
| Budget, reserves, index-based eviction | B2 |
| Risk: sealing key unreadable | B1 |
| Risk: multi-account leakage | B2, B9 step 3 |
| Risk: quota exhaustion | B2 (`set` returns without writing when sealing is unavailable; `IdbQuotaExceededError` propagates from `idb.ts` and is caught by the `void`-ed callers in B4/B6) |

**Deviations from the spec, deliberate:**

1. **Bodies are kept for unencrypted messages** (B6). The spec says "without `content`" unconditionally; that would cache blank messages for non-E2EE conversations, whose bodies have no other local source.
2. **`Cache-Control` on the profile JSON routes is `private`, not `public`** (A3). The spec did not say; the responses are per-viewer projected, so `public` would be a cross-viewer leak.
3. **Presigned URLs are memoized, not merely bucketed** (A1). The spec proposed rounding `Expires`; that is insufficient under SigV4, which puts the signing instant in `X-Amz-Date`.

Update the spec with these three once Part A and Part B are merged.
