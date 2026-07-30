import {Component, computed, ElementRef, inject, input, OnDestroy, OnInit, signal, ViewChild} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Dialog} from 'primeng/dialog';
import {Checkbox} from 'primeng/checkbox';
import {Tooltip} from 'primeng/tooltip';
import {PrimeTemplate} from 'primeng/api';
import {GuildDto} from '../../../../../../dtos/response/guild.dto';
import {SelfGuildMemberDto} from '../../../../../../dtos/response/member.dto';
import {GuildEmojiDto} from '../../../../../../dtos/response/guild-emoji.dto';
import {GuildService} from '../../../../../../services/guild.service';
import {GuildEmojiService} from '../../../../../../services/guild-emoji.service';
import {GuildEmojiStore} from '../../../../../../stores/guild-emoji.store';
import {ToastService} from '../../../../../../services/toast.service';
import {hasPermission, parsePermissions, Permissions} from '../../../../../../enums/permissions.enum';
import {TranslateModule, TranslateService} from '@ngx-translate/core';

/** Server-side naming rule, mirrored so the field can say so before the request. */
const EMOJI_NAME_PATTERN = /^[a-zA-Z0-9_]+$/;

@Component({
    selector: 'app-emoji-settings',
    imports: [FormsModule, Button, InputText, Dialog, Checkbox, Tooltip, PrimeTemplate, TranslateModule],
    templateUrl: './emoji-settings.component.html',
})
export class EmojiSettingsComponent implements OnInit, OnDestroy {
    guild = input.required<GuildDto>();

    emojis = computed(() => this.guildEmojiStore.getEmojis(this.guild().id));
    loading = signal(true);
    deletingId = signal<string | null>(null);
    filter = signal('');

    showUploadDialog = signal(false);
    pendingFile = signal<File | null>(null);
    pendingPreviewUrl = signal<string | null>(null);
    uploadName = signal('');
    uploadAnimated = signal(false);
    uploading = signal(false);
    confirmDeleteEmoji = signal<GuildEmojiDto | null>(null);
    showDeleteDialog = signal(false);

    filteredEmojis = computed(() => {
        const q = this.filter().trim().toLowerCase();
        const all = this.emojis();
        return q ? all.filter(e => e.name.toLowerCase().includes(q)) : all;
    });

    /** Flags a bad name in the dialog instead of letting the server reject it with a 400. */
    protected nameInvalid = computed(() => {
        const n = this.uploadName().trim();
        return n.length > 0 && !EMOJI_NAME_PATTERN.test(n);
    });

    @ViewChild('fileInput') private fileInputRef?: ElementRef<HTMLInputElement>;

    private guildService = inject(GuildService);
    private guildEmojiService = inject(GuildEmojiService);
    private guildEmojiStore = inject(GuildEmojiStore);
    private toastService = inject(ToastService);
    private translate = inject(TranslateService);
    private ownMember = signal<SelfGuildMemberDto | null>(null);
    private previewObjectUrl: string | null = null;

    /**
     * Separate from `canManageEmojis` so the page can stay quiet while the member row is
     * in flight -otherwise the "no permission" note flashes up for people who do have it.
     */
    protected permissionsLoaded = signal(false);

    canManageEmojis = computed(() => {
        const member = this.ownMember();
        if (!member) return false;
        const permissionString = member.roleMembers.reduce((curr, m) => {
            if (!m.role.permissions) return curr;
            return curr === '' ? m.role.permissions : `${curr},${m.role.permissions}`;
        }, member.permissions ?? '');
        const perms = parsePermissions(permissionString);
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
        if (this.previewObjectUrl) URL.revokeObjectURL(this.previewObjectUrl);
    }

    openFilePicker(): void {
        this.fileInputRef?.nativeElement.click();
    }

    onFileSelected(event: Event): void {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;

        if (this.previewObjectUrl) URL.revokeObjectURL(this.previewObjectUrl);
        this.previewObjectUrl = URL.createObjectURL(file);
        this.pendingFile.set(file);
        this.pendingPreviewUrl.set(this.previewObjectUrl);

        const baseName = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 32);
        this.uploadName.set(baseName);
        this.uploadAnimated.set(file.type === 'image/gif');
        this.showUploadDialog.set(true);
    }

    confirmUpload(): void {
        const file = this.pendingFile();
        const name = this.uploadName().trim();
        if (!file || !name || this.nameInvalid() || this.uploading()) return;
        this.uploading.set(true);
        this.guildEmojiService.uploadEmoji(this.guild().id, {name, animated: this.uploadAnimated(), file}).subscribe({
            next: created => {
                this.guildEmojiStore.addEmoji(this.guild().id, created);
                this.closeUploadDialog();
                this.uploading.set(false);
            },
            error: err => {
                this.uploading.set(false);
                this.toastService.httpError(this.translate.instant(this.uploadErrorKey(err?.status)), err);
            },
        });
    }

    /** There is no published size cap to state up front, so the server's rejection is named instead. */
    private uploadErrorKey(status: number | undefined): string {
        if (status === 409) return 'GUILD_SETTINGS.EMOJIS.NAME_TAKEN';
        if (status === 413) return 'GUILD_SETTINGS.EMOJIS.TOO_LARGE';
        return 'GUILD_SETTINGS.EMOJIS.UPLOAD_ERROR';
    }

    /** Only a close should tear down the pending file; an open must leave it alone. */
    onUploadVisibleChange(visible: boolean): void {
        if (!visible) this.closeUploadDialog();
    }

    closeUploadDialog(): void {
        this.showUploadDialog.set(false);
        if (this.previewObjectUrl) {
            URL.revokeObjectURL(this.previewObjectUrl);
            this.previewObjectUrl = null;
        }
        this.pendingFile.set(null);
        this.pendingPreviewUrl.set(null);
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
