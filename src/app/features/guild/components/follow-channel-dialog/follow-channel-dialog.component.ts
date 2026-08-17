import {ChangeDetectionStrategy, Component, computed, inject, input, model, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {HttpErrorResponse} from '@angular/common/http';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {Select} from 'primeng/select';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {GuildService} from '../../../../services/guild.service';
import {ChannelFollowService} from '../../../../services/channel-follow.service';
import {ChannelType, GuildDto} from '../../../../dtos/response/guild.dto';
import {ToastService} from '../../../../services/toast.service';

@Component({
    selector: 'app-follow-channel-dialog',
    imports: [Dialog, Button, Select, FormsModule, TranslateModule],
    templateUrl: './follow-channel-dialog.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FollowChannelDialogComponent {
    readonly sourceChannelId = input.required<string>();
    readonly sourceChannelName = input.required<string>();
    readonly visible = model.required<boolean>();

    private guildService = inject(GuildService);
    private channelFollowService = inject(ChannelFollowService);
    private toast = inject(ToastService);
    private translate = inject(TranslateService);

    protected readonly guilds = signal<GuildDto[]>([]);
    protected readonly selectedGuildId = signal<string | undefined>(undefined);
    protected readonly selectedChannelId = signal<string | undefined>(undefined);
    protected readonly submitting = signal(false);
    protected readonly inlineError = signal<string | null>(null);

    protected readonly guildOptions = computed(() => this.guilds().map(g => ({label: g.name, value: g.id})));

    protected readonly channelOptions = computed(() => {
        const guild = this.guilds().find(g => g.id === this.selectedGuildId());
        if (!guild) return [];
        return guild.channels
            .filter(c => c.type === ChannelType.Text)
            .map(c => ({label: c.name, value: c.id}));
    });

    protected readonly canConfirm = computed(
        () => !!this.selectedGuildId() && !!this.selectedChannelId() && !this.submitting(),
    );

    constructor() {
        this.guildService.getGuilds().subscribe(guilds => this.guilds.set(guilds));
    }

    protected onGuildChange(guildId: string): void {
        this.selectedGuildId.set(guildId);
        this.selectedChannelId.set(undefined);
        this.inlineError.set(null);
    }

    protected onChannelChange(channelId: string): void {
        this.selectedChannelId.set(channelId);
        this.inlineError.set(null);
    }

    protected confirm(): void {
        const targetChannelId = this.selectedChannelId();
        if (!this.canConfirm() || !targetChannelId) return;
        this.submitting.set(true);
        this.inlineError.set(null);
        this.channelFollowService.follow(this.sourceChannelId(), targetChannelId).subscribe({
            next: () => {
                this.submitting.set(false);
                this.toast.success(this.translate.instant('FOLLOW_CHANNEL.SUCCESS_TOAST'));
                this.close();
            },
            error: (err: unknown) => {
                this.submitting.set(false);
                if (err instanceof HttpErrorResponse && err.status === 409) {
                    this.inlineError.set(this.translate.instant('FOLLOW_CHANNEL.ALREADY_FOLLOWING'));
                } else if (err instanceof HttpErrorResponse && err.status === 403) {
                    this.inlineError.set(this.translate.instant('FOLLOW_CHANNEL.NEED_MANAGE_CHANNEL'));
                } else {
                    this.toast.httpError(this.translate.instant('FOLLOW_CHANNEL.FOLLOW_ERROR_TOAST'), err);
                }
            },
        });
    }

    protected close(): void {
        this.visible.set(false);
        this.selectedGuildId.set(undefined);
        this.selectedChannelId.set(undefined);
        this.inlineError.set(null);
        this.submitting.set(false);
    }
}
