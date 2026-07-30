import {ChangeDetectionStrategy, Component, computed, DestroyRef, effect, inject, signal} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {HttpErrorResponse} from '@angular/common/http';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {PrimeTemplate} from 'primeng/api';
import {TranslateModule} from '@ngx-translate/core';
import {GuildService} from '../../services/guild.service';
import {InviteDialogService} from './invite-dialog.service';
import {InviteDto, InviteState} from '../../dtos/response/invite.dto';
import {environment} from '../../../environments/environment';

type DialogState = 'loading' | 'ready' | 'joining' | 'joined' | 'error' | 'blocked';

@Component({
    selector: 'app-invite-dialog',
    standalone: true,
    imports: [Dialog, Button, PrimeTemplate, TranslateModule],
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
    protected readonly requiredLevel = signal<string | null>(null);

    protected readonly visible = computed(() => this.inviteDialogService.inviteId() !== null);

    /**
     * Derived here rather than exposing the InviteState enum to the template. Re-exporting
     * an enum as a field couples the view to module-evaluation order, which is fragile
     * under the test runner's module graph, and a boolean is what the template actually wants.
     */
    protected readonly isExpired = computed(() => this.invite()?.state === InviteState.Expired);

    protected readonly guildIconUrl = computed(() => {
        const id = this.invite()?.guild?.id;
        return id ? `${environment.apiUrl}/api/v1/guild/guilds/${id}/icon` : '';
    });

    protected readonly guildInitials = computed(() => {
        const name = this.invite()?.guild?.name ?? '';
        return name.split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('');
    });

    /** Absent, or present-but-disabled, both mean "render nothing extra". */
    protected readonly welcomeScreen = computed(() => {
        const screen = this.invite()?.welcomeScreen;
        return screen?.enabled ? screen : null;
    });

    protected readonly welcomeChannels = computed(() =>
        [...(this.welcomeScreen()?.channels ?? [])].sort((a, b) => a.position - b.position));

    /** Maps the tier the server reported to the requirement to spell out to the user. */
    protected readonly blockedReasonKey = computed(() => {
        switch (this.requiredLevel()) {
            case 'Low': return 'INVITE.VERIFY_LOW';
            case 'Medium': return 'INVITE.VERIFY_MEDIUM';
            case 'High': return 'INVITE.VERIFY_HIGH';
            default: return 'INVITE.VERIFY_GENERIC';
        }
    });

    constructor() {
        effect(() => {
            const inviteId = this.inviteDialogService.inviteId();
            if (!inviteId) return;

            this.invite.set(null);
            this.iconFailed.set(false);
            this.requiredLevel.set(null);
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
                error: (err: HttpErrorResponse) => {
                    // A 403 from redeem is either the verification gate or an ordinary
                    // ban/permission refusal - only the structured body distinguishes them,
                    // so check for the marker rather than treating every 403 the same.
                    const body = err?.error as { error?: string; requiredLevel?: string } | null;
                    if (err?.status === 403 && body?.error === 'verification_level_not_met') {
                        this.requiredLevel.set(body.requiredLevel ?? null);
                        this.dialogState.set('blocked');
                        return;
                    }
                    this.dialogState.set('ready');
                },
            });
    }

    protected dismiss(): void {
        this.inviteDialogService.close();
    }
}
