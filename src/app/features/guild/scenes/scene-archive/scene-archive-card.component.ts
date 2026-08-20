import {ChangeDetectionStrategy, Component, computed, inject, input, output} from '@angular/core';
import {DatePipe} from '@angular/common';
import {TranslateModule} from '@ngx-translate/core';

import {TagChipComponent} from '../../../../components/tag-chip/tag-chip.component';
import {SceneTaxonomyService} from '../../../../services/scene-taxonomy.service';
import {SceneListItemDto} from '../../../../dtos/response/scene.dto';
import {sceneTally} from '../scene-tally';

/**
 * One finished scene. Quieter than a live board row on purpose: no clock, no character on it, and
 * the figures the scene ended on instead.
 */
@Component({
    selector: 'app-scene-archive-card',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [TranslateModule, TagChipComponent, DatePipe],
    templateUrl: './scene-archive-card.component.html',
    styleUrl: './scene-archive-card.component.css',
    host: {class: 'block'},
})
export class SceneArchiveCardComponent {
    readonly guildId = input.required<string>();
    readonly scene = input.required<SceneListItemDto>();
    readonly draggable = input(false);

    readonly opened = output<SceneListItemDto>();

    private readonly taxonomy = inject(SceneTaxonomyService);

    protected readonly tally = computed(() => sceneTally(this.scene()));

    protected readonly tags = computed(() => this.taxonomy.resolveTags(this.guildId(), this.scene().tagIds));

    protected readonly folderName = computed(
        () => this.taxonomy.folder(this.guildId(), this.scene().folderId)?.name ?? null,
    );

    /** The scene's own span. Falls back to the last update for a scene that ended before the column did. */
    protected readonly ran = computed(() => {
        const scene = this.scene();
        const ended = scene.concludedAt ?? scene.updatedAt;
        const from = scene.createdAt ?? null;
        const to = ended ?? null;
        return {from, to, spansMonths: !!from && !!to && !sameMonth(from, to)};
    });

    protected onDragStart(event: DragEvent): void {
        // A private type rather than text/plain: dropping a scene into a text field should do
        // nothing, and dropping anything else on a shelf should do nothing either.
        event.dataTransfer?.setData('text/scene-channel-id', this.scene().channelId);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    }
}

function sameMonth(a: string, b: string): boolean {
    const from = new Date(a);
    const to = new Date(b);
    return from.getFullYear() === to.getFullYear() && from.getMonth() === to.getMonth();
}
