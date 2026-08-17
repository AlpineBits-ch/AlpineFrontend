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
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Select} from 'primeng/select';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {Dialog} from 'primeng/dialog';
import {Tooltip} from 'primeng/tooltip';
import {PrimeTemplate} from 'primeng/api';
import {ChannelDto} from '../../../../../../dtos/response/guild.dto';
import {
    AutoArchiveDuration,
    FORUM_LIMITS,
    ForumConfig,
    ForumLayout,
    ForumSortOrder,
    ForumTag,
} from '../../../../../../dtos/response/forum.dto';
import {CreateForumTagDto, UpdateForumTagDto} from '../../../../../../dtos/request/forum.dto';
import {ForumService} from '../../../../../../services/forum.service';
import {ForumStateService} from '../../../../../../services/forum-state.service';
import {GuildEmojiStore} from '../../../../../../stores/guild-emoji.store';
import {ToastService} from '../../../../../../services/toast.service';
import {ForumTagChipComponent} from '../../../forum-channel/forum-tag-chip.component';

/** Editor state for one tag: `id` absent means "not saved yet". */
interface TagDraft {
    id?: string;
    name: string;
    emojiName: string;
    emojiId: string;
    color: string;
    moderated: boolean;
}

const DEFAULT_TAG_COLOR = '#5865f2';

@Component({
    selector: 'app-forum-settings',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        FormsModule,
        TranslateModule,
        Button,
        InputText,
        Select,
        ToggleSwitch,
        Dialog,
        Tooltip,
        PrimeTemplate,
        ForumTagChipComponent,
    ],
    templateUrl: './forum-settings.component.html',
})
export class ForumSettingsComponent {
    readonly channel = input.required<ChannelDto>();

    protected readonly maxTags = FORUM_LIMITS.tagsPerForum;
    protected readonly maxNameLength = FORUM_LIMITS.tagNameLength;

    protected readonly savingConfig = signal(false);
    protected readonly savingTag = signal(false);
    protected readonly reordering = signal(false);

    // ── Tag dialog ───────────────────────────────────────────────────────────
    protected readonly showTagDialog = signal(false);
    protected readonly draft = signal<TagDraft>(this.emptyDraft());
    /** The 409 "name already taken" is the one error users hit routinely; inline, not a toast. */
    protected readonly nameTakenError = signal(false);
    protected readonly showDeleteDialog = signal(false);
    protected readonly tagToDelete = signal<ForumTag | null>(null);
    protected readonly deleting = signal(false);

    private readonly dragIndex = signal<number | null>(null);

    private forumService = inject(ForumService);
    private forumState = inject(ForumStateService);
    private emojiStore = inject(GuildEmojiStore);
    private toast = inject(ToastService);
    private translate = inject(TranslateService);

    protected readonly tags = computed(() => this.forumState.tagsFor(this.channel().id));
    protected readonly config = computed(() => this.forumState.configFor(this.channel().id));
    protected readonly atTagCap = computed(() => this.tags().length >= this.maxTags);

    protected readonly guildEmojiOptions = computed(() => [
        {label: this.translate.instant('FORUM_SETTINGS.NO_SERVER_EMOJI'), value: ''},
        ...this.emojiStore.getEmojis(this.channel().guildId).map(e => ({label: `:${e.name}:`, value: e.id})),
    ]);

    protected readonly emojiUrls = computed(() => {
        const map: Record<string, string> = {};
        for (const emoji of this.emojiStore.getEmojis(this.channel().guildId)) map[emoji.id] = emoji.imageUrl;
        return map;
    });

    protected readonly sortOptions = computed(() => [
        {label: this.translate.instant('FORUM.SORT_ACTIVITY'), value: ForumSortOrder.LatestActivity},
        {label: this.translate.instant('FORUM.SORT_CREATED'), value: ForumSortOrder.CreationDate},
    ]);

    protected readonly layoutOptions = computed(() => [
        {label: this.translate.instant('FORUM.LAYOUT_LIST'), value: ForumLayout.List},
        {label: this.translate.instant('FORUM.LAYOUT_GALLERY'), value: ForumLayout.Gallery},
    ]);

