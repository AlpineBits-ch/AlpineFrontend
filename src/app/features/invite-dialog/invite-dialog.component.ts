import {ChangeDetectionStrategy, Component, computed, DestroyRef, effect, inject, signal} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {PrimeTemplate} from 'primeng/api';
import {GuildService} from '../../services/guild.service';
import {InviteDialogService} from './invite-dialog.service';
import {InviteDto, InviteState} from '../../dtos/response/invite.dto';
import {environment} from '../../../environments/environment';

type DialogState = 'loading' | 'ready' | 'joining' | 'joined' | 'error';

@Component({
    selector: 'app-invite-dialog',
    standalone: true,
    imports: [Dialog, Button, PrimeTemplate],
    templateUrl: './invite-dialog.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InviteDialogComponent {
    protected readonly inviteDialogService = inject(InviteDialogService);
    private readonly guildService = inject(GuildService);
    private readonly destroyRef = inject(DestroyRef);

    protected readonly invite = signal<InviteDto | null>(null);
    protected readonly dialogState = signal<DialogState>('loading');
    protected readonly iconFailed = signal(false);
    protected readonly InviteState = InviteState;

    protected readonly visible = computed(() => this.inviteDialogService.inviteId() !== null);

    protected readonly guildIconUrl = computed(() => {
        const id = this.invite()?.guild?.id;
        return id ? `${environment.apiUrl}/api/v1/guild/guilds/${id}/icon` : '';
    });

    protected readonly guildInitials = computed(() => {
        const name = this.invite()?.guild?.name ?? '';
        return name.split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('');
    });

    constructor() {
        effect(() => {
            const inviteId = this.inviteDialogService.inviteId();
            if (!inviteId) return;

            this.invite.set(null);
            this.iconFailed.set(false);
            this.dialogState.set('loading');

            this.guildService.getInvite(inviteId)
                .pipe(takeUntilDestroyed(this.destroyRef))
                .subscribe({
                    next: invite => {
                        this.invite.set(invite);
                        this.dialogState.set('ready');
                    },
                    error: () => this.dialogState.set('error'),
                });
        });
    }

    protected join(): void {
        const inviteId = this.inviteDialogService.inviteId();
        if (!inviteId || this.dialogState() === 'joining') return;

        this.dialogState.set('joining');
        this.guildService.redeemInvite(inviteId)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
                next: () => {
                    this.dialogState.set('joined');
                    this.guildService.guildJoined$.next();
                },
                error: () => this.dialogState.set('ready'),
            });
    }

    protected dismiss(): void {
        this.inviteDialogService.close();
    }
}
