import {Component, computed, ElementRef, inject, input, OnDestroy, OnInit, signal, ViewChild} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Dialog} from 'primeng/dialog';
import {Tooltip} from 'primeng/tooltip';
import {PrimeTemplate} from 'primeng/api';
import {GuildDto} from '../../../../../../dtos/response/guild.dto';
import {SelfGuildMemberDto} from '../../../../../../dtos/response/member.dto';
import {GuildEmojiDto} from '../../../../../../dtos/response/guild-emoji.dto';
import {GuildService} from '../../../../../../services/guild.service';
import {GuildEmojiService} from '../../../../../../services/guild-emoji.service';
import {GuildEmojiStore} from '../../../../../../stores/guild-emoji.store';
import {ToastService} from '../../../../../../services/toast.service';
import {hasPermission, Permissions} from '../../../../../../enums/permissions.enum';
import {unionMemberPermissions} from '../../../../guild-permissions';
import {TranslateModule, TranslateService} from '@ngx-translate/core';

/** Server-side naming rule, mirrored so the field can say so before the request. */
const EMOJI_NAME_PATTERN = /^[a-zA-Z0-9_]+$/;

/** Kept in step with the file input's `accept`, because a drop bypasses `accept` entirely. */
const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** An APNG's `acTL` and an animated WebP's `ANIM` both live in the header chunks, never this deep. */
const HEADER_SNIFF_BYTES = 65536;

type QueuedStatus = 'pending' | 'uploading' | 'done' | 'error';

/** One file in the upload queue. `key` is a local identity, since two files can share a name. */
interface QueuedEmoji {
    key: number;
    file: File;
    previewUrl: string;
    name: string;
    /** Derived from the file's own bytes, never from the user, so it cannot disagree with it. */
    animated: boolean;
    status: QueuedStatus;
    /** Translation key for the per-file failure, so one bad file does not sink the batch. */
    errorKey: string | null;
}

@Component({
    selector: 'app-emoji-settings',
    imports: [FormsModule, Button, InputText, Dialog, Tooltip, PrimeTemplate, TranslateModule],
    templateUrl: './emoji-settings.component.html',
})
export class EmojiSettingsComponent implements OnInit, OnDestroy {
    readonly guild = input.required<GuildDto>();

    readonly emojis = computed(() => this.guildEmojiStore.getEmojis(this.guild().id));
    readonly loading = signal(true);
    readonly deletingId = signal<string | null>(null);
    readonly filter = signal('');

    readonly showUploadDialog = signal(false);
    /** The whole batch, in the order it was picked. Uploaded strictly in sequence. */
    readonly queue = signal<QueuedEmoji[]>([]);
    readonly uploading = signal(false);
    readonly isDraggingOver = signal(false);
    readonly confirmDeleteEmoji = signal<GuildEmojiDto | null>(null);
    readonly showDeleteDialog = signal(false);

    readonly filteredEmojis = computed(() => {
        const q = this.filter().trim().toLowerCase();
        const all = this.emojis();
        return q ? all.filter(e => e.name.toLowerCase().includes(q)) : all;
    });

    /** Per-file blocking problem, keyed by {@link QueuedEmoji.key}. Comparison is exact, not case-insensitive: the server decides, and flagging a name it would accept would block a legitimate upload with no way around it. */
    protected readonly rowIssues = computed<Map<number, string>>(() => {
        const taken = new Set(this.emojis().map(e => e.name));
        const seen = new Set<string>();
        const issues = new Map<number, string>();

        for (const row of this.queue()) {
            // A finished row is already an emoji; it is `taken` now and must not flag itself.
            if (row.status === 'done') continue;
            const name = row.name.trim();
            if (!name) issues.set(row.key, 'GUILD_SETTINGS.EMOJIS.NAME_REQUIRED');
            else if (!EMOJI_NAME_PATTERN.test(name)) issues.set(row.key, 'GUILD_SETTINGS.EMOJIS.NAME_INVALID');
            else if (taken.has(name)) issues.set(row.key, 'GUILD_SETTINGS.EMOJIS.NAME_TAKEN');
            else if (seen.has(name)) issues.set(row.key, 'GUILD_SETTINGS.EMOJIS.NAME_DUPLICATE');
            seen.add(name);
        }
        return issues;
    });

    protected readonly hasBlockingIssue = computed(() => this.rowIssues().size > 0);
    protected readonly remainingCount = computed(() => this.queue().filter(r => r.status !== 'done').length);
    protected readonly uploadedCount = computed(() => this.queue().filter(r => r.status === 'done').length);
    protected readonly failedCount = computed(() => this.queue().filter(r => r.status === 'error').length);

