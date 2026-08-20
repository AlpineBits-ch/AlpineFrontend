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
import {FormsModule} from '@angular/forms';
import {TranslateModule, TranslateService} from '@ngx-translate/core';

import {SceneFolderRailComponent} from './scene-folder-rail.component';
import {SceneArchiveCardComponent} from './scene-archive-card.component';
import {SceneDetailSheetComponent} from './scene-detail-sheet.component';
import {SceneFolderEditorComponent} from './scene-folder-editor.component';
import {SceneTagEditorComponent} from './scene-tag-editor.component';
import {countByFolder, folderTree} from './folder-tree';
import {TagChipComponent} from '../../../../components/tag-chip/tag-chip.component';
import {SceneArchiveService} from '../../../../services/scene-archive.service';
import {SceneTaxonomyService} from '../../../../services/scene-taxonomy.service';
import {SceneService} from '../../../../services/scene.service';
import {ToastService} from '../../../../services/toast.service';
import {SceneFolderDto, SceneListItemDto} from '../../../../dtos/response/scene.dto';
import {UNFILED} from '../../../../dtos/request/scene.dto';

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
        SceneFolderRailComponent,
        SceneArchiveCardComponent,
        SceneDetailSheetComponent,
        SceneFolderEditorComponent,
        SceneTagEditorComponent,
        TagChipComponent,
    ],
    templateUrl: './scene-archive.component.html',
    styleUrl: './scene-archive.component.css',
    host: {class: 'flex min-h-0 flex-1 flex-col'},
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
    protected readonly opened = signal<SceneListItemDto | null>(null);
    /** A folder being edited, or `new` for one being created. */
    protected readonly editing = signal<SceneFolderDto | 'new' | null>(null);
    protected readonly managingTags = signal(false);

    protected readonly UNFILED = UNFILED;

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
                q: this.query().trim(),
            };
            untracked(() => this.archive.apply(filter));
        });
    }

    /**
     * Counts come from the rows the current filter returned, so a shelf's number is what picking it
     * would show. On the unfiltered view that is the whole archive.
     */
    protected readonly tree = computed(() =>
        folderTree(this.taxonomy.folders(this.guildId()), countByFolder(this.archive.scenes())),
    );

    protected readonly unfiledCount = computed(
        () => this.archive.scenes().filter(scene => !scene.folderId).length,
    );

    protected readonly tags = computed(() => this.taxonomy.tags(this.guildId()));

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
}
