import {
    afterNextRender,
    ChangeDetectionStrategy,
    Component,
    computed,
    DestroyRef,
    effect,
    ElementRef,
    inject,
    input,
    output,
    signal,
    untracked,
    viewChild,
} from '@angular/core';
import {DatePipe} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {TranslateModule, TranslateService} from '@ngx-translate/core';

import {TagChipComponent} from '../../../../components/tag-chip/tag-chip.component';
import {PersonaAvatarComponent} from '../../personas/persona-avatar/persona-avatar.component';
import {SceneFolderPickerComponent} from './scene-folder-picker.component';
import {SceneTaxonomyService} from '../../../../services/scene-taxonomy.service';
import {SceneService} from '../../../../services/scene.service';
import {RoleplayApi} from '../../../../services/roleplay-api.service';
import {ToastService} from '../../../../services/toast.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {GuildService} from '../../../../services/guild.service';
import {SceneListItemDto} from '../../../../dtos/response/scene.dto';
import {sceneTally} from '../scene-tally';

/** How many tags the sheet shows before it asks to be opened up. */
const TAG_PREVIEW = 8;

let nextTitleId = 0;

/**
 * One finished scene, opened beside the archive rather than over it: browsing survives reading a
 * card, which is the whole point of a shelf.
 */
@Component({
    selector: 'app-scene-detail-sheet',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        TranslateModule,
        DatePipe,
        FormsModule,
        TagChipComponent,
        PersonaAvatarComponent,
        SceneFolderPickerComponent,
    ],
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
    private readonly destroyRef = inject(DestroyRef);

    private readonly panel = viewChild.required<ElementRef<HTMLElement>>('panel');

    protected readonly saving = signal(false);
    protected readonly picking = signal(false);
    protected readonly tagsOpen = signal(false);

    protected readonly titleId = `scene-sheet-title-${nextTitleId++}`;

    constructor() {
        effect(() => {
            const scene = this.scene();
            const guildId = this.guildId();
            // Keyed on the id, never on the row object: a row is patched in place, and an identity
            // dependency would re-read on every patch this very sheet causes.
            untracked(() => this.scenes.refreshScene(guildId, scene.channelId));
        });

        // Non-modal, so no focus trap: move focus in on open, hand it back to the card on close.
        const opener = document.activeElement as HTMLElement | null;
        afterNextRender(() => this.panel().nativeElement.focus());
        this.destroyRef.onDestroy(() => {
            if (opener?.isConnected) opener.focus();
        });
    }

    /** Escape inside the sheet closes the picker first, and never reaches the archive behind. */
    protected onEscape(event: Event): void {
        event.stopPropagation();
        if (this.picking()) {
            this.picking.set(false);
            return;
        }
        this.closed.emit();
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

    protected readonly cast = computed(() => this.full()?.participants ?? []);

    protected readonly ended = computed(
        () => this.full()?.concludedAt ?? this.scene().concludedAt ?? this.scene().updatedAt ?? null,
    );

    protected readonly started = computed(() => this.full()?.createdAt ?? this.scene().createdAt ?? null);

    protected readonly note = computed(() => this.full()?.conclusionNote ?? null);

    protected readonly appliedIds = computed(() => new Set(this.tags().map(t => t.id)));

    /** Applied first: a guild may hold 40 tags and the sheet is 23rem wide. */
    private readonly orderedTags = computed(() => {
        const applied = this.appliedIds();
        const all = this.allTags();
        return [...all.filter(t => applied.has(t.id)), ...all.filter(t => !applied.has(t.id))];
    });

    protected readonly shownTags = computed(() => {
        const ordered = this.orderedTags();
        if (this.tagsOpen()) return ordered;
        return ordered.slice(0, Math.max(TAG_PREVIEW, this.appliedIds().size));
    });

    protected readonly hiddenTagCount = computed(() => this.orderedTags().length - this.shownTags().length);

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

    protected togglePicking(): void {
        this.picking.set(!this.picking());
    }

    protected open(fromStart: boolean): void {
        const channel = this.guilds
            .guilds()
            .find(g => g.id === this.guildId())
            ?.channels.find(c => c.id === this.scene().channelId);

        if (!channel) {
            this.toast.error(this.translate.instant('SCENE.ARCHIVE.OPEN_ERROR'), {
                detail: this.translate.instant('SCENE.ARCHIVE.OPEN_ERROR_DETAIL'),
            });
            return;
        }

        this.closed.emit();
        this.nav.openSceneChannel(this.guildId(), channel.id, fromStart);
    }
}
