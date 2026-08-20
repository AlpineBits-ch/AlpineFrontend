import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    inject,
    input,
    output,
    signal,
    untracked,
} from '@angular/core';
import {toObservable, toSignal} from '@angular/core/rxjs-interop';
import {FormsModule} from '@angular/forms';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {Menu} from 'primeng/menu';
import {Popover} from 'primeng/popover';
import {MenuItem} from 'primeng/api';
import {debounceTime, distinctUntilChanged, map} from 'rxjs';

import {SceneFolderPanelComponent} from '../scene-folder-panel.component';
import {SceneArchiveCardComponent} from './scene-archive-card.component';
import {SceneDetailSheetComponent} from './scene-detail-sheet.component';
import {SceneTagEditorComponent} from './scene-tag-editor.component';
import {FolderNode, folderTree} from './folder-tree';
import {TagChipComponent} from '../../../../components/tag-chip/tag-chip.component';
import {ArchiveStatus, SceneArchiveService} from '../../../../services/scene-archive.service';
import {SceneRailStateService} from '../../../../services/scene-rail-state.service';
import {SceneTaxonomyService} from '../../../../services/scene-taxonomy.service';
import {SceneService} from '../../../../services/scene.service';
import {ToastService} from '../../../../services/toast.service';
import {SceneListItemDto} from '../../../../dtos/response/scene.dto';
import {SceneSort, UNFILED} from '../../../../dtos/request/scene.dto';
import {leavesByFolder, recentScenes, SceneLeaf} from '../scene-leaf';

/** Long enough that a typed word is one request, short enough that the results still feel live. */
const SEARCH_DEBOUNCE_MS = 300;
/** Chips in the filter bar before the rest go behind the picker. */
const INLINE_TAGS = 8;

const SORT_LABELS: Record<SceneSort, string> = {
    ended: 'SCENE.ARCHIVE.SORT_ENDED',
    name: 'SCENE.ARCHIVE.SORT_NAME',
    board: 'SCENE.ARCHIVE.SORT_BOARD',
};

const STATUS_LABELS: Record<ArchiveStatus, string> = {
    all: 'SCENE.ARCHIVE.STATUS_ALL',
    running: 'SCENE.ARCHIVE.STATUS_RUNNING',
    finished: 'SCENE.ARCHIVE.STATUS_FINISHED',
};

/**
 * The archive: shelves down the left, labels across the top, finished scenes in the middle. A
 * sibling of the board rather than a mode inside it, so the board's "is it my move" grouping is
 * never asked to also answer an archive query.
 */
@Component({
    selector: 'app-scene-archive',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        TranslateModule,
        FormsModule,
        Menu,
        Popover,
        SceneFolderPanelComponent,
        SceneArchiveCardComponent,
        SceneDetailSheetComponent,
        SceneTagEditorComponent,
        TagChipComponent,
    ],
    templateUrl: './scene-archive.component.html',
    styleUrl: './scene-archive.component.css',
    // `relative` is load-bearing: the detail sheet is absolutely positioned and would otherwise
    // resolve against the page and cover the whole app.
    host: {class: 'relative flex min-h-0 flex-1 flex-col'},
})
export class SceneArchiveComponent {
    readonly guildId = input.required<string>();
    readonly canManage = input(false);

    /** The folder a new scene should open in, for the board to act on: the dialog lives there. */
    readonly createSceneIn = output<string | null>();

    protected readonly archive = inject(SceneArchiveService);
    protected readonly taxonomy = inject(SceneTaxonomyService);
    private readonly scenes = inject(SceneService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);
    private readonly railState = inject(SceneRailStateService);

    protected readonly status = signal<ArchiveStatus>('all');

    protected readonly folderId = signal<string | null>(null);
    protected readonly tagIds = signal<string[]>([]);
    protected readonly query = signal('');
    protected readonly sort = signal<SceneSort>('ended');
    protected readonly tagSearch = signal('');
    protected readonly opened = signal<SceneListItemDto | null>(null);
    protected readonly managingTags = signal(false);

    protected readonly UNFILED = UNFILED;

    /** Every keystroke is a cache key and a request, so the query lands late and the clicks land now. */
    private readonly settledQuery = toSignal(
        toObservable(this.query).pipe(
            debounceTime(SEARCH_DEBOUNCE_MS),
            map(text => text.trim()),
            distinctUntilChanged(),
        ),
        {initialValue: ''},
    );

    constructor() {
        effect(() => {
            const guildId = this.guildId();
            untracked(() => {
                this.taxonomy.ensureGuild(guildId);
                this.scenes.ensureGuild(guildId);
            });
        });

        effect(() => {
            const filter = {
                guildId: this.guildId(),
                folderId: this.folderId(),
                tagIds: this.tagIds(),
                q: this.settledQuery(),
                sort: this.sort(),
                status: this.status(),
            };
            untracked(() => this.archive.apply(filter));
        });

        // Every open shelf reads its own page. The service dedupes, so reopening one is free.
        effect(() => {
            const guildId = this.guildId();
            const status = this.status();
            const open = this.railState.expanded(guildId);
            untracked(() => {
                for (const folderId of open) this.archive.peek(guildId, folderId, status);
            });
        });
    }

    protected readonly tree = computed(() =>
        folderTree(this.taxonomy.folders(this.guildId()), this.folderCounts()),
    );

