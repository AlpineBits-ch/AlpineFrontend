import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    inject,
    input,
    OnDestroy,
    OnInit,
    output,
    signal,
} from '@angular/core';
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
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {ToastService} from '../../../../../../services/toast.service';
import {PrimeTemplate} from 'primeng/api';

/** The last-saved values `dirty` measures against. */
interface Baseline {
    name: string;
    description: string;
    systemChannelId: string | null;
    verificationLevel: GuildVerificationLevel;
}

/** The shared `UpdateGuildDto` types `systemChannelId` as `string | undefined`, so "clear it" has no representation there; the payload is widened locally to send an explicit `null`, since omitting the key swallows a cleared picker. */
type UpdateGuildPayload = Omit<UpdateGuildDto, 'systemChannelId'> & {systemChannelId?: string | null};

/** What happened to the icon before the settings PATCH went out, so a failure can say so. */
type IconOutcome = 'none' | 'uploaded' | 'removed';

@Component({
    selector: 'app-overview-settings',
    imports: [
        FormsModule,
        Button,
        InputText,
        Textarea,
        Dialog,
        Select,
        ImageCropperComponent,
        TranslateModule,
        PrimeTemplate,
    ],
    templateUrl: './overview-settings.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OverviewSettingsComponent implements OnInit, OnDestroy {
    readonly guild = input.required<GuildDto>();
    guildUpdated = output<GuildDto>();
    guildDeleted = output<string>();
    /** Lets the modal shell guard nav-away and close while edits are pending. */
    dirtyChange = output<boolean>();
    readonly name = signal('');
    readonly description = signal('');
    readonly systemChannelId = signal<string | null>(null);
    readonly channelOptions = computed(() =>
        this.guild()
            .channels.filter(c => c.type === ChannelType.Text)
            .map(c => ({label: c.name, value: c.id})),
    );
    readonly verificationLevel = signal<GuildVerificationLevel>(GuildVerificationLevel.None);

    /** Requirement text is spelled out per option, the way Discord's own picker does. */
    readonly verificationOptions = [
        {label: 'None', value: GuildVerificationLevel.None, hint: 'GUILD_SETTINGS.OVERVIEW.VERIFY_NONE_HINT'},
        {label: 'Low', value: GuildVerificationLevel.Low, hint: 'GUILD_SETTINGS.OVERVIEW.VERIFY_LOW_HINT'},
        {
            label: 'Medium',
            value: GuildVerificationLevel.Medium,
            hint: 'GUILD_SETTINGS.OVERVIEW.VERIFY_MEDIUM_HINT',
        },
        {label: 'High', value: GuildVerificationLevel.High, hint: 'GUILD_SETTINGS.OVERVIEW.VERIFY_HIGH_HINT'},
    ];

    protected readonly verificationHint = computed(
        () => this.verificationOptions.find(o => o.value === this.verificationLevel())?.hint ?? '',
    );
    readonly saving = signal(false);
    readonly iconPreview = signal<string | null>(null);
    readonly pendingIconFile = signal<File | null>(null);
    readonly iconRemoved = signal(false);
    readonly cropVisible = signal(false);
    readonly cropSrc = signal('');
    readonly showDeleteDialog = signal(false);
    readonly deleteConfirmName = signal('');
    readonly deleting = signal(false);

    /** Trimmed empty names are rejected client-side; the field is marked required. */
    protected readonly nameInvalid = computed(() => this.name().trim().length === 0);

    /** Mirrors the template `maxlength` values so the counters cannot drift from the real cap. */
    protected readonly nameLimit = 100;
    protected readonly descriptionLimit = 300;
    protected readonly nameAtCap = computed(() => this.name().length >= this.nameLimit);
    protected readonly descriptionAtCap = computed(() => this.description().length >= this.descriptionLimit);

    /** Matches the "up to 8 MB" promise in ICON_HINT. */
    private readonly maxIconMb = 8;
    private readonly maxIconBytes = this.maxIconMb * 1024 * 1024;

    /** Compared against a local baseline rather than `guild()`, because a successful save can't rely on the parent pushing a fresh guild back down this input. */
    private readonly baseline = signal<Baseline>({
        name: '',
        description: '',
        systemChannelId: null,
        verificationLevel: GuildVerificationLevel.None,
    });

    /** Must account for the pending icon file and removal flag, not just the text fields, or Save can vanish while a file is still queued. */
    readonly dirty = computed(() => {
        const b = this.baseline();
        return (
            this.name() !== b.name ||
            this.description() !== b.description ||
            this.systemChannelId() !== b.systemChannelId ||
            this.verificationLevel() !== b.verificationLevel ||
            this.pendingIconFile() !== null ||
            this.iconRemoved()
        );
    });

    /** Delete is gated on retyping the name, the way the rest of the app gates nothing else this destructive. */
    protected readonly deleteConfirmed = computed(
        () => this.deleteConfirmName().trim() === this.guild().name.trim(),
    );

    private guildService = inject(GuildService);
    private toastService = inject(ToastService);
    private translate = inject(TranslateService);
    private previewObjectUrl: string | null = null;

    constructor() {
        effect(() => this.dirtyChange.emit(this.dirty()));
    }

    ngOnInit(): void {
        this.reset();
    }

    ngOnDestroy(): void {
        if (this.previewObjectUrl) URL.revokeObjectURL(this.previewObjectUrl);
    }

    /** Restores every field to the saved guild. Was previously wired to `ngOnInit`. */
    reset(): void {
        const g = this.guild();
        this.baseline.set({
            name: g.name,
            description: g.description ?? '',
            systemChannelId: g.systemChannelId,
            verificationLevel: g.verificationLevel ?? GuildVerificationLevel.None,
        });
        this.name.set(g.name);
        this.description.set(g.description ?? '');
        this.systemChannelId.set(g.systemChannelId);
        this.verificationLevel.set(g.verificationLevel ?? GuildVerificationLevel.None);
        if (this.previewObjectUrl) {
            URL.revokeObjectURL(this.previewObjectUrl);
            this.previewObjectUrl = null;
        }
        this.pendingIconFile.set(null);
        this.iconRemoved.set(false);
        this.iconPreview.set(this.iconUrl(this.guild().id));
    }

    onIconSelected(event: Event): void {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;
        // Without this the whole file is read into a data URL and handed to the cropper, so a phone photo froze the dialog for seconds before the server would have refused it anyway.
        if (file.size > this.maxIconBytes) {
            this.toastService.error(
                this.translate.instant('GUILD_SETTINGS.OVERVIEW.ICON_TOO_LARGE', {max: this.maxIconMb}),
            );
            return;
        }
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
        this.iconRemoved.set(false);
        this.iconPreview.set(this.previewObjectUrl);
    }

    removeIcon(): void {
        if (this.previewObjectUrl) {
            URL.revokeObjectURL(this.previewObjectUrl);
            this.previewObjectUrl = null;
        }
        this.iconPreview.set(null);
        this.pendingIconFile.set(null);
        this.iconRemoved.set(true);
    }

    onIconLoadError(): void {
        if (this.iconPreview() === this.iconUrl(this.guild().id)) {
            this.iconPreview.set(null);
        }
    }

    save(): void {
        if (this.saving() || !this.dirty() || this.nameInvalid()) return;
        this.saving.set(true);

        const doUpdate = (g: GuildDto, icon: IconOutcome) => {
            const dto: UpdateGuildPayload = {name: this.name().trim(), description: this.description()};
            const clearingSystemChannel = this.systemChannelId() === null && g.systemChannelId !== null;
            // Sent even when it is null: the guard here also required a truthy value, so clearing the picker dropped the change and the form went clean with the channel still set.
            if (this.systemChannelId() !== g.systemChannelId) {
                dto.systemChannelId = this.systemChannelId();
            }
            if (this.verificationLevel() !== (g.verificationLevel ?? GuildVerificationLevel.None)) {
                dto.verificationLevel = this.verificationLevel();
            }
            this.guildService.updateGuild(g.id, dto as UpdateGuildDto).subscribe({
                next: updated => {
                    this.guildService.guildUpdated$.next(updated);
                    this.guildUpdated.emit(updated);
                    // Re-baseline on what was actually persisted so `dirty` settles to false.
                    this.baseline.set({
                        name: updated.name,
                        description: updated.description ?? '',
                        systemChannelId: updated.systemChannelId,
                        verificationLevel: updated.verificationLevel ?? GuildVerificationLevel.None,
                    });
                    this.name.set(updated.name);
                    this.description.set(updated.description ?? '');
                    this.systemChannelId.set(updated.systemChannelId);
                    this.verificationLevel.set(updated.verificationLevel ?? GuildVerificationLevel.None);
                    this.pendingIconFile.set(null);
                    this.iconRemoved.set(false);
                    this.saving.set(false);
                    // The server ignores a null systemChannelId, so say so rather than let the clean form imply the channel was cleared.
                    if (clearingSystemChannel && updated.systemChannelId !== null) {
                        this.toastService.warn(
                            this.translate.instant(
                                'GUILD_SETTINGS.OVERVIEW.SYSTEM_CHANNEL_CLEAR_UNSUPPORTED',
                            ),
                        );
                    } else {
                        this.toastService.success(
                            this.translate.instant('GUILD_SETTINGS.OVERVIEW.SAVE_SUCCESS'),
                        );
                    }
                },
                // A failure here can arrive after the icon already changed, so the message has to say which half landed.
                error: err => {
                    this.saving.set(false);
                    this.toastService.httpError(this.translate.instant(this.saveErrorKey(icon)), err);
                },
            });
        };

        if (this.pendingIconFile()) {
            this.guildService.uploadGuildIcon(this.guild().id, this.pendingIconFile()!).subscribe({
                next: () => {
                    this.pendingIconFile.set(null);
                    doUpdate(this.guild(), 'uploaded');
                },
                error: err => {
                    this.saving.set(false);
                    this.toastService.httpError(
                        this.translate.instant('GUILD_SETTINGS.OVERVIEW.ICON_UPLOAD_ERROR'),
                        err,
                    );
                },
            });
        } else if (this.iconRemoved()) {
            this.guildService.removeGuildIcon(this.guild().id).subscribe({
                next: updated => doUpdate(updated, 'removed'),
                error: err => {
                    this.saving.set(false);
                    this.toastService.httpError(
                        this.translate.instant('GUILD_SETTINGS.OVERVIEW.ICON_REMOVE_ERROR'),
                        err,
                    );
                },
            });
        } else {
            doUpdate(this.guild(), 'none');
        }
    }

    private saveErrorKey(icon: IconOutcome): string {
        if (icon === 'uploaded') return 'GUILD_SETTINGS.OVERVIEW.SAVE_ERROR_ICON_UPLOADED';
        if (icon === 'removed') return 'GUILD_SETTINGS.OVERVIEW.SAVE_ERROR_ICON_REMOVED';
        return 'GUILD_SETTINGS.OVERVIEW.SAVE_ERROR';
    }

    openDeleteDialog(): void {
        this.deleteConfirmName.set('');
        this.showDeleteDialog.set(true);
    }

    deleteGuild(): void {
        if (this.deleting() || !this.deleteConfirmed()) return;
        this.deleting.set(true);
        this.guildService.deleteGuild(this.guild().id).subscribe({
            next: () => {
                this.guildDeleted.emit(this.guild().id);
                this.showDeleteDialog.set(false);
                this.deleting.set(false);
            },
            error: err => {
                this.deleting.set(false);
                this.toastService.httpError(
                    this.translate.instant('GUILD_SETTINGS.OVERVIEW.DELETE_ERROR'),
                    err,
                );
            },
        });
    }

    private iconUrl(guildId: string): string {
        return `${environment.apiUrl}/api/v1/guild/guilds/${guildId}/icon`;
    }
}