    @ViewChild('fileInput') private fileInputRef?: ElementRef<HTMLInputElement>;

    private guildService = inject(GuildService);
    private guildEmojiService = inject(GuildEmojiService);
    private guildEmojiStore = inject(GuildEmojiStore);
    private toastService = inject(ToastService);
    private translate = inject(TranslateService);
    private readonly ownMember = signal<SelfGuildMemberDto | null>(null);
    private nextKey = 0;
    /** dragenter/dragleave fire per child element, so the overlay is refcounted, not toggled. */
    private dragCounter = 0;

    /** Separate from `canManageEmojis` so the page stays quiet while the member row is in flight; otherwise the "no permission" note flashes for people who do have it. */
    protected readonly permissionsLoaded = signal(false);

    readonly canManageEmojis = computed(() => {
        const member = this.ownMember();
        if (!member) return false;
        const perms = unionMemberPermissions(member);
        return hasPermission(perms, Permissions.Superadmin) || hasPermission(perms, Permissions.ManageEmojis);
    });

    ngOnInit(): void {
        this.guildService.getOwnMember(this.guild().id).subscribe({
            next: m => {
                this.ownMember.set(m);
                this.permissionsLoaded.set(true);
            },
            error: () => this.permissionsLoaded.set(true),
        });
        this.loading.set(true);
        this.guildEmojiStore.ensureLoaded(this.guild().id);
        this.guildEmojiService.getEmojis(this.guild().id).subscribe({
            next: () => this.loading.set(false),
            error: () => this.loading.set(false),
        });
    }

    ngOnDestroy(): void {
        this.revokeQueue();
    }

    openFilePicker(): void {
        this.fileInputRef?.nativeElement.click();
    }

    onFileSelected(event: Event): void {
        const input = event.target as HTMLInputElement;
        const files = Array.from(input.files ?? []);
        input.value = '';
        this.enqueue(files);
    }

    onDragEnter(event: DragEvent): void {
        if (!this.canManageEmojis()) return;
        event.preventDefault();
        this.dragCounter++;
        this.isDraggingOver.set(true);
    }

    onDragOver(event: DragEvent): void {
        if (!this.canManageEmojis()) return;
        event.preventDefault();
    }

    onDragLeave(): void {
        if (--this.dragCounter <= 0) {
            this.dragCounter = 0;
            this.isDraggingOver.set(false);
        }
    }

    onDrop(event: DragEvent): void {
        if (!this.canManageEmojis()) return;
        event.preventDefault();
        this.dragCounter = 0;
        this.isDraggingOver.set(false);
        this.enqueue(Array.from(event.dataTransfer?.files ?? []));
    }

    /** Adds files to the batch and opens the dialog once for all of them; names are pre-filled from filenames and stay editable for ones the sanitiser had to mangle. */
    private enqueue(files: File[]): void {
        if (files.length === 0) return;
        const accepted = files.filter(f => ACCEPTED_TYPES.includes(f.type));
        if (accepted.length < files.length) {
            this.toastService.error(this.translate.instant('GUILD_SETTINGS.EMOJIS.UNSUPPORTED_SKIPPED'));
        }
        if (accepted.length === 0) return;

        const rows: QueuedEmoji[] = accepted.map(file => ({
            key: this.nextKey++,
            file,
            previewUrl: URL.createObjectURL(file),
            name: file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 32),
            animated: file.type === 'image/gif',
            status: 'pending',
            errorKey: null,
        }));
        this.queue.update(prev => [...prev, ...rows]);
        this.showUploadDialog.set(true);

