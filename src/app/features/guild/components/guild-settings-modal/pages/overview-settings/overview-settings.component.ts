import {Component, computed, inject, input, OnDestroy, OnInit, output, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Textarea} from 'primeng/textarea';
import {Dialog} from 'primeng/dialog';
import {Select} from 'primeng/select';
import {ChannelType, GuildDto} from '../../../../../../dtos/response/guild.dto';
import {GuildVerificationLevel} from '../../../../../../dtos/response/guild-safety.dto';
import {GuildService, UpdateGuildDto} from '../../../../../../services/guild.service';
import {ImageCropperComponent} from '../../../../../../components/image-cropper/image-cropper.component';
import {environment} from '../../../../../../../environments/environment';
import {TranslateModule} from '@ngx-translate/core';
import {ToastService} from '../../../../../../services/toast.service';
import {PrimeTemplate} from "primeng/api";

@Component({
    selector: 'app-overview-settings',
    imports: [FormsModule, Button, InputText, Textarea, Dialog, Select, ImageCropperComponent, TranslateModule, PrimeTemplate],
    templateUrl: './overview-settings.component.html',
})
export class OverviewSettingsComponent implements OnInit, OnDestroy {
    guild = input.required<GuildDto>();
    guildUpdated = output<GuildDto>();
    guildDeleted = output<string>();
    name = signal('');
    description = signal('');
    systemChannelId = signal<string | null>(null);
    channelOptions = computed(() =>
        this.guild().channels
            .filter(c => c.type === ChannelType.Text)
            .map(c => ({label: c.name, value: c.id}))
    );
    verificationLevel = signal<GuildVerificationLevel>(GuildVerificationLevel.None);

    /** Requirement text is spelled out per option, the way Discord's own picker does. */
    readonly verificationOptions = [
        {label: 'None', value: GuildVerificationLevel.None, hint: 'GUILD_SETTINGS.OVERVIEW.VERIFY_NONE_HINT'},
        {label: 'Low', value: GuildVerificationLevel.Low, hint: 'GUILD_SETTINGS.OVERVIEW.VERIFY_LOW_HINT'},
        {label: 'Medium', value: GuildVerificationLevel.Medium, hint: 'GUILD_SETTINGS.OVERVIEW.VERIFY_MEDIUM_HINT'},
        {label: 'High', value: GuildVerificationLevel.High, hint: 'GUILD_SETTINGS.OVERVIEW.VERIFY_HIGH_HINT'},
    ];

    protected verificationHint = computed(() =>
        this.verificationOptions.find(o => o.value === this.verificationLevel())?.hint ?? ''
    );
    saving = signal(false);
    dirty = signal(false);
    iconPreview = signal<string | null>(null);
    pendingIconFile = signal<File | null>(null);
    iconRemoved = signal(false);
    cropVisible = signal(false);
    cropSrc = signal('');
    showDeleteDialog = signal(false);
    deleting = signal(false);
    private guildService = inject(GuildService);
    private toastService = inject(ToastService);
    private previewObjectUrl: string | null = null;

    ngOnInit(): void {
        this.name.set(this.guild().name);
        this.description.set(this.guild().description ?? '');
        this.systemChannelId.set(this.guild().systemChannelId);
        this.verificationLevel.set(this.guild().verificationLevel ?? GuildVerificationLevel.None);
        if (this.previewObjectUrl) {
            URL.revokeObjectURL(this.previewObjectUrl);
            this.previewObjectUrl = null;
        }
        this.pendingIconFile.set(null);
        this.iconRemoved.set(false);
        this.iconPreview.set(this.iconUrl(this.guild().id));
    }

    ngOnDestroy(): void {
        if (this.previewObjectUrl) URL.revokeObjectURL(this.previewObjectUrl);
    }

    onFieldChange(): void {
        const g = this.guild();
        this.dirty.set(
            this.name() !== g.name
            || this.description() !== (g.description ?? '')
            || this.systemChannelId() !== g.systemChannelId
            || this.verificationLevel() !== (g.verificationLevel ?? GuildVerificationLevel.None)
        );
    }

    onIconSelected(event: Event): void {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            this.cropSrc.set(reader.result as string);
            this.cropVisible.set(true);
        };
        reader.readAsDataURL(file);
    }

    onCropConfirmed(file: File): void {
        this.cropVisible.set(false);
        if (this.previewObjectUrl) URL.revokeObjectURL(this.previewObjectUrl);
        this.previewObjectUrl = URL.createObjectURL(file);
        this.pendingIconFile.set(file);
        this.iconPreview.set(this.previewObjectUrl);
        this.dirty.set(true);
    }

    removeIcon(): void {
        if (this.previewObjectUrl) {
            URL.revokeObjectURL(this.previewObjectUrl);
            this.previewObjectUrl = null;
        }
        this.iconPreview.set(null);
        this.pendingIconFile.set(null);
        this.iconRemoved.set(true);
        this.dirty.set(true);
    }

    onIconLoadError(): void {
        if (this.iconPreview() === this.iconUrl(this.guild().id)) {
            this.iconPreview.set(null);
        }
    }

    save(): void {
        if (this.saving()) return;
        this.saving.set(true);

        const doUpdate = (g: GuildDto) => {
            const dto: UpdateGuildDto = {name: this.name(), description: this.description()};
            if (this.systemChannelId() !== g.systemChannelId && this.systemChannelId()) {
                dto.systemChannelId = this.systemChannelId()!;
            }
            if (this.verificationLevel() !== (g.verificationLevel ?? GuildVerificationLevel.None)) {
                dto.verificationLevel = this.verificationLevel();
            }
            this.guildService.updateGuild(g.id, dto).subscribe({
                next: updated => {
                    this.guildService.guildUpdated$.next(updated);
                    this.guildUpdated.emit(updated);
                    this.dirty.set(false);
                    this.saving.set(false);
                },
                error: () => this.saving.set(false),
            });
        };

        if (this.pendingIconFile()) {
            this.guildService.uploadGuildIcon(this.guild().id, this.pendingIconFile()!).subscribe({
                next: () => {
                    this.pendingIconFile.set(null);
                    doUpdate(this.guild());
                },
                error: () => this.saving.set(false),
            });
        } else if (this.iconRemoved()) {
            this.guildService.removeGuildIcon(this.guild().id).subscribe({
                next: updated => doUpdate(updated),
                error: () => this.saving.set(false),
            });
        } else {
            doUpdate(this.guild());
        }
    }

    deleteGuild(): void {
        if (this.deleting()) return;
        this.deleting.set(true);
        this.guildService.deleteGuild(this.guild().id).subscribe({
            next: () => {
                this.guildDeleted.emit(this.guild().id);
                this.showDeleteDialog.set(false);
                this.deleting.set(false);
            },
            error: err => {
                this.deleting.set(false);
                this.toastService.httpError('Failed to delete server', err);
            },
        });
    }

    private iconUrl(guildId: string): string {
        return `${environment.apiUrl}/api/v1/guild/guilds/${guildId}/icon`;
    }
}
