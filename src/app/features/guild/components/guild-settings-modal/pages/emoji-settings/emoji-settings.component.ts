import {Component, computed, ElementRef, inject, input, OnInit, signal, ViewChild} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Dialog} from 'primeng/dialog';
import {Checkbox} from 'primeng/checkbox';
import {PrimeTemplate} from 'primeng/api';
import {GuildDto} from '../../../../../../dtos/response/guild.dto';
import {SelfGuildMemberDto} from '../../../../../../dtos/response/member.dto';
import {GuildEmojiDto} from '../../../../../../dtos/response/guild-emoji.dto';
import {GuildService} from '../../../../../../services/guild.service';
import {GuildEmojiService} from '../../../../../../services/guild-emoji.service';
import {GuildEmojiStore} from '../../../../../../stores/guild-emoji.store';
import {ToastService} from '../../../../../../services/toast.service';
import {hasPermission, parsePermissions, Permissions} from '../../../../../../enums/permissions.enum';

@Component({
    selector: 'app-emoji-settings',
    imports: [FormsModule, Button, InputText, Dialog, Checkbox, PrimeTemplate],
    templateUrl: './emoji-settings.component.html',
})
export class EmojiSettingsComponent implements OnInit {
    guild = input.required<GuildDto>();

    emojis = computed(() => this.guildEmojiStore.getEmojis(this.guild().id));
    loading = signal(true);
    deletingId = signal<string | null>(null);

    showUploadDialog = signal(false);
    pendingFile = signal<File | null>(null);
    pendingPreviewUrl = signal<string | null>(null);
    uploadName = signal('');
    uploadAnimated = signal(false);
    uploading = signal(false);

    @ViewChild('fileInput') private fileInputRef?: ElementRef<HTMLInputElement>;

    private guildService = inject(GuildService);
    private guildEmojiService = inject(GuildEmojiService);
    private guildEmojiStore = inject(GuildEmojiStore);
    private toastService = inject(ToastService);
    private ownMember = signal<SelfGuildMemberDto | null>(null);
    private previewObjectUrl: string | null = null;

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
        this.guildService.getOwnMember(this.guild().id).subscribe(m => this.ownMember.set(m));
        this.loading.set(true);
        this.guildEmojiStore.ensureLoaded(this.guild().id);
        this.guildEmojiService.getEmojis(this.guild().id).subscribe({
            next: () => this.loading.set(false),
            error: () => this.loading.set(false),
        });
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
        if (!file || !name || this.uploading()) return;
        this.uploading.set(true);
        this.guildEmojiService.uploadEmoji(this.guild().id, {name, animated: this.uploadAnimated(), file}).subscribe({
            next: created => {
                this.guildEmojiStore.addEmoji(this.guild().id, created);
                this.closeUploadDialog();
                this.uploading.set(false);
            },
            error: err => {
                this.uploading.set(false);
                this.toastService.httpError(err?.status === 409 ? 'An emoji with that name already exists' : 'Failed to upload emoji', err);
            },
        });
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

    deleteEmoji(emoji: GuildEmojiDto): void {
        if (this.deletingId()) return;
        this.deletingId.set(emoji.id);
        this.guildEmojiService.deleteEmoji(this.guild().id, emoji.id).subscribe({
            next: () => {
                this.guildEmojiStore.removeEmoji(this.guild().id, emoji.id);
                this.deletingId.set(null);
            },
            error: err => {
                this.deletingId.set(null);
                this.toastService.httpError('Failed to delete emoji', err);
            },
        });
    }
}
