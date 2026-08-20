import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    inject,
    input,
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

import {SceneFolderRailComponent} from './scene-folder-rail.component';
import {SceneArchiveCardComponent} from './scene-archive-card.component';
import {SceneDetailSheetComponent} from './scene-detail-sheet.component';
import {SceneFolderEditorComponent} from './scene-folder-editor.component';
import {SceneTagEditorComponent} from './scene-tag-editor.component';
import {folderTree} from './folder-tree';
import {TagChipComponent} from '../../../../components/tag-chip/tag-chip.component';
import {SceneArchiveService} from '../../../../services/scene-archive.service';
import {SceneTaxonomyService} from '../../../../services/scene-taxonomy.service';
import {SceneService} from '../../../../services/scene.service';
import {ToastService} from '../../../../services/toast.service';
import {SceneFolderDto, SceneListItemDto} from '../../../../dtos/response/scene.dto';
import {SceneSort, UNFILED} from '../../../../dtos/request/scene.dto';

/** Long enough that a typed word is one request, short enough that the results still feel live. */
const SEARCH_DEBOUNCE_MS = 300;
/** Chips in the filter bar before the rest go behind the picker. */
const INLINE_TAGS = 8;

const SORT_LABELS: Record<SceneSort, string> = {
    ended: 'SCENE.ARCHIVE.SORT_ENDED',
    name: 'SCENE.ARCHIVE.SORT_NAME',
    board: 'SCENE.ARCHIVE.SORT_BOARD',
};

/** A folder being edited, plus the parent a new one should start on. */
interface FolderEdit {
    folder: SceneFolderDto | null;
    seedParentId: string | null;
}

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
        SceneFolderRailComponent,
        SceneArchiveCardComponent,
        SceneDetailSheetComponent,
        SceneFolderEditorComponent,
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

    protected readonly archive = inject(SceneArchiveService);
    protected readonly taxonomy = inject(SceneTaxonomyService);
    private readonly scenes = inject(SceneService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);

    protected readonly folderId = signal<string | null>(null);
    protected readonly tagIds = signal<string[]>([]);
    protected readonly query = signal('');
    protected readonly sort = signal<SceneSort>('ended');
    protected readonly tagSearch = signal('');
    protected readonly opened = signal<SceneListItemDto | null>(null);
    protected readonly editing = signal<FolderEdit | null>(null);
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
            untracked(() => this.taxonomy.ensureGuild(guildId));
        });

        effect(() => {
            const filter = {
                guildId: this.guildId(),
                folderId: this.folderId(),
                tagIds: this.tagIds(),
                q: this.settledQuery(),
                sort: this.sort(),
            };
            untracked(() => this.archive.apply(filter));
        });
    }

    protected readonly tree = computed(() => folderTree(this.taxonomy.folders(this.guildId()), {}));

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
        () => this.folderId() !== null || this.tagIds().length > 0 || this.query().trim().length > 0,
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
    }

    protected file(channelId: string, folderId: string | null): void {
        this.scenes.update(this.guildId(), channelId, {folderId}).subscribe({
            next: () => {
                this.archive.patch(channelId, {folderId});
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

    protected reorder(folderIds: string[]): void {
        this.taxonomy.reorderFolders(this.guildId(), folderIds).subscribe({
            error: err => this.toast.httpError(this.translate.instant('SCENE.ARCHIVE.REORDER_ERROR'), err),
        });
    }
}
