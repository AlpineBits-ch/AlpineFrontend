import {ChangeDetectionStrategy, Component, input, output} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';

import {FolderNode} from './folder-tree';
import {UNFILED} from '../../../../dtos/request/scene.dto';

/**
 * The archive's shelves. Two levels, ALL and Unfiled always present, and no scrollbar of its own:
 * a rail that scrolls independently stops reading as a rail.
 */
@Component({
    selector: 'app-scene-folder-rail',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [TranslateModule],
    templateUrl: './scene-folder-rail.component.html',
    styleUrl: './scene-folder-rail.component.css',
    host: {class: 'flex shrink-0 flex-col gap-0.5'},
})
export class SceneFolderRailComponent {
    readonly tree = input.required<FolderNode[]>();
    /** null is ALL. `UNFILED` is the bucket for scenes on no shelf. */
    readonly selected = input<string | null>(null);
    readonly totalCount = input(0);
    readonly unfiledCount = input(0);
    readonly canManage = input(false);

    readonly picked = output<string | null>();
    readonly createFolder = output<void>();
    readonly renameFolder = output<FolderNode>();
    readonly deleteFolder = output<FolderNode>();
    /** A scene was dropped onto a shelf: the channel id, and where it should land. */
    readonly filed = output<{channelId: string; folderId: string | null}>();

    protected readonly UNFILED = UNFILED;
    protected dragOver: string | null = null;

    protected onDragOver(event: DragEvent, folderId: string | null): void {
        if (!this.canManage()) return;
        event.preventDefault();
        this.dragOver = folderId ?? UNFILED;
    }

    protected onDragLeave(): void {
        this.dragOver = null;
    }

    protected onDrop(event: DragEvent, folderId: string | null): void {
        this.dragOver = null;
        if (!this.canManage()) return;
        event.preventDefault();

        const channelId = event.dataTransfer?.getData('text/scene-channel-id');
        if (channelId) this.filed.emit({channelId, folderId});
    }
}