    /** Only shelves the archive has read. An unopened folder contributes nothing rather than a guess. */
    protected readonly folderCounts = computed(() => {
        const guildId = this.guildId();
        const status = this.status();
        const counts: Record<string, number> = {};
        for (const folderId of this.railState.expanded(guildId)) {
            counts[folderId] = this.archive.peeked(guildId, folderId, status).length;
        }
        return counts;
    });

    /** A shelf's total is a floor while its own page is capped, or while anything below it is unread. */
    protected readonly partialFolderIds = computed(() => {
        const guildId = this.guildId();
        const status = this.status();
        const open = new Set(this.railState.expanded(guildId));
        const read = (id: string) => open.has(id) && this.archive.peekExhausted(guildId, id, status);

        const partial = new Set<string>();
        const walk = (node: FolderNode): boolean => {
            let unknown = !read(node.folder.id);
            for (const child of node.children) unknown = walk(child) || unknown;
            if (unknown) partial.add(node.folder.id);
            return unknown;
        };
        for (const root of this.tree()) walk(root);

        return [...partial];
    });

    protected readonly loadingFolderIds = computed(() =>
        this.railState
            .expanded(this.guildId())
            .filter(id => this.archive.peekLoading(this.guildId(), id, this.status())),
    );

    protected readonly scenesByFolder = computed((): Record<string, SceneLeaf[]> => {
        const guildId = this.guildId();
        const status = this.status();
        const speakable = this.scenes.speakableIds(guildId);
        const grouped: Record<string, SceneLeaf[]> = {};
        for (const folderId of this.railState.expanded(guildId)) {
            grouped[folderId] =
                leavesByFolder(this.archive.peeked(guildId, folderId, status), speakable)[folderId] ?? [];
        }
        return grouped;
    });

    protected readonly recent = computed(() =>
        recentScenes(this.scenes.scenes(this.guildId()), this.scenes.speakableIds(this.guildId())),
    );

    protected readonly tags = computed(() => this.taxonomy.tags(this.guildId()));

    /** Selected tags always show; the rest fill what is left of the row. */
    protected readonly inlineTags = computed(() => {
        const selected = new Set(this.tagIds());
        const all = this.tags();
        const chosen = all.filter(tag => selected.has(tag.id));
        if (chosen.length >= INLINE_TAGS) return chosen;
        return [...chosen, ...all.filter(tag => !selected.has(tag.id)).slice(0, INLINE_TAGS - chosen.length)];
    });

    protected readonly hiddenTagCount = computed(() => this.tags().length - this.inlineTags().length);

    protected readonly tagMatches = computed(() => {
        const needle = this.tagSearch().trim().toLowerCase();
        const all = this.tags();
        return needle ? all.filter(tag => tag.name.toLowerCase().includes(needle)) : all;
    });

    protected readonly sortLabel = computed(() => SORT_LABELS[this.sort()]);

    protected readonly sortItems = computed<MenuItem[]>(() =>
        (Object.keys(SORT_LABELS) as SceneSort[]).map(value => ({
            label: this.translate.instant(SORT_LABELS[value]),
            icon: this.sort() === value ? 'pi pi-check' : 'pi pi-fw',
            command: () => this.sort.set(value),
        })),
    );

    protected readonly hasFilters = computed(
        () =>
            this.folderId() !== null ||
            this.tagIds().length > 0 ||
            this.query().trim().length > 0 ||
            this.status() !== 'all',
    );

    protected readonly isEmpty = computed(
        () => !this.archive.loading() && this.archive.scenes().length === 0,
    );

    protected toggleTag(tagId: string): void {
        this.tagIds.update(held =>
            held.includes(tagId) ? held.filter(id => id !== tagId) : [...held, tagId],
        );
    }

    protected clearFilters(): void {
        this.folderId.set(null);
        this.tagIds.set([]);
        this.query.set('');
        this.status.set('all');
    }

    protected file(channelId: string, folderId: string | null): void {
        const oldFolderId = this.archive.cachedRow(channelId)?.folderId ?? null;
        this.scenes.update(this.guildId(), channelId, {folderId}).subscribe({
            next: () => {
                this.archive.patch(channelId, {folderId});
                this.archive.invalidateShelves(this.guildId(), oldFolderId, folderId);
                // A row filed elsewhere no longer belongs to the shelf being shown.
                if (this.folderId() && this.folderId() !== folderId) this.archive.drop(channelId);
            },
            error: err => this.toast.httpError(this.translate.instant('SCENE.ARCHIVE.FILE_ERROR'), err),
        });
    }

    protected tagged(channelId: string, tagIds: string[]): void {
        this.archive.patch(channelId, {tagIds});
        // The filter is ANDed, so losing any one of its tags takes the row out of this list.
        const filtering = this.tagIds();
        if (filtering.length && !filtering.every(id => tagIds.includes(id))) this.archive.drop(channelId);
    }

    protected readonly statusItems = computed<MenuItem[]>(() =>
        (['all', 'running', 'finished'] as ArchiveStatus[]).map(value => ({
            label: this.translate.instant(STATUS_LABELS[value]),
            icon: this.status() === value ? 'pi pi-check' : 'pi pi-fw',
            command: () => this.status.set(value),
        })),
    );

    protected readonly statusLabel = computed(() => STATUS_LABELS[this.status()]);
}
