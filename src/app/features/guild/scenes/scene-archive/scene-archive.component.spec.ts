import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {Subject} from 'rxjs';
import {beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

import {SceneArchiveComponent} from './scene-archive.component';
import {RoleplayApi} from '../../../../services/roleplay-api.service';
import {SceneTaxonomyService} from '../../../../services/scene-taxonomy.service';
import {SceneService} from '../../../../services/scene.service';
import {GuildService} from '../../../../services/guild.service';
import {ToastService} from '../../../../services/toast.service';
import {SceneRailStateService} from '../../../../services/scene-rail-state.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {
    SceneFolderDto,
    SceneListDto,
    SceneListItemDto,
    SceneStatus,
} from '../../../../dtos/response/scene.dto';
import {SceneListParams} from '../../../../dtos/request/scene.dto';

// jsdom implements no `matchMedia`, and PrimeNG binds a listener to it in `ngOnInit`. Same stub
// `scene-folder-rail.component.spec.ts` uses.
beforeEach(() => {
    if (!window.matchMedia) {
        window.matchMedia = ((query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
            addListener: () => undefined,
            removeListener: () => undefined,
            dispatchEvent: () => false,
        })) as unknown as typeof window.matchMedia;
    }
});

// This runner's `localStorage` global has no methods, so `SceneRailStateService` would silently
// no-op every write. Same Map-backed stand-in `scene-rail-state.service.spec.ts` uses.
const localStore = new Map<string, string>();

beforeAll(() => {
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: (k: string) => localStore.get(k) ?? null,
            setItem: (k: string, v: string) => void localStore.set(k, String(v)),
            removeItem: (k: string) => void localStore.delete(k),
            clear: () => localStore.clear(),
        },
    });
});

beforeEach(() => localStore.clear());

function folder(id: string, parentFolderId: string | null = null, position = 0): SceneFolderDto {
    return {id, guildId: 'g1', name: id.toUpperCase(), position, parentFolderId};
}

/** A page of scenes, `PAGE_SIZE` (50) rows or fewer. A full page leaves the shelf unexhausted. */
function page(count: number): SceneListDto {
    return {
        scenes: Array.from({length: count}, (_, i): SceneListItemDto => ({
            channelId: `ch_${i}`,
            name: `Scene ${i}`,
            status: SceneStatus.Concluded,
        })),
        truncated: false,
    };
}

function setup(folders: SceneFolderDto[]) {
    const responses: Record<string, Subject<SceneListDto>> = {};
    const api = {
        listScenes: (_guildId: string, params?: SceneListParams) => {
            const key = params?.folderId ?? '*';
            const subject = new Subject<SceneListDto>();
            responses[key] = subject;
            return subject;
        },
    };

    TestBed.configureTestingModule({
        imports: [SceneArchiveComponent],
        providers: [
            provideTranslateService(),
            {provide: RoleplayApi, useValue: api},
            {
                provide: SceneTaxonomyService,
                useValue: {folders: () => folders, tags: () => [], ensureGuild: () => undefined},
            },
            {
                provide: SceneService,
                useValue: {
                    ensureGuild: () => undefined,
                    scenes: () => [],
                    speakableIds: () => new Set<string>(),
                },
            },
            {provide: GuildService, useValue: {guilds: () => []}},
            {provide: ToastService, useValue: {error: vi.fn(), httpError: vi.fn()}},
            {provide: NavigationService, useValue: {openChannel: vi.fn(), openChannelFromStart: vi.fn()}},
        ],
    });

    const fixture: ComponentFixture<SceneArchiveComponent> = TestBed.createComponent(SceneArchiveComponent);
    fixture.componentRef.setInput('guildId', 'g1');
    fixture.detectChanges();

    return {fixture, responses};
}

/** Expands a shelf and lets the peek effect fire, so a response subject exists for it. */
function expand(fixture: ComponentFixture<SceneArchiveComponent>, folderId: string): void {
    TestBed.inject(SceneRailStateService).toggle('g1', folderId);
    fixture.detectChanges();
}

function reach(component: SceneArchiveComponent): Record<string, () => unknown> {
    return component as unknown as Record<string, () => unknown>;
}

describe('SceneArchiveComponent shelf counts', () => {
    it('does not mark a childless shelf partial once its own page is exhausted', () => {
        const {fixture, responses} = setup([folder('a')]);
        expand(fixture, 'a');

        responses['a'].next(page(5));
        fixture.detectChanges();

        expect(reach(fixture.componentInstance)['partialFolderIds']()).not.toContain('a');
    });

    it('marks a parent partial while an unexpanded child has never been read', () => {
        const {fixture, responses} = setup([folder('a'), folder('a1', 'a')]);
        expand(fixture, 'a');
        // 'a1' is never expanded, so its own peek never fires and it stays unread.

        responses['a'].next(page(5));
        fixture.detectChanges();

        expect(reach(fixture.componentInstance)['partialFolderIds']()).toContain('a');
    });

    it('marks a childless shelf partial while its own page is still capped', () => {
        const {fixture, responses} = setup([folder('a')]);
        expand(fixture, 'a');

        responses['a'].next(page(50));
        fixture.detectChanges();

        expect(reach(fixture.componentInstance)['partialFolderIds']()).toContain('a');
    });
});