    protected readonly archiveOptions = computed(() => [
        {label: this.translate.instant('FORUM_SETTINGS.ARCHIVE_1H'), value: AutoArchiveDuration.OneHour},
        {label: this.translate.instant('FORUM_SETTINGS.ARCHIVE_24H'), value: AutoArchiveDuration.OneDay},
        {label: this.translate.instant('FORUM_SETTINGS.ARCHIVE_3D'), value: AutoArchiveDuration.ThreeDays},
        {label: this.translate.instant('FORUM_SETTINGS.ARCHIVE_1W'), value: AutoArchiveDuration.OneWeek},
    ]);

    constructor() {
        effect(() => {
            const forumId = this.channel().id;
            const guildId = this.channel().guildId;
            untracked(() => {
                this.forumState.loadFor(forumId);
                this.emojiStore.ensureLoaded(guildId);
            });
        });
    }

    // ── Config ───────────────────────────────────────────────────────────────
    /** Config edits save on change rather than behind a Save button: each field is an independent PATCH, so there's no partially-valid intermediate state to protect. */
    protected patchConfig<K extends keyof ForumConfig>(key: K, value: ForumConfig[K]): void {
        const current = this.config();
        if (!current || current[key] === value) return;

        const previous = current;
        this.forumState.putConfig(this.channel().id, {...current, [key]: value});
        this.savingConfig.set(true);

        this.forumService.updateConfig(this.channel().id, {[key]: value}).subscribe({
            next: config => {
                this.forumState.putConfig(this.channel().id, config);
                this.savingConfig.set(false);
            },
            error: err => {
                this.forumState.putConfig(this.channel().id, previous);
                this.savingConfig.set(false);
                this.toast.httpError(this.translate.instant('FORUM_SETTINGS.CONFIG_SAVE_ERROR'), err);
            },
        });
    }

    protected onSlowModeChange(value: string): void {
        const seconds = Math.max(0, Math.min(21_600, Number(value) || 0));
        this.patchConfig('defaultThreadSlowModeSeconds', seconds);
    }

    // ── Tag dialog ───────────────────────────────────────────────────────────
    protected openCreateTag(): void {
        if (this.atTagCap()) return;
        this.draft.set(this.emptyDraft());
        this.nameTakenError.set(false);
        this.showTagDialog.set(true);
    }

    protected openEditTag(tag: ForumTag): void {
        this.draft.set({
            id: tag.id,
            name: tag.name,
            emojiName: tag.emojiName ?? '',
            emojiId: tag.emojiId ?? '',
            color: tag.color && tag.color !== '#000000' ? tag.color : DEFAULT_TAG_COLOR,
            moderated: tag.moderated,
        });
        this.nameTakenError.set(false);
        this.showTagDialog.set(true);
    }

    protected patchDraft(patch: Partial<TagDraft>): void {
        this.draft.update(d => ({...d, ...patch}));
        if (patch.name !== undefined) this.nameTakenError.set(false);
    }

    /** The two emoji fields are mutually exclusive server-side, so setting one clears the other. */
    protected setUnicodeEmoji(value: string): void {
        this.patchDraft({emojiName: value.trim(), emojiId: value.trim() ? '' : this.draft().emojiId});
    }

    protected setGuildEmoji(emojiId: string): void {
        this.patchDraft({emojiId, emojiName: emojiId ? '' : this.draft().emojiName});
    }

    /** A live preview of the draft, so the picker shows what the chip will actually look like. */
    protected readonly draftPreview = computed<ForumTag>(() => {
        const d = this.draft();
        return {
            id: d.id ?? 'preview',
            channelId: this.channel().id,
            guildId: this.channel().guildId,
            name: d.name || this.translate.instant('FORUM_SETTINGS.TAG_NAME_PLACEHOLDER'),
            emojiId: d.emojiId || undefined,
            emojiName: d.emojiName || undefined,
            color: d.color,
            position: 0,
            moderated: d.moderated,
            postCount: 0,
        };
    });

    protected readonly draftPreviewEmojiUrl = computed(() =>
        this.draft().emojiId ? (this.emojiUrls()[this.draft().emojiId] ?? null) : null,
    );

