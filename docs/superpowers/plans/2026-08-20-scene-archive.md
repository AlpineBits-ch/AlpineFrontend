# Scene Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give roleplay guilds a structured archive of finished scenes: folders, tags, a detail sheet, and reading a concluded scene from its first post.

**Architecture:** Two new Guild entities (`SceneFolder`, `SceneTag`) plus a join table, reached through routes modelled on `ForumTagEndpoint`, surfaced as an Archive mode beside the existing scene board. Reading from the start needs one new Messaging capability (an anchorless oldest page) and a two-edged message window in the client store.

**Tech Stack:** .NET 10 / EF Core 10 / Wolverine / Postgres + Scylla (repo `C:\Users\Domin\RiderProjects\Echo`). Angular 21 / signals / Tailwind / PrimeNG (repo `C:\Users\Domin\WebstormProjects\Alpine`).

**Spec:** `docs/superpowers/specs/2026-08-20-scene-archive-design.md`

## Global Constraints

- No em dashes anywhere: code, comments, UI copy, commit messages.
- Commits: conventional prefix, one line, lowercase, imperative, no body, no trailers.
- Angular: `inject()`, `input()`/`output()`/`model()`, `ChangeDetectionStrategy.OnPush`, standalone, control-flow blocks, signals for state.
- Client indent 4 spaces, single quotes, semicolons, no bracket spacing in imports. `bun run lint` and `bun run format` are the authority. Format only files you touched, never bare `bun run format`.
- Client tests: `bun run test`, single spec `bun run ng test --watch=false --include="**/name.spec.ts"`. Never bare `vitest` or `npx ng`.
- Never write `readonly x = SOME_IMPORTED_CONST` as a class field in a spec. Use a getter.
- Backend: never hand-edit a migration. Generate with `dotnet ef`, after refreshing PATH (see Task 3).
- Backend Wolverine handlers that change state must not call `SaveChangesAsync`.
- Backend: use `Domain.Aggregates.Channel` with `HasOne<Channel>()` and no inverse navigation. A collection on the Channel aggregate widens the Facet materialization graph.
- New i18n keys are flat dot-separated and live in the `src/assets/i18n/locales` submodule, which needs its own commit.
- Caps, copied from the spec: 40 tags per guild, 5 tags per scene, tag name 20 chars, folder name 32 chars, folder depth 2.
- Reserved `folderId` filter value: `unfiled`. Reserved update convention: empty string clears a nullable field, null leaves it untouched (`ForumTag.Update`'s rule).

---

## Phase 0: the reported bug

### Task 1: Concluded scenes stop vanishing

**Files:**

- Modify: `src/app/dtos/request/scene.dto.ts`
- Modify: `src/app/services/roleplay-api.service.ts:62`
- Modify: `src/app/services/scene.service.ts:172-190`
- Test: `src/app/services/scene.service.spec.ts` (create if absent)

**Interfaces:**

- Consumes: nothing.
- Produces: `SceneListParams`, and `RoleplayApi.listScenes(guildId: string, params?: SceneListParams): Observable<SceneListDto>`. Every later client task calls this overload.

- [ ] **Step 1: Write the failing test**

```ts
it('asks the server for concluded and archived scenes', () => {
  const api = TestBed.inject(RoleplayApi) as unknown as {listScenes: ReturnType<typeof vi.fn>};
  service.ensureGuild('gld_1');
  expect(api.listScenes).toHaveBeenCalledWith('gld_1', {includeConcluded: true, includeArchived: true});
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun run ng test --watch=false --include="**/scene.service.spec.ts"`
Expected: FAIL, `listScenes` called with one argument.

- [ ] **Step 3: Add `SceneListParams` and widen the API**

```ts
/** Query for `GET /guilds/{id}/scenes`. Omitted flags take the server's defaults, which exclude
 *  concluded and archived scenes. */
export interface SceneListParams {
  waitingOnMe?: boolean;
  includeConcluded?: boolean;
  includeArchived?: boolean;
  /** A folder id, or the reserved `unfiled`. */
  folderId?: string | null;
  /** ANDed: a scene must carry all of them. */
  tagIds?: string[];
  /** Scene name only. Never message content. */
  q?: string;
  sort?: 'board' | 'name' | 'ended';
  offset?: number;
  limit?: number;
}
```

In `roleplay-api.service.ts`, build `HttpParams` from the object, skipping undefined and joining `tagIds` with a comma. The board sends `{includeConcluded: true, includeArchived: true}`.

- [ ] **Step 4: Run the test again**

Run: `bun run ng test --watch=false --include="**/scene.service.spec.ts"`
Expected: PASS.

- [ ] **Step 5: Lint, format, commit**

```bash
bun run lint
git add src/app/dtos/request/scene.dto.ts src/app/services/roleplay-api.service.ts src/app/services/scene.service.ts src/app/services/scene.service.spec.ts
git commit -m "fix: keep concluded scenes on the board after a reload"
```

---

## Phase 1: Guild backend

Repo: `C:\Users\Domin\RiderProjects\Echo`. Use the built-in file tools there, not shell `cat`/`grep`.

### Task 2: The two entities and the join row

**Files:**

- Create: `Guild.Domain/Entity/SceneFolder.cs`
- Create: `Guild.Domain/Entity/SceneTag.cs`
- Create: `Guild.Domain/Entity/SceneTagAssignment.cs`
- Create: `Guild.Domain/Validators/SceneFolderValidator.cs`
- Create: `Guild.Domain/Validators/SceneTagValidator.cs`
- Modify: `Guild.Domain/Entity/SceneState.cs`
- Test: `Guild.Tests/Domain/SceneTaxonomyTests.cs`

**Interfaces:**

- Consumes: nothing.
- Produces: `SceneFolder` (prefix `scfd`), `SceneTag` (prefix `sctg`), `SceneTagAssignment`, and two new `SceneState` properties `FolderId` and `ConcludedAt`. Every Phase 1 task uses these names.

Copy `ForumTag.cs` wholesale for `SceneTag`, changing `ChannelId` to nothing (the guild is the scope) and keeping `GuildId`, `Name`, `Color`, `EmojiId`, `EmojiName`, `Position`, `Moderated`, the `DefaultColor` constant, the mutually-exclusive emoji rule in `Update`, and `NullIfBlank`. Constants: `MaxNameLength = 20`, `MaxTagsPerGuild = 40`, `MaxTagsPerScene = 5`.

`SceneFolder` follows `WikiCategory`: `GuildId`, `Name`, `Position`, `ParentFolderId?`, plus `Icon?` and `Color?`. Constants: `MaxNameLength = 32`, `MaxDepth = 2`.

- [ ] **Step 1: Write the failing tests**

```csharp
[Test]
public void Folder_rejects_a_name_past_the_cap()
{
    var act = () => SceneFolder.Create(new CreateSceneFolderParams
    {
        GuildId = "gld_1", Name = new string('x', SceneFolder.MaxNameLength + 1),
    });

    act.Should().Throw<ValidationException>();
}

[Test]
public void Tag_keeps_one_emoji_at_a_time()
{
    var tag = SceneTag.Create(new CreateSceneTagParams
    {
        GuildId = "gld_1", Name = "betrayal", EmojiName = "\U0001F5E1",
    });

    tag.Update(new SceneTag.UpdateSceneTagParams { EmojiId = "emj_1" });

    tag.EmojiId.Should().Be("emj_1");
    tag.EmojiName.Should().BeNull();
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `dotnet test Guild.Tests/Guild.Tests.csproj --filter FullyQualifiedName~SceneTaxonomyTests`
Expected: FAIL, the types do not exist.

- [ ] **Step 3: Write the entities and validators**

Mirror `ForumTagValidator` for `SceneTagValidator` (name required, trimmed, `MaxNameLength`, colour a hex string or the default). `SceneFolderValidator` checks name required and `MaxNameLength`. Depth is not a validator concern: it needs a database read and belongs in the endpoint.

Add to `SceneState`:

```csharp
    /// <summary>The archive folder this scene is filed under, or null when it is unfiled.</summary>
    public string? FolderId { get; set; }

    /// <summary>When the scene ended. UpdatedAt cannot answer this: an edit to a concluded
    /// scene's note moves it.</summary>
    public DateTimeOffset? ConcludedAt { get; set; }
```

- [ ] **Step 4: Run the tests again**

Run: `dotnet test Guild.Tests/Guild.Tests.csproj --filter FullyQualifiedName~SceneTaxonomyTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Guild.Domain/Entity/SceneFolder.cs Guild.Domain/Entity/SceneTag.cs Guild.Domain/Entity/SceneTagAssignment.cs Guild.Domain/Validators/SceneFolderValidator.cs Guild.Domain/Validators/SceneTagValidator.cs Guild.Domain/Entity/SceneState.cs Guild.Tests/Domain/SceneTaxonomyTests.cs
git commit -m "feat(scenes): add folder and tag entities for the archive"
```

### Task 3: Model configuration and migration

**Files:**

- Modify: `Guild.Infrastructure/Persistence/MicroserviceContext.cs`
- Create: `Guild.Infrastructure/Migrations/<generated>_AddSceneArchive.cs`

**Interfaces:**

- Consumes: Task 2's entities.
- Produces: `DbSet<SceneFolder> SceneFolders`, `DbSet<SceneTag> SceneTags`, `DbSet<SceneTagAssignment> SceneTagAssignments`.

- [ ] **Step 1: Add the DbSets**

Beside `SceneStates` in the Roleplay block at `:37`.

- [ ] **Step 2: Configure the entities**

Follow the `ForumTag` and `ForumPostTag` blocks at `:915-948` exactly. No inverse navigations.

```csharp
        modelBuilder.Entity<SceneFolder>(folderBuilder =>
        {
            folderBuilder.HasOne<Domain.Aggregates.Guild>()
                .WithMany()
                .HasForeignKey(x => x.GuildId)
                .OnDelete(DeleteBehavior.Cascade);

            // Deleting a parent leaves its children standing at the root rather than taking a
            // guild's whole arc structure with it.
            folderBuilder.HasOne<SceneFolder>()
                .WithMany()
                .HasForeignKey(x => x.ParentFolderId)
                .OnDelete(DeleteBehavior.SetNull);

            folderBuilder.HasIndex(x => new { x.GuildId, x.Position });
        });

        modelBuilder.Entity<SceneTag>(tagBuilder =>
        {
            tagBuilder.HasOne<Domain.Aggregates.Guild>()
                .WithMany()
                .HasForeignKey(x => x.GuildId)
                .OnDelete(DeleteBehavior.Cascade);

            tagBuilder.HasIndex(x => new { x.GuildId, x.Position });
            tagBuilder.HasIndex(x => new { x.GuildId, x.Name }).IsUnique();
        });

        modelBuilder.Entity<SceneTagAssignment>(assignmentBuilder =>
        {
            assignmentBuilder.HasKey(x => new { x.SceneChannelId, x.TagId });

            assignmentBuilder.HasOne<Domain.Aggregates.Channel>()
                .WithMany()
                .HasForeignKey(x => x.SceneChannelId)
                .OnDelete(DeleteBehavior.Cascade);

            assignmentBuilder.HasOne<SceneTag>()
                .WithMany()
                .HasForeignKey(x => x.TagId)
                .OnDelete(DeleteBehavior.Cascade);

            // The PK answers "tags of this scene"; this answers "scenes carrying this tag", which
            // is what the archive filter runs.
            assignmentBuilder.HasIndex(x => x.TagId);
        });
```

In the existing `SceneState` block at `:671`, add the folder relationship:

```csharp
            // Unfiling, never a cascade: deleting a folder must not delete a campaign.
            sceneBuilder.HasOne<SceneFolder>()
                .WithMany()
                .HasForeignKey(x => x.FolderId)
                .OnDelete(DeleteBehavior.SetNull);

            sceneBuilder.HasIndex(x => new { x.GuildId, x.FolderId });
```

- [ ] **Step 3: Generate the migration**

Never hand-write it. In PowerShell:

```powershell
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') + ';' + "$env:USERPROFILE\.dotnet\tools"
dotnet ef migrations add AddSceneArchive --project Guild.Infrastructure --startup-project Echo
```

- [ ] **Step 4: Check the generated migration**

Read it. It must create three tables, add `folder_id` and `concluded_at` to `scene_states`, and add four indexes. No enum changes. If it contains anything else, the snapshot was already out of step: stop and say so.

- [ ] **Step 5: Build and commit**

```bash
dotnet build Echo.sln
git add Guild.Infrastructure/
git commit -m "feat(scenes): persist archive folders, tags and assignments"
```

### Task 4: Set ConcludedAt on the transition

**Files:**

- Modify: `Guild.Application/Endpoints/SceneEndpoint.cs`
- Modify: `Guild.Application/Dtos/Response/SceneDtos.cs`
- Test: `Guild.Tests/Services/SceneTurnTests.cs`

**Interfaces:**

- Consumes: `SceneState.ConcludedAt`.
- Produces: `SceneConcludedDto.ConcludedAt` populated by the server rather than by the client.

- [ ] **Step 1: Write the failing test**

```csharp
[Test]
public void Concluding_stamps_the_end_date()
{
    var scene = SceneState.Create(new CreateSceneStateParams { ChannelId = "chn_1", GuildId = "gld_1" });
    var now = DateTimeOffset.UtcNow;

    scene.Conclude("And so the gate held.", now);

    scene.Status.Should().Be(SceneStatus.Concluded);
    scene.ConcludedAt.Should().Be(now);
}

[Test]
public void Concluding_twice_keeps_the_first_end_date()
{
    var scene = SceneState.Create(new CreateSceneStateParams { ChannelId = "chn_1", GuildId = "gld_1" });
    var first = DateTimeOffset.UtcNow;
    scene.Conclude(null, first);

    scene.Conclude("edited later", first.AddDays(3));

    scene.ConcludedAt.Should().Be(first);
}
```

- [ ] **Step 2: Run and watch it fail**

Run: `dotnet test Guild.Tests/Guild.Tests.csproj --filter FullyQualifiedName~SceneTurnTests`
Expected: FAIL, `Conclude` does not exist.

- [ ] **Step 3: Add `SceneState.Conclude`**

```csharp
    /// <summary>Ends the scene. The end date is stamped once: a later edit to the note is an edit
    /// to a chronicle, not a second ending.</summary>
    /// <param name="note">The closing line, or null to leave the existing one.</param>
    /// <param name="now">The instant the scene ended.</param>
    public void Conclude(string? note, DateTimeOffset now)
    {
        Status = SceneStatus.Concluded;
        if (note is not null) ConclusionNote = note;
        ConcludedAt ??= now;
        CurrentTurnPersonaId = null;
        TurnDeadlineAt = null;
        UpdatedAt = now;
    }
```

Route the PATCH endpoint's conclude branch through it instead of setting `Status` inline, and put `ConcludedAt` on `SceneDto` and `SceneConcludedDto`.

- [ ] **Step 4: Run again**

Run: `dotnet test Guild.Tests/Guild.Tests.csproj --filter FullyQualifiedName~SceneTurnTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Guild.Domain/Entity/SceneState.cs Guild.Application/ Guild.Tests/Services/SceneTurnTests.cs
git commit -m "feat(scenes): stamp when a scene ended"
```

### Task 5: Folder and tag routes

**Files:**

- Create: `Guild.Application/Endpoints/SceneTaxonomyEndpoint.cs`
- Create: `Guild.Application/Dtos/Request/SceneTaxonomyDtos.cs`
- Create: `Guild.Application/Dtos/Response/SceneTaxonomyDtos.cs`
- Test: `Guild.Tests/Endpoints/SceneTaxonomyEndpointTests.cs`

**Interfaces:**

- Consumes: Task 2's entities, `PersonaGate.CheckAsync` / `CheckMembershipAsync` (`Guild.Application/Services/PersonaGate.cs`).
- Produces: the ten routes in the spec's A3 table, and these response records:

```csharp
public record SceneFolderDto(string Id, string GuildId, string Name, int Position,
    string? ParentFolderId, string? Icon, string? Color);

public record SceneTagDto(string Id, string GuildId, string Name, string Color,
    string? EmojiId, string? EmojiName, int Position, bool Moderated);

public record SceneTaxonomyDto(List<SceneFolderDto> Folders, List<SceneTagDto> Tags);
```

Request bodies:

```csharp
public class CreateSceneFolderDto { public string Name { get; set; } = null!; public string? ParentFolderId { get; set; } public string? Icon { get; set; } public string? Color { get; set; } }
public class UpdateSceneFolderDto { public string? Name { get; set; } public string? ParentFolderId { get; set; } public string? Icon { get; set; } public string? Color { get; set; } public int? Position { get; set; } }
public class ReorderSceneFoldersDto { public List<string> FolderIds { get; set; } = []; }
public class CreateSceneTagDto { public string Name { get; set; } = null!; public string? Color { get; set; } public string? EmojiId { get; set; } public string? EmojiName { get; set; } public bool Moderated { get; set; } }
public class UpdateSceneTagDto { public string? Name { get; set; } public string? Color { get; set; } public string? EmojiId { get; set; } public string? EmojiName { get; set; } public bool? Moderated { get; set; } }
public class SetSceneTagsDto { public List<string> TagIds { get; set; } = []; }
```

On `UpdateSceneFolderDto.ParentFolderId`, empty string moves the folder to the root and null leaves it untouched, which is `ForumTag.Update`'s existing convention.

- [ ] **Step 1: Write the failing tests**

```csharp
[Test]
public async Task Rejects_a_folder_three_deep()
{
    var root = await CreateFolderAsync("Arc I", parent: null);
    var child = await CreateFolderAsync("Sidequests", parent: root.Id);

    var result = await CreateFolderRawAsync("Too deep", parent: child.Id);

    await AssertFaultAsync(result, "scene_folder_depth_exceeded");
}

[Test]
public async Task Deleting_a_folder_unfiles_its_scenes_and_reparents_its_children()
{
    var root = await CreateFolderAsync("Arc I", parent: null);
    var child = await CreateFolderAsync("Sidequests", parent: root.Id);
    var scene = await FileSceneAsync(folderId: root.Id);

    await DeleteFolderAsync(root.Id);

    (await ReadFolderAsync(child.Id))!.ParentFolderId.Should().BeNull();
    (await ReadSceneStateAsync(scene)).FolderId.Should().BeNull();
    (await ReadChannelAsync(scene)).Should().NotBeNull("deleting a folder is never a scene delete");
}

[Test]
public async Task A_moderated_tag_refuses_an_ordinary_member()
{
    var tag = await CreateTagAsync("canon", moderated: true);

    var result = await SetSceneTagsRawAsync(SceneId, [tag.Id], asMember: OrdinaryMember);

    await AssertFaultAsync(result, "scene_tag_moderated");
}

[Test]
public async Task Refuses_a_sixth_tag_on_one_scene()
{
    var tags = await CreateTagsAsync(count: 6);

    var result = await SetSceneTagsRawAsync(SceneId, tags.Select(t => t.Id).ToList());

    await AssertFaultAsync(result, "scene_tag_limit");
}
```

- [ ] **Step 2: Run and watch them fail**

Run: `dotnet test Guild.Tests/Guild.Tests.csproj --filter FullyQualifiedName~SceneTaxonomyEndpointTests`
Expected: FAIL, the endpoint does not exist.

- [ ] **Step 3: Write the endpoint**

Structure copied from `Guild.Application/Endpoints/ForumTagEndpoint.cs`. Every route resolves `userId` from `ClaimTypes.NameIdentifier`, then calls `PersonaGate` with `GuildFeatures.Scenes`: `CheckMembershipAsync` for the two GETs and the tag PUT, `CheckAsync(..., ModulePermissions.ManageScenes, GuildFeatures.Scenes)` for everything else.

Depth is checked by reading the proposed parent and refusing when it already has a `ParentFolderId`. A move additionally refuses when the target is the folder itself or one of its descendants, with `scene_folder_cycle`.

Faults answer `{error, message}` through the same helper `SceneEndpoint` uses.

- [ ] **Step 4: Run again**

Run: `dotnet test Guild.Tests/Guild.Tests.csproj --filter FullyQualifiedName~SceneTaxonomyEndpointTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Guild.Application/Endpoints/SceneTaxonomyEndpoint.cs Guild.Application/Dtos/ Guild.Tests/Endpoints/SceneTaxonomyEndpointTests.cs
git commit -m "feat(scenes): add archive folder and tag routes"
```

### Task 6: The list query and the taxonomy event

**Files:**

- Modify: `Guild.Application/Endpoints/SceneEndpoint.cs:155-300`
- Modify: `Guild.Application/Dtos/Response/SceneDtos.cs`
- Create: `Guild.Contracts/Bus/Events/SceneTaxonomyChanged.cs`
- Test: `Guild.Tests/Endpoints/SceneListQueryTests.cs`

**Interfaces:**

- Consumes: Tasks 2 to 5.
- Produces: `folderId`, `tagIds`, `q`, `sort`, `offset` on `GET /guilds/{guildId}/scenes`; `FolderId`, `TagIds`, `ConcludedAt`, `CreatedAt` on `SceneListItemDto`; the `guild.SceneTaxonomyChanged` hub event.

- [ ] **Step 1: Write the failing tests**

The translation harness matters more than the assertions here: EF InMemory cannot fail on LINQ Npgsql would refuse, so these run through the dual-provider `ToQueryString` harness in `Guild.Tests`.

```csharp
[Test]
public void Folder_and_tag_filters_translate_to_sql()
{
    var query = SceneEndpoint.BuildListQuery(NpgsqlContext, "gld_1", null,
        includeArchived: true, includeConcluded: true,
        folderId: "scfd_1", tagIds: ["sctg_1", "sctg_2"], q: "siege", sort: SceneSort.Ended);

    var sql = query.ToQueryString();

    sql.Should().Contain("folder_id");
    sql.Should().NotContain("Client");
}

[Test]
public void Unfiled_means_a_null_folder()
{
    var query = SceneEndpoint.BuildListQuery(NpgsqlContext, "gld_1", null,
        includeArchived: true, includeConcluded: true, folderId: "unfiled");

    query.ToQueryString().Should().Contain("folder_id IS NULL");
}
```

- [ ] **Step 2: Run and watch them fail**

Run: `dotnet test Guild.Tests/Guild.Tests.csproj --filter FullyQualifiedName~SceneListQueryTests`
Expected: FAIL, `BuildListQuery` has the old signature.

- [ ] **Step 3: Widen the query**

Add a `SceneSort` enum (`Board`, `Name`, `Ended`) in `Guild.Domain/Enums`. Not a `HasPostgresEnum`: it is a query parameter, never a column, so it needs no migration.

Tag filtering ANDs by requiring a count match, which stays one SQL statement:

```csharp
        if (tagIds is {Count: > 0})
        {
            var wanted = tagIds.ToList();
            query = query.Where(row => ctx.Set<SceneTagAssignment>()
                .Count(a => a.SceneChannelId == row.State.ChannelId && wanted.Contains(a.TagId)) == wanted.Count);
        }
```

Tag ids for the page are a second batched query keyed on the page's channel ids, in the shape the existing `cast.ResolveAsync` call already uses. Never a join: a join multiplies rows and breaks the `Take(take + 1)` that computes `truncated`.

- [ ] **Step 4: Run again**

Run: `dotnet test Guild.Tests/Guild.Tests.csproj --filter FullyQualifiedName~SceneListQuery`
Expected: PASS.

- [ ] **Step 5: Publish the taxonomy event**

`guild.SceneTaxonomyChanged` carries `{guildId, folders, tags}`, the whole set. Fire it from every mutating route in Task 5, on the same hub path `guild.SceneUpdated` uses.

- [ ] **Step 6: Commit**

```bash
dotnet build Echo.sln
git add Guild.Application/ Guild.Contracts/ Guild.Domain/ Guild.Tests/
git commit -m "feat(scenes): filter the scene list by folder, tag and name"
```

---

## Phase 2: Messaging

### Task 7: An anchorless oldest page

**Files:**

- Modify: `Messaging.Application/Controllers/MessagingController.cs:32-46,100`
- Modify: `Messaging.Infrastructure/Persistence/Repositories/EfCoreMessageRepository.cs:104-159`
- Modify: `Messaging.Infrastructure/Persistence/Repositories/ScyllaMessageRepository.cs:96`
- Modify: the `MessagePageQuery` record
- Test: `Messaging.Tests/Repositories/OldestPageTests.cs`

**Interfaces:**

- Consumes: nothing.
- Produces: `?oldest=true` on `GET /api/v1/messaging/channels/{channelId}/messages`, returning the channel's first page in ascending order. The response shape is unchanged, so the client parses it exactly as it parses an offset page.

Why this is needed rather than an anchor: both repositories resolve the anchor first and return empty when it is missing (`EfCoreMessageRepository.cs:110-112`, `ScyllaMessageRepository.cs:104-105`), and `SceneEndpoint.cs:79` creates a scene channel with no `StarterMessageId`, so a scene has no known first message.

- [ ] **Step 1: Write the failing test**

```csharp
[Test]
public async Task Oldest_page_returns_the_first_messages_in_order()
{
    var ids = await SeedMessagesAsync(contextId: "chn_1", count: 30);

    var (page, _) = await Repository.GetMessagePageByCursorAsync(new MessagePageQuery
    {
        ContextId = "chn_1", AnchorMessageId = null,
        Direction = MessageCursorDirection.After, Limit = 10,
    });

    page.Select(m => m.Id).Should().Equal(ids.Take(10));
}
```

- [ ] **Step 2: Run and watch it fail**

Run: `dotnet test Messaging.Tests/Messaging.Tests.csproj --filter FullyQualifiedName~OldestPageTests`
Expected: FAIL, a null anchor returns empty.

- [ ] **Step 3: Allow the null anchor**

In `EfCoreMessageRepository.GetMessagePageByCursorAsync`, before resolving the anchor:

```csharp
        // A null anchor with a forward direction means the beginning of the channel. There is no
        // message to anchor on before the first one, and a scene channel has no starter message.
        if (query.AnchorMessageId is null)
        {
            if (query.Direction != MessageCursorDirection.After) return empty;

            var oldest = await context.Messages.AsNoTracking()
                .Where(m => m.ContextId == query.ContextId)
                .OrderBy(m => m.CreatedAt).ThenBy(m => m.Id)
                .Take(query.Limit)
                .Include(m => m.Attachments)
                .ToListAsync();

            return (oldest, await FetchReactionsForMessages(oldest));
        }
```

The Scylla twin is a forward read from the partition's first clustering position with the same limit. Keep the ordinal ordering rule at `:128-134`: a client paging one backend and then the other must not see two orders.

The controller maps `oldest=true` onto `AnchorMessageId = null, Direction = After` inside `BuildCursorQuery`, checked before `before`/`after`/`around`.

- [ ] **Step 4: Run again, both providers**

Run: `dotnet test Messaging.Tests/Messaging.Tests.csproj --filter FullyQualifiedName~OldestPage`
Expected: PASS on both the EF Core and Scylla cases.

- [ ] **Step 5: Commit**

```bash
git add Messaging.Application/ Messaging.Infrastructure/ Messaging.Tests/
git commit -m "feat(messaging): serve a channel's oldest page without an anchor"
```

---

## Phase 3: Client wire

### Task 8: DTOs and the taxonomy service

**Files:**

- Modify: `src/app/dtos/response/scene.dto.ts`
- Modify: `src/app/dtos/request/scene.dto.ts`
- Modify: `src/app/services/roleplay-api.service.ts`
- Create: `src/app/services/scene-taxonomy.service.ts`
- Modify: `src/app/services/guild-websocket.service.ts`
- Test: `src/app/services/scene-taxonomy.service.spec.ts`

**Interfaces:**

- Consumes: Task 1's `SceneListParams`, Task 5's response records.
- Produces:

```ts
export interface SceneFolderDto {
  id: string;
  guildId: string;
  name: string;
  position: number;
  parentFolderId?: string | null;
  /** A single emoji. */
  icon?: string | null;
  color?: string | null;
}

export interface SceneTagDto {
  id: string;
  guildId: string;
  name: string;
  /** `#000000` is the server's "no colour chosen" default, not real black. */
  color: string;
  emojiId?: string | null;
  emojiName?: string | null;
  position: number;
  moderated: boolean;
}

export interface SceneTaxonomyDto {
  folders: SceneFolderDto[];
  tags: SceneTagDto[];
}
```

`SceneTaxonomyService` exposes `ensureGuild(guildId)`, `folders(guildId)`, `tags(guildId)`, `tag(guildId, tagId)`, and the CRUD calls, in the shape `scene.service.ts` already uses. It subscribes to `sceneTaxonomyChangedObservable` and replaces the guild's whole set on each event.

`SceneListItemDto` gains `folderId`, `tagIds`, `concludedAt`, `createdAt`. `concludedAt` and `createdAt` move out of the local-only block at the bottom of `SceneDto`, since the server now sends both.

- [ ] **Step 1: Write the failing test**

```ts
it('replaces the whole set when the taxonomy changes', () => {
  service.ensureGuild('gld_1');
  taxonomyChanged.next({guildId: 'gld_1', folders: [], tags: [tagFixture('sctg_2', 'ashfall')]});

  expect(service.tags('gld_1').map(t => t.id)).toEqual(['sctg_2']);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun run ng test --watch=false --include="**/scene-taxonomy.service.spec.ts"`
Expected: FAIL, the service does not exist.

- [ ] **Step 3: Write the DTOs, the API methods and the service**

- [ ] **Step 4: Run again**

Run: `bun run ng test --watch=false --include="**/scene-taxonomy.service.spec.ts"`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
bun run lint
git add src/app/dtos/ src/app/services/
git commit -m "feat(scenes): read archive folders and tags"
```

### Task 9: Lift the tag chip out of forums

**Files:**

- Create: `src/app/components/tag-chip/tag-chip.component.ts`
- Modify: `src/app/features/guild/components/forum-channel/forum-tag-chip.component.ts` (delete after callers move)
- Modify: `forum-post-card.component.ts`, `forum-post-list.component.ts`, `forum-tag-picker.component.ts`, `channel.component.html`
- Test: `src/app/components/tag-chip/tag-chip.component.spec.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `<app-tag-chip [tag]="..." [selected] [interactive] [removable] [size] [emojiUrl] [count]>` where `tag` is structural:

```ts
export interface ChipTag {
  name: string;
  color: string;
  emojiId?: string | null;
  emojiName?: string | null;
}
```

`ForumTag` and `SceneTagDto` both satisfy it. Behaviour is unchanged, including the `#000000` means no colour rule.

This is a move, so characterization first: the existing chip has no spec.

- [ ] **Step 1: Write characterization tests against the current component**

```ts
it('renders a #000000 tag in the neutral style, not black', () => {
  fixture.componentRef.setInput('tag', {name: 'plain', color: '#000000'});
  fixture.detectChanges();
  expect(chip().style.background).toBe('transparent');
});
```

- [ ] **Step 2: Run them green against the old component**

Run: `bun run ng test --watch=false --include="**/tag-chip.component.spec.ts"`
Expected: PASS. If it fails, the move has not started and the test is wrong.

- [ ] **Step 3: Move the component, widen the input to `ChipTag`, update callers**

- [ ] **Step 4: Run the tests plus the forum specs**

Run: `bun run ng test --watch=false --include="**/tag-chip.component.spec.ts" && bun run ng test --watch=false --include="**/forum-*.spec.ts"`
Expected: PASS.

- [ ] **Step 5: Delete the old file and commit**

```bash
bun run lint
git add -A src/app/components/tag-chip src/app/features/guild/components/forum-channel
git commit -m "refactor: share the tag chip between forums and scenes"
```

---

## Phase 4: The archive surface

### Task 10: The mode switch

**Files:**

- Modify: `src/app/features/guild/scenes/scene-board/scene-board.component.{ts,html,css}`
- Create: `src/app/features/guild/scenes/scene-archive/scene-archive.component.{ts,html,css}`
- Test: `src/app/features/guild/scenes/scene-board/scene-board.component.spec.ts`

**Interfaces:**

- Consumes: Task 1, Task 8.
- Produces: `SceneBoardComponent.mode` as a `signal<'playing' | 'archive'>`, and `<app-scene-archive [guildId]>`.

The board keeps its groups untouched. `mode() === 'archive'` renders the archive component instead. The board's grouping computed at `scene-board.component.ts:122` answers "is it my move" and is not asked to also be an archive query.

- [ ] **Step 1: Write the failing test**

```ts
it('drops the concluded group from the playing board', () => {
  // Concluded scenes belong to the archive now, so the board stops carrying an Ended group.
  expect(component.groups().map(g => g.key)).not.toContain('ended');
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun run ng test --watch=false --include="**/scene-board.component.spec.ts"`
Expected: FAIL, `ended` is still a group.

- [ ] **Step 3: Add the switch and move concluded out**

- [ ] **Step 4: Run again**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun run lint
git add src/app/features/guild/scenes/
git commit -m "feat(scenes): switch the board between playing and archive"
```

### Task 11: The folder rail

**Files:**

- Create: `src/app/features/guild/scenes/scene-archive/scene-folder-rail.component.{ts,html,css}`
- Create: `src/app/features/guild/scenes/scene-archive/folder-tree.ts`
- Test: `src/app/features/guild/scenes/scene-archive/folder-tree.spec.ts`

**Interfaces:**

- Consumes: `SceneFolderDto` from Task 8.
- Produces:

```ts
export interface FolderNode {
  folder: SceneFolderDto;
  children: FolderNode[];
  /** Scenes filed directly here plus those in children. */
  count: number;
}

/** Builds the two-level rail. A folder whose parent is missing is treated as a root, so a
 *  half-applied delete never hides a guild's scenes. */
export function folderTree(folders: SceneFolderDto[], countsByFolderId: Record<string, number>): FolderNode[];
```

The rail always shows ALL and Unfiled with counts, folders in `position` order, two levels, and never a scrollbar of its own.

- [ ] **Step 1: Write the failing tests**

```ts
it('rolls a child folder count up into its parent', () => {
  const tree = folderTree([folder('scfd_1', 'Arc I', null, 0), folder('scfd_2', 'Sidequests', 'scfd_1', 0)], {
    scfd_1: 2,
    scfd_2: 3,
  });
  expect(tree[0].count).toBe(5);
});

it('treats an orphan as a root rather than dropping it', () => {
  const tree = folderTree([folder('scfd_9', 'Orphan', 'scfd_gone', 0)], {});
  expect(tree.map(n => n.folder.id)).toEqual(['scfd_9']);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun run ng test --watch=false --include="**/folder-tree.spec.ts"`
Expected: FAIL, `folderTree` is not defined.

- [ ] **Step 3: Write `folderTree` and the rail component**

- [ ] **Step 4: Run again**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun run lint
git add src/app/features/guild/scenes/scene-archive/
git commit -m "feat(scenes): add the archive folder rail"
```

### Task 12: Cards, the tag filter row and paging

**Files:**

- Create: `src/app/features/guild/scenes/scene-archive/scene-archive-card.component.ts`
- Modify: `src/app/features/guild/scenes/scene-archive/scene-archive.component.{ts,html,css}`
- Modify: `src/app/services/scene.service.ts`
- Test: `src/app/features/guild/scenes/scene-archive/scene-archive.component.spec.ts`

**Interfaces:**

- Consumes: Tasks 8, 9, 11.
- Produces: `SceneService.archive(guildId, filters)` holding a cache keyed by filter, separate from `byGuild` so archive paging never disturbs the live board.

The card is quieter than a live board row: no `turn-clock-ring`, the existing `board-ended-mark` glyph, and `sceneTally` for the figures line.

- [ ] **Step 1: Write the failing test**

```ts
it('ANDs the selected tags into one request', () => {
  component.toggleTag('sctg_1');
  component.toggleTag('sctg_2');
  expect(api.listScenes).toHaveBeenLastCalledWith(
    'gld_1',
    expect.objectContaining({tagIds: ['sctg_1', 'sctg_2'], sort: 'ended'}),
  );
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun run ng test --watch=false --include="**/scene-archive.component.spec.ts"`
Expected: FAIL.

- [ ] **Step 3: Build the card, the filter row and the paging**

- [ ] **Step 4: Run again**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun run lint
git add src/app/features/guild/scenes/scene-archive/ src/app/services/scene.service.ts
git commit -m "feat(scenes): list archived scenes by folder and tag"
```

### Task 13: The detail sheet and filing

**Files:**

- Create: `src/app/features/guild/scenes/scene-archive/scene-detail-sheet.component.{ts,html,css}`
- Create: `src/app/features/guild/scenes/scene-archive/scene-taxonomy-editor.component.ts`
- Test: `src/app/features/guild/scenes/scene-archive/scene-detail-sheet.component.spec.ts`

**Interfaces:**

- Consumes: Tasks 8 to 12.
- Produces: `<app-scene-detail-sheet [guildId] [scene] (closed) (filed)>`.

Filing is drag a card onto a folder plus a right-click menu doing the same thing. Drag alone is not reachable from a keyboard, and the message context menu is the pattern to copy. Filing needs `ManageScenes`; applying a tag does not, unless the tag is `moderated`.

- [ ] **Step 1: Write the failing test**

```ts
it('hides filing from a member without ManageScenes', () => {
  fixture.componentRef.setInput('canManage', false);
  fixture.detectChanges();
  expect(query('[data-testid="file-into-folder"]')).toBeNull();
  expect(query('[data-testid="apply-tag"]')).not.toBeNull();
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun run ng test --watch=false --include="**/scene-detail-sheet.component.spec.ts"`
Expected: FAIL.

- [ ] **Step 3: Build the sheet and the editor**

- [ ] **Step 4: Run again**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun run lint
git add src/app/features/guild/scenes/scene-archive/
git commit -m "feat(scenes): open an archived scene's detail sheet"
```

---

## Phase 5: Reading from the start

The app's hottest path. Characterization first, per CLAUDE.md.

### Task 14: Pin the current single-edge paging

**Files:**

- Modify: `src/app/stores/message-store-update.spec.ts`
- Modify: `src/app/features/guild/components/channel/channel-conversation/channel-conversation.component.spec.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: tests that fail if Task 15 changes existing behaviour.

- [ ] **Step 1: Write tests for what the store does today**

Cover: `loadForChannel` seeds `{offset: 0, hasMore: true}`; `loadMoreForChannel` advances `offset` by the page length; `hasMore` goes false on a short page; a realtime append lands at the end of an unanchored window; scrolling above `LOAD_MORE_THRESHOLD` triggers exactly one load.

- [ ] **Step 2: Run them green against the current code**

Run: `bun run ng test --watch=false --include="**/message-store-update.spec.ts"`
Expected: PASS. A failure here means the test is wrong, not the code.

- [ ] **Step 3: Commit**

```bash
git add src/app/stores/ src/app/features/guild/components/channel/
git commit -m "test: pin the current message paging behaviour"
```

### Task 15: A two-edged window

**Files:**

- Modify: `src/app/stores/message.store.ts:574-700`
- Modify: `src/app/services/messaging.service.ts:48`
- Test: `src/app/stores/message-store-anchored.spec.ts`

**Interfaces:**

- Consumes: Task 7's `oldest=true`, Task 14's characterization tests.
- Produces:

```ts
export interface ConversationMeta {
  offset: number;
  hasMore: boolean;
  loadingMore: boolean;
  /** Newer messages exist beyond the window. Only meaningful while anchored. */
  hasNewer?: boolean;
  loadingNewer?: boolean;
  /** Seeded by a cursor rather than by the newest page. */
  anchored?: boolean;
}
```

and `loadChannelOldest(channelId)`, `loadNewerForChannel(channelId)`, `clearAnchor(channelId)`.

- [ ] **Step 1: Write the failing tests**

```ts
it('seeds an anchored window from the oldest page', async () => {
  store.loadChannelOldest('chn_1');
  await flush();
  expect(store.channelMeta()['chn_1']).toMatchObject({anchored: true, hasMore: false, hasNewer: true});
});

it('does not splice a live message into an anchored window', async () => {
  store.loadChannelOldest('chn_1');
  await flush();
  store.upsertFromRealtime(messageFixture('msg_new', 'chn_1'));
  // Stored, but not shown: putting turn 47 after turn 3 is the failure this guards.
  expect(store.messagesForChannel('chn_1').map(m => m.id)).not.toContain('msg_new');
});

it('drops the anchor on jump to present', async () => {
  store.loadChannelOldest('chn_1');
  await flush();
  store.clearAnchor('chn_1');
  expect(store.channelMeta()['chn_1'].anchored).toBe(false);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun run ng test --watch=false --include="**/message-store-anchored.spec.ts"`
Expected: FAIL, `loadChannelOldest` is not a method.

- [ ] **Step 3: Implement the anchored window**

An anchored window must not be seeded from `messageCache.recall`: the cache holds the newest messages, which is the opposite end.

- [ ] **Step 4: Run the anchored tests and Task 14's**

Run: `bun run ng test --watch=false --include="**/message-store-*.spec.ts"`
Expected: PASS, both files.

- [ ] **Step 5: Commit**

```bash
bun run lint
git add src/app/stores/ src/app/services/messaging.service.ts
git commit -m "feat(messages): page a channel forward from its oldest message"
```

### Task 16: Read from the start

**Files:**

- Modify: `src/app/features/guild/components/channel/channel-conversation/channel-conversation.component.ts:640-730`
- Modify: `src/app/features/main-page/navigation.service.ts`
- Modify: `src/app/features/guild/scenes/scene-archive/scene-detail-sheet.component.ts`
- Test: `channel-conversation.component.spec.ts`

**Interfaces:**

- Consumes: Task 15.
- Produces: `NavigationService.openChannelFromStart(channel)`, and the sheet's primary action.

Scroll-down mirrors the existing scroll-up `LOAD_MORE_THRESHOLD` block at `:645`. `jumpToPresent` (`:719`) already exists and becomes the escape hatch: it must drop the anchored window rather than scroll within it. Leaving the channel clears the anchor.

- [ ] **Step 1: Write the failing test**

```ts
it('loads newer messages when scrolled to the bottom of an anchored window', () => {
  setMeta({anchored: true, hasNewer: true, hasMore: false});
  scrollTo(el.scrollHeight - el.clientHeight);
  expect(store.loadNewerForChannel).toHaveBeenCalledWith('chn_1');
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun run ng test --watch=false --include="**/channel-conversation.component.spec.ts"`
Expected: FAIL.

- [ ] **Step 3: Wire the scroll handler, the nav call and the sheet button**

- [ ] **Step 4: Run the full suite**

Run: `bun run test`
Expected: no fewer passing than the baseline recorded before Phase 0.

- [ ] **Step 5: Commit**

```bash
bun run lint
git add src/app/
git commit -m "feat(scenes): read a concluded scene from its first post"
```

---

## Phase 6: Copy

### Task 17: i18n keys

**Files:**

- Modify: `src/assets/i18n/locales/en.json` (submodule, own commit)
- Modify: every component touched in Phases 4 and 5

**Interfaces:**

- Consumes: all prior tasks.
- Produces: the `SCENE.ARCHIVE.*` key set.

Keys: `SCENE.ARCHIVE.TITLE`, `.PLAYING`, `.ARCHIVE`, `.ALL`, `.UNFILED`, `.EMPTY_TITLE`, `.EMPTY_BODY`, `.NEW_FOLDER`, `.RENAME_FOLDER`, `.DELETE_FOLDER`, `.DELETE_FOLDER_CONFIRM`, `.FILE_INTO`, `.TAGS`, `.MANAGE_TAGS`, `.NEW_TAG`, `.MODERATED`, `.CAST_COUNT`, `.RAN_FROM`, `.READ_FROM_START`, `.JUMP_TO_LATEST`, `.CLEAR_FILTERS`, `.SEARCH_PLACEHOLDER`, plus `SCENE.ERROR.FOLDER_DEPTH`, `.FOLDER_CYCLE`, `.TAG_LIMIT`, `.TAG_MODERATED`, `.TAG_NAME_TAKEN`.

Prefer an existing key over adding one. No em dashes in any copy.

- [ ] **Step 1: Add the keys in the submodule and commit there**

```bash
git -C src/assets/i18n/locales add en.json
git -C src/assets/i18n/locales commit -m "feat: add scene archive strings"
git -C src/assets/i18n/locales push
```

- [ ] **Step 2: Bump the submodule pointer and commit**

```bash
git add src/assets/i18n/locales
git commit -m "chore: point locales at the scene archive strings"
```

- [ ] **Step 3: Full suite and build**

Run: `bun run test` then `bun run ng build --configuration development`
Expected: both green.

---

## Self-review notes

- Spec section A is Tasks 2 and 3. A2 is Task 6. A3 is Task 5. A4 is Task 6 step 5. B is Task 7. C is Task 8. D is Tasks 10 to 13, with the chip move split out as Task 9 because it is a refactor of live forum code and deserves its own gate. E is Tasks 14 to 16. F is Task 17. G is spread across each task's test step.
- The spec's `ConcludedAt` requirement needed a task of its own (Task 4); it was implied by the data model section but nothing set the value.
- `folderId` uses the reserved string `unfiled` as a filter value and the empty string as an update sentinel. These are different positions in different DTOs and do not collide.
