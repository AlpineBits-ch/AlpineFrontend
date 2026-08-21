import {DestroyRef, inject, Injectable, signal} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {Observable, tap} from 'rxjs';

import {RoleplayApi} from './roleplay-api.service';
import {SceneFolderDto, SceneTagDto, SceneTaxonomyDto} from '../dtos/response/scene.dto';
import {RealtimeConnectionService} from './realtime-connection.service';
import {
    CreateSceneFolderDto,
    CreateSceneTagDto,
    UpdateSceneFolderDto,
    UpdateSceneTagDto,
} from '../dtos/request/scene.dto';

const EMPTY_FOLDERS: readonly SceneFolderDto[] = [];
const EMPTY_TAGS: readonly SceneTagDto[] = [];

/**
 * A guild's archive vocabulary. The server hands folders and tags over as one set and replaces the
 * lot on every change, so this holds no deltas and reconciles nothing.
 */
@Injectable({providedIn: 'root'})
export class SceneTaxonomyService {
    private readonly api = inject(RoleplayApi);
    private readonly realtime = inject(RealtimeConnectionService);
    private readonly destroyRef = inject(DestroyRef);

    private readonly byGuild = signal<Record<string, SceneTaxonomyDto>>({});
    private readonly requested = new Set<string>();
    private wired = false;

    folders(guildId: string | null | undefined): readonly SceneFolderDto[] {
        if (!guildId) return EMPTY_FOLDERS;
        return this.byGuild()[guildId]?.folders ?? EMPTY_FOLDERS;
    }

    tags(guildId: string | null | undefined): readonly SceneTagDto[] {
        if (!guildId) return EMPTY_TAGS;
        return this.byGuild()[guildId]?.tags ?? EMPTY_TAGS;
    }

    tag(guildId: string | null | undefined, tagId: string | null | undefined): SceneTagDto | null {
        if (!tagId) return null;
        return this.tags(guildId).find(t => t.id === tagId) ?? null;
    }

    folder(guildId: string | null | undefined, folderId: string | null | undefined): SceneFolderDto | null {
        if (!folderId) return null;
        return this.folders(guildId).find(f => f.id === folderId) ?? null;
    }

    /** Names the tags a scene carries, dropping any the guild has since deleted. */
    resolveTags(
        guildId: string | null | undefined,
        tagIds: readonly string[] | null | undefined,
    ): SceneTagDto[] {
        if (!tagIds?.length) return [];
        const known = this.tags(guildId);
        return tagIds.map(id => known.find(t => t.id === id)).filter((t): t is SceneTagDto => !!t);
    }

    ensureGuild(guildId: string | null | undefined, force = false): void {
        if (!guildId) return;
        this.wire();
        if (this.requested.has(guildId) && !force) return;
        this.requested.add(guildId);

        this.api.getTaxonomy(guildId).subscribe({
            next: taxonomy => this.absorb(guildId, taxonomy),
            // Keeps whatever was loaded: a failed refresh must not empty the rail.
            error: () => undefined,
        });
    }

    // ── Writes ──────────────────────────────────────────────────────────────

    createFolder(guildId: string, dto: CreateSceneFolderDto): Observable<SceneFolderDto> {
        return this.api.createFolder(guildId, dto).pipe(tap(folder => this.upsertFolder(guildId, folder)));
    }

    updateFolder(guildId: string, folderId: string, dto: UpdateSceneFolderDto): Observable<SceneFolderDto> {
        return this.api.updateFolder(folderId, dto).pipe(tap(folder => this.upsertFolder(guildId, folder)));
    }

    deleteFolder(guildId: string, folderId: string): Observable<void> {
        return this.api.deleteFolder(folderId).pipe(tap(() => this.dropFolder(guildId, folderId)));
    }

    reorderFolders(guildId: string, folderIds: string[]): Observable<void> {
        return this.api.reorderFolders(guildId, {folderIds}).pipe(
            tap(() => {
                const held = this.byGuild()[guildId];
                if (!held) return;
                const byId = new Map(held.folders.map(f => [f.id, f]));
                const reordered = folderIds
                    .map((id, index) => {
                        const folder = byId.get(id);
                        return folder ? {...folder, position: index} : null;
                    })
                    .filter((f): f is SceneFolderDto => !!f);
                this.absorb(guildId, {...held, folders: reordered});
            }),
        );
    }

    createTag(guildId: string, dto: CreateSceneTagDto): Observable<SceneTagDto> {
        return this.api.createTag(guildId, dto).pipe(tap(tag => this.upsertTag(guildId, tag)));
    }

    updateTag(guildId: string, tagId: string, dto: UpdateSceneTagDto): Observable<SceneTagDto> {
        return this.api.updateTag(tagId, dto).pipe(tap(tag => this.upsertTag(guildId, tag)));
    }

    deleteTag(guildId: string, tagId: string): Observable<void> {
        return this.api.deleteTag(tagId).pipe(tap(() => this.dropTag(guildId, tagId)));
    }

    // ── Internals ───────────────────────────────────────────────────────────

    private wire(): void {
        if (this.wired) return;
        this.wired = true;

        this.realtime
            .stream('guild.SceneTaxonomyChanged')
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(event => this.absorb(event.guildId, event));
    }

    private absorb(guildId: string, taxonomy: SceneTaxonomyDto): void {
        this.byGuild.update(map => ({
            ...map,
            [guildId]: {
                guildId,
                folders: [...(taxonomy.folders ?? [])].sort(byPosition),
                tags: [...(taxonomy.tags ?? [])].sort(byPosition),
            },
        }));
    }

    private held(guildId: string): SceneTaxonomyDto {
        return this.byGuild()[guildId] ?? {guildId, folders: [], tags: []};
    }

    private upsertFolder(guildId: string, folder: SceneFolderDto): void {
        const held = this.held(guildId);
        this.absorb(guildId, {
            ...held,
            folders: [...held.folders.filter(f => f.id !== folder.id), folder],
        });
    }

    private dropFolder(guildId: string, folderId: string): void {
        const held = this.held(guildId);
        this.absorb(guildId, {
            ...held,
            // Deleting a shelf reparents its children rather than taking them with it, so the local
            // copy has to do the same or the rail loses rows until the next read.
            folders: held.folders
                .filter(f => f.id !== folderId)
                .map(f => (f.parentFolderId === folderId ? {...f, parentFolderId: null} : f)),
        });
    }

    private upsertTag(guildId: string, tag: SceneTagDto): void {
        const held = this.held(guildId);
        this.absorb(guildId, {...held, tags: [...held.tags.filter(t => t.id !== tag.id), tag]});
    }

    private dropTag(guildId: string, tagId: string): void {
        const held = this.held(guildId);
        this.absorb(guildId, {...held, tags: held.tags.filter(t => t.id !== tagId)});
    }
}

function byPosition(a: {position: number; name: string}, b: {position: number; name: string}): number {
    return a.position - b.position || a.name.localeCompare(b.name);
}