    protected saveTag(): void {
        const d = this.draft();
        const name = d.name.trim();
        if (!name || this.savingTag()) return;
        this.savingTag.set(true);

        const done = (tags: ForumTag[]) => {
            this.forumState.putTags(this.channel().id, tags);
            this.savingTag.set(false);
            this.showTagDialog.set(false);
        };

        const fail = (err: unknown) => {
            this.savingTag.set(false);
            if ((err as {status?: number})?.status === 409) {
                this.nameTakenError.set(true);
                return;
            }
            this.toast.httpError(this.translate.instant('FORUM_SETTINGS.TAG_SAVE_ERROR'), err);
        };

        if (d.id) {
            // Empty string is how this API clears an emoji; null/undefined means "leave unchanged" and the old emoji would survive the edit.
            const dto: UpdateForumTagDto = {
                name,
                color: d.color,
                moderated: d.moderated,
                emojiName: d.emojiName || '',
                emojiId: d.emojiId || '',
            };
            this.forumService.updateTag(d.id, dto).subscribe({
                next: tag => done(this.tags().map(t => (t.id === tag.id ? tag : t))),
                error: fail,
            });
        } else {
            const dto: CreateForumTagDto = {
                name,
                color: d.color,
                moderated: d.moderated,
                ...(d.emojiName ? {emojiName: d.emojiName} : {}),
                ...(d.emojiId ? {emojiId: d.emojiId} : {}),
            };
            this.forumService.createTag(this.channel().id, dto).subscribe({
                next: tag => done([...this.tags(), tag]),
                error: fail,
            });
        }
    }

    // ── Delete ───────────────────────────────────────────────────────────────
    protected askDelete(tag: ForumTag): void {
        this.tagToDelete.set(tag);
        this.showDeleteDialog.set(true);
    }

    protected confirmDelete(): void {
        const tag = this.tagToDelete();
        if (!tag || this.deleting()) return;
        this.deleting.set(true);

        this.forumService.deleteTag(tag.id).subscribe({
            next: () => {
                this.forumState.putTags(
                    this.channel().id,
                    this.tags().filter(t => t.id !== tag.id),
                );
                this.deleting.set(false);
                this.showDeleteDialog.set(false);
            },
            error: err => {
                this.deleting.set(false);
                this.toast.httpError(this.translate.instant('FORUM_SETTINGS.TAG_DELETE_ERROR'), err);
            },
        });
    }

    // ── Reorder ──────────────────────────────────────────────────────────────
    protected onDragStart(index: number): void {
        this.dragIndex.set(index);
    }

    protected onDragOver(event: DragEvent): void {
        event.preventDefault();
    }

    protected onDrop(index: number): void {
        const from = this.dragIndex();
        this.dragIndex.set(null);
        if (from === null) return;
        this.moveTag(from, index);
    }

    /** Keyboard path to reordering; drag-and-drop alone left this unusable without a mouse. */
    protected moveTagBy(index: number, delta: number): void {
        this.moveTag(index, index + delta);
    }

    private moveTag(from: number, to: number): void {
        const list = this.tags();
        if (from === to || to < 0 || to >= list.length || this.reordering()) return;

        const next = [...list];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);

        // Positions are re-derived from the array index, matching how the server assigns them, so the local list stays consistent with what the reorder call will produce.
        const repositioned = next.map((t, position) => ({...t, position}));
        this.forumState.putTags(this.channel().id, repositioned);
        this.reordering.set(true);

        this.forumService.reorderTags(this.channel().id, {tagIds: repositioned.map(t => t.id)}).subscribe({
            next: () => this.reordering.set(false),
            error: err => {
                this.forumState.putTags(this.channel().id, list);
                this.reordering.set(false);
                this.toast.httpError(this.translate.instant('FORUM_SETTINGS.REORDER_ERROR'), err);
            },
        });
    }

    protected emojiUrlFor(tag: ForumTag): string | null {
        return tag.emojiId ? (this.emojiUrls()[tag.emojiId] ?? null) : null;
    }

    private emptyDraft(): TagDraft {
        return {name: '', emojiName: '', emojiId: '', color: DEFAULT_TAG_COLOR, moderated: false};
    }
}