        // The sniff has to read bytes, so it lands a tick later; the GIF guess above is already right for the common case, this only corrects an APNG or an animated WebP.
        for (const row of rows) {
            void this.detectAnimated(row.file).then(animated => {
                if (animated !== row.animated) this.patchRow(row.key, {animated});
            });
        }
    }

    /** Reads the animated flag out of the file itself; MIME type alone can't answer it, since an animated WebP or APNG carries the same type as its still form, so the container bytes are what get asked. */
    private async detectAnimated(file: File): Promise<boolean> {
        if (file.type === 'image/gif') return true;
        const marker = file.type === 'image/webp' ? 'ANIM' : file.type === 'image/png' ? 'acTL' : null;
        if (!marker) return false;
        try {
            const head = new Uint8Array(await file.slice(0, HEADER_SNIFF_BYTES).arrayBuffer());
            return containsMarker(head, marker);
        } catch {
            // An unreadable file will fail the upload anyway; a still emoji is the safer guess.
            return false;
        }
    }

    updateName(key: number, name: string): void {
        this.patchRow(key, {name});
    }

    /** Drops one file from the batch without disturbing the rest. */
    removeQueued(key: number): void {
        if (this.uploading()) return;
        const row = this.queue().find(r => r.key === key);
        if (row) URL.revokeObjectURL(row.previewUrl);
        this.queue.update(rows => rows.filter(r => r.key !== key));
        if (this.queue().length === 0) this.closeUploadDialog();
    }

    confirmUpload(): void {
        if (this.uploading() || this.hasBlockingIssue() || this.remainingCount() === 0) return;
        // A retry re-arms whatever failed last time; the successes stay done and are not re-sent.
        this.queue.update(rows => rows.map(r => r.status === 'error' ? {...r, status: 'pending', errorKey: null} : r));
        this.uploading.set(true);
        this.uploadNext();
    }

    /** Uploads the queue one file at a time; a failure marks its own row and moves on rather than aborting the batch, and the dialog stays open while anything failed so Upload retries only what's left. */
    private uploadNext(): void {
        const next = this.queue().find(r => r.status === 'pending');
        if (!next) {
            this.uploading.set(false);
            if (this.failedCount() === 0) {
                const count = this.uploadedCount();
                this.closeUploadDialog();
                this.toastService.success(this.translate.instant('GUILD_SETTINGS.EMOJIS.UPLOAD_DONE', {count}));
            }
            return;
        }

        this.patchRow(next.key, {status: 'uploading', errorKey: null});
        this.guildEmojiService
            .uploadEmoji(this.guild().id, {name: next.name.trim(), animated: next.animated, file: next.file})
            .subscribe({
                next: created => {
                    this.guildEmojiStore.addEmoji(this.guild().id, created);
                    this.patchRow(next.key, {status: 'done', errorKey: null});
                    this.uploadNext();
                },
                error: err => {
                    this.patchRow(next.key, {status: 'error', errorKey: this.uploadErrorKey(err?.status)});
                    this.uploadNext();
                },
            });
    }

    private patchRow(key: number, patch: Partial<QueuedEmoji>): void {
        this.queue.update(rows => rows.map(r => r.key === key ? {...r, ...patch} : r));
    }

    /** No published size cap to state up front, so the server's rejection is named instead. A 409 should be rare since {@link rowIssues} checks the loaded list first, but a name taken by another admin between check and request can still land here. */
    private uploadErrorKey(status: number | undefined): string {
        if (status === 409) return 'GUILD_SETTINGS.EMOJIS.NAME_TAKEN';
        if (status === 413) return 'GUILD_SETTINGS.EMOJIS.TOO_LARGE';
        return 'GUILD_SETTINGS.EMOJIS.UPLOAD_ERROR';
    }

    /** Only a close should tear down the queue; an open must leave it alone. */
    onUploadVisibleChange(visible: boolean): void {
        if (!visible) this.closeUploadDialog();
    }

    closeUploadDialog(): void {
        // Closing mid-batch would orphan the request that is already on the wire.
        if (this.uploading()) return;
        this.showUploadDialog.set(false);
        this.revokeQueue();
    }

    private revokeQueue(): void {
        for (const row of this.queue()) URL.revokeObjectURL(row.previewUrl);
        this.queue.set([]);
    }

    openDeleteDialog(emoji: GuildEmojiDto): void {
        this.confirmDeleteEmoji.set(emoji);
        this.showDeleteDialog.set(true);
    }

    closeDeleteDialog(): void {
        this.confirmDeleteEmoji.set(null);
        this.showDeleteDialog.set(false);
    }

    deleteEmoji(emoji: GuildEmojiDto): void {
        if (this.deletingId()) return;
        this.deletingId.set(emoji.id);
        this.guildEmojiService.deleteEmoji(this.guild().id, emoji.id).subscribe({
            next: () => {
                this.guildEmojiStore.removeEmoji(this.guild().id, emoji.id);
                this.deletingId.set(null);
                this.closeDeleteDialog();
            },
            error: err => {
                this.deletingId.set(null);
                this.toastService.httpError(this.translate.instant('GUILD_SETTINGS.EMOJIS.DELETE_ERROR'), err);
            },
        });
    }
}

/** Plain byte scan: the markers are ASCII fourccs, and decoding the bytes as text to find them would be more work for the same answer. */
function containsMarker(bytes: Uint8Array, marker: string): boolean {
    for (let i = 0; i + marker.length <= bytes.length; i++) {
        let hit = true;
        for (let j = 0; j < marker.length; j++) {
            if (bytes[i + j] !== marker.charCodeAt(j)) {
                hit = false;
                break;
            }
        }
        if (hit) return true;
    }
    return false;
}
