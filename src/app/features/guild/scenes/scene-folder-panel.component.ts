import {ChangeDetectionStrategy, Component, computed, inject, input, output, signal} from '@angular/core';
import {TranslateService} from '@ngx-translate/core';

import {SceneFolderRailComponent} from './scene-folder-rail.component';
import {RailResizeDirective} from '../../../shared/rail-resize.directive';
import {SceneFolderEditorComponent} from './scene-folder-editor.component';
import {FolderNode} from './scene-archive/folder-tree';
import {SceneLeaf} from './scene-leaf';
import {SceneFolderDto} from '../../../dtos/response/scene.dto';
import {SceneRailStateService} from '../../../services/scene-rail-state.service';
import {SceneTaxonomyService} from '../../../services/scene-taxonomy.service';
import {GuildService} from '../../../services/guild.service';
import {ToastService} from '../../../services/toast.service';
import {NavigationService} from '../../main-page/navigation.service';

/** A folder being edited, plus the parent a new one should start on. */
interface FolderEdit {
    folder: SceneFolderDto | null;
    seedParentId: string | null;
}

/**
 * The folder rail's chrome: the resizable aside, expansion state, reordering and the folder
 * editor. Shared by the archive and the board, which draw the tree differently but wrap it the
 * same way.
 */
@Component({
    selector: 'app-scene-folder-panel',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [SceneFolderRailComponent, RailResizeDirective, SceneFolderEditorComponent],
    templateUrl: './scene-folder-panel.component.html',
    styleUrl: './scene-folder-panel.component.css',
    host: {class: 'contents'},
})
export class SceneFolderPanelComponent {
    readonly guildId = input.required<string>();
    readonly canManage = input(false);
    /** The tree to draw. Each host builds its own, because each counts differently. */
    readonly tree = input.required<FolderNode[]>();
    readonly scenesByFolder = input<Readonly<Record<string, readonly SceneLeaf[]>>>({});
    readonly recent = input<readonly SceneLeaf[]>([]);
    readonly loadingFolderIds = input<readonly string[]>([]);
    readonly partialFolderIds = input<readonly string[]>([]);
    /** null is every shelf, `UNFILED` is the no-shelf bucket. */
    readonly selected = input<string | null>(null);
    /** The scene the shell is hosting, marked in the rail so the reader keeps their place. */
    readonly activeChannelId = input<string | null>(null);

    readonly picked = output<string | null>();
    readonly createScene = output<string | null>();
    readonly filed = output<{channelId: string; folderId: string | null}>();

    private readonly railState = inject(SceneRailStateService);
    private readonly taxonomy = inject(SceneTaxonomyService);
    private readonly guilds = inject(GuildService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);
    private readonly nav = inject(NavigationService);

    protected readonly editing = signal<FolderEdit | null>(null);

    protected readonly expandedIds = computed(() => this.railState.expanded(this.guildId()));

    protected toggleShelf(folderId: string): void {
        this.railState.toggle(this.guildId(), folderId);
    }

    protected reorder(folderIds: string[]): void {
        this.taxonomy.reorderFolders(this.guildId(), folderIds).subscribe({
            error: err => this.toast.httpError(this.translate.instant('SCENE.ARCHIVE.REORDER_ERROR'), err),
        });
    }

    protected onOpenScene(channelId: string, fromStart: boolean): void {
        const channel = this.guilds
            .guilds()
            .find(g => g.id === this.guildId())
            ?.channels.find(c => c.id === channelId);
        if (!channel) {
            this.toast.error(this.translate.instant('SCENE.ARCHIVE.OPEN_ERROR'), {
                detail: this.translate.instant('SCENE.ARCHIVE.OPEN_ERROR_DETAIL'),
            });
            return;
        }
        this.nav.openSceneChannel(this.guildId(), channel.id, fromStart);
    }
}
