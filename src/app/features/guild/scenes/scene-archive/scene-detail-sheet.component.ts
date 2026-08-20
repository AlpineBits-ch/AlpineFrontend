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
import {DatePipe} from '@angular/common';
import {TranslateModule, TranslateService} from '@ngx-translate/core';

import {TagChipComponent} from '../../../../components/tag-chip/tag-chip.component';
import {PersonaAvatarComponent} from '../../personas/persona-avatar/persona-avatar.component';
import {SceneTaxonomyService} from '../../../../services/scene-taxonomy.service';
import {SceneService} from '../../../../services/scene.service';
import {RoleplayApi} from '../../../../services/roleplay-api.service';
import {ToastService} from '../../../../services/toast.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {GuildService} from '../../../../services/guild.service';
import {SceneListItemDto} from '../../../../dtos/response/scene.dto';
import {sceneTally} from '../scene-tally';

/**
 * One finished scene, opened beside the archive rather than over it: browsing survives reading a
 * card, which is the whole point of a shelf.
 */
@Component({
    selector: 'app-scene-detail-sheet',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [TranslateModule, DatePipe, TagChipComponent, PersonaAvatarComponent],
    templateUrl: './scene-detail-sheet.component.html',
    styleUrl: './scene-detail-sheet.component.css',
    host: {'(document:keydown.escape)': 'closed.emit()'},
})
export class SceneDetailSheetComponent {
    readonly guildId = input.required<string>();
    readonly scene = input.required<SceneListItemDto>();
    readonly canManage = input(false);

    readonly closed = output<void>();
    readonly filed = output<string | null>();
    readonly tagged = output<string[]>();

    private readonly taxonomy = inject(SceneTaxonomyService);
    private readonly scenes = inject(SceneService);
    private readonly api = inject(RoleplayApi);
    private readonly guilds = inject(GuildService);
    private readonly nav = inject(NavigationService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);

    protected readonly saving = signal(false);
    protected readonly picking = signal(false);

    constructor() {
        effect(() => {
            const scene = this.scene();
            const guildId = this.guildId();
            // Keyed on the id, never on the row object: a row is patched in place, and an identity
            // dependency would re-read on every patch this very sheet causes.
            untracked(() => this.scenes.refreshScene(guildId, scene.channelId));
        });
    }

    /** The full scene once it has been read, which is where the cast with its avatars lives. */
    protected readonly full = computed(() => this.scenes.scene(this.guildId(), this.scene().channelId));

    protected readonly tally = computed(() => sceneTally(this.full() ?? this.scene()));

    protected readonly tags = computed(() =>
        this.taxonomy.resolveTags(this.guildId(), this.full()?.tagIds ?? this.scene().tagIds),
    );

    protected readonly allTags = computed(() => this.taxonomy.tags(this.guildId()));

    protected readonly folder = computed(() =>
        this.taxonomy.folder(this.guildId(), this.full()?.folderId ?? this.scene().folderId),
    );

    protected readonly folders = computed(() => this.taxonomy.folders(this.guildId()));

    protected readonly cast = computed(() => this.full()?.participants ?? []);

    protected readonly ended = computed(
        () => this.full()?.concludedAt ?? this.scene().concludedAt ?? this.scene().updatedAt ?? null,
    );

    protected readonly started = computed(() => this.full()?.createdAt ?? this.scene().createdAt ?? null);

    protected readonly note = computed(() => this.full()?.conclusionNote ?? null);

    protected readonly appliedIds = computed(() => new Set(this.tags().map(t => t.id)));

    /** A member without ManageScenes may apply an ordinary tag but not a moderated one. */
    protected mayApply(tagId: string): boolean {
        if (this.canManage()) return true;
        return !this.taxonomy.tag(this.guildId(), tagId)?.moderated;
    }

    protected toggleTag(tagId: string): void {
        if (!this.mayApply(tagId) || this.saving()) return;

        const held = this.tags().map(t => t.id);
        const next = held.includes(tagId) ? held.filter(id => id !== tagId) : [...held, tagId];

        this.saving.set(true);
        this.api.setSceneTags(this.guildId(), this.scene().channelId, {tagIds: next}).subscribe({
            next: result => {
                this.saving.set(false);
                this.tagged.emit(result.tagIds ?? next);
                this.scenes.refreshScene(this.guildId(), this.scene().channelId);
            },
            error: err => {
                this.saving.set(false);
                this.toast.httpError(this.translate.instant('SCENE.ARCHIVE.TAG_ERROR'), err);
            },
        });
    }

    protected file(folderId: string | null): void {
        this.picking.set(false);
        this.filed.emit(folderId);
    }

    protected open(fromStart: boolean): void {
        const channel = this.guilds
            .guilds()
            .find(g => g.id === this.guildId())
            ?.channels.find(c => c.id === this.scene().channelId);

        if (!channel) return;

        this.closed.emit();
        if (fromStart) this.nav.openChannelFromStart(channel);
        else this.nav.openChannel(channel);
    }
}
