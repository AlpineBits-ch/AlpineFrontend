import {ChangeDetectionStrategy, Component, computed, inject, input} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';

import {SceneService} from '../../../services/scene.service';
import {SceneTaxonomyService} from '../../../services/scene-taxonomy.service';
import {NavigationService} from '../../main-page/navigation.service';
import {ChannelDto} from '../../../dtos/response/guild.dto';
import {SceneFolderDto} from '../../../dtos/response/scene.dto';

/** Where the scene in the shell's content pane sits, every segment above it a way back out. */
@Component({
    selector: 'app-scene-breadcrumb',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [TranslateModule],
    templateUrl: './scene-breadcrumb.component.html',
    styleUrl: './scene-breadcrumb.component.css',
    host: {class: 'flex min-w-0 items-center'},
})
export class SceneBreadcrumbComponent {
    readonly guildId = input.required<string>();
    readonly channel = input.required<ChannelDto>();

    private readonly scenes = inject(SceneService);
    private readonly taxonomy = inject(SceneTaxonomyService);
    private readonly nav = inject(NavigationService);

    /** The board row where there is one, the loaded scene otherwise: the archive's rows are not here. */
    private readonly scene = computed(() => {
        const channelId = this.channel().id;
        const row = this.scenes.scenes(this.guildId()).find(s => s.channelId === channelId);
        return row ?? this.scenes.scene(this.guildId(), channelId);
    });

    protected readonly name = computed(() => this.scene()?.name ?? this.channel().name);

    /** Root first. A shelf the guild has since deleted ends the walk rather than leaving a hole. */
    protected readonly folders = computed((): SceneFolderDto[] => {
        const guildId = this.guildId();
        const trail: SceneFolderDto[] = [];
        const seen = new Set<string>();
        let folderId = this.scene()?.folderId ?? null;
        while (folderId && !seen.has(folderId)) {
            seen.add(folderId);
            const folder = this.taxonomy.folder(guildId, folderId);
            if (!folder) break;
            trail.unshift(folder);
            folderId = folder.parentFolderId ?? null;
        }
        return trail;
    });

    protected toScenes(): void {
        this.nav.closeSceneChannel(this.guildId());
    }

    protected toFolder(folderId: string): void {
        this.nav.openSceneFolder(this.guildId(), folderId, 'archive');
    }
}
