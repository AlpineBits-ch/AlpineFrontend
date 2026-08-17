import {ChangeDetectionStrategy, Component, computed, DestroyRef, effect, inject, signal} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {HttpErrorResponse} from '@angular/common/http';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {PrimeTemplate} from 'primeng/api';
import {TranslateModule} from '@ngx-translate/core';
import {GuildService} from '../../services/guild.service';
import {InviteDialogService} from './invite-dialog.service';
import {
    InviteDto,
    isInviteExpired,
    isInviteRevoked,
    RedeemInviteResultDto,
} from '../../dtos/response/invite.dto';
import {ChannelType} from '../../dtos/response/guild.dto';
import {environment} from '../../../environments/environment';
import {SocialKeyGateService} from '../../services/social-key-gate.service';
import {VoiceChannelService} from '../../services/voice-channel.service';

/** `rate-limited` is deliberately not `error`. */
type DialogState =
    'loading' | 'ready' | 'joining' | 'joined' | 'error' | 'blocked' | 'rate-limited';

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
    private readonly socialGate = inject(SocialKeyGateService);
    private readonly voiceChannels = inject(VoiceChannelService);

    protected readonly invite = signal<InviteDto | null>(null);
    protected readonly dialogState = signal<DialogState>('loading');
    protected readonly iconFailed = signal(false);
    protected readonly requiredLevel = signal<string | null>(null);
    /** What the redeem answered, so the confirmation can say what actually happened. */
    protected readonly redeemResult = signal<RedeemInviteResultDto | null>(null);

    protected readonly visible = computed(() => this.inviteDialogService.inviteId() !== null);

    /**
     * Derived here rather than exposing the InviteState enum to the template. Re-exporting
     * an enum as a field couples the view to module-evaluation order, which is fragile
     * under the test runner's module graph, and a boolean is what the template actually wants.
     */
    protected readonly isExpired = computed(() => isInviteExpired(this.invite()));

    /**
     * Taken away, rather than run out. In practice a revoked invite answers `404` on the preview
     * routes - indistinguishable from a code that was never real, on purpose - so this is only
     * reachable when a preview was fetched before the revocation. It is still rendered separately,
     * because "somebody withdrew this" and "this lapsed" are different things to tell a person.
     */
    protected readonly isRevoked = computed(() => isInviteRevoked(this.invite()));

    /** The membership ends when they go offline. A member who is not told simply vanishes. */
    protected readonly joinedTemporarily = computed(() => !!this.redeemResult()?.temporaryMembership);

    /** The rules gate is still pending, so the guild is not open to them yet. */
    protected readonly onboardingRequired = computed(() => !!this.redeemResult()?.onboardingRequired);

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
            this.redeemResult.set(null);
            this.load(inviteId);
        });
    }

    /**
     * Fetches the preview. One request per link the user opens - never a poll, and never a
     * prefetch: this route is the only unauthenticated surface that says whether a code exists, so
     * it is budgeted, and a retry loop would spend the whole budget proving that.
     */
    protected load(inviteId?: string | null): void {
        const id = inviteId ?? this.inviteDialogService.inviteId();
        if (!id) return;

        this.dialogState.set('loading');
        this.guildService.getInvite(id)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
                next: invite => {
                    this.invite.set(invite);
                    this.dialogState.set('ready');
                },
                error: (err: HttpErrorResponse) => this.dialogState.set(
                    err?.status === 429 ? 'rate-limited' : 'error'),
            });
    }

    protected join(): void {
        const inviteId = this.inviteDialogService.inviteId();
        if (!inviteId || this.dialogState() === 'joining') return;

        // Joining a server is durable state on someone else's turf, so it gets the same gate as
        // creating one. Declining leaves the invite on screen, still joinable.
        if (!this.socialGate.isSatisfied()) {
            void this.socialGate.require().then(allowed => {
                if (allowed) this.join();
            });
            return;
        }

        this.dialogState.set('joining');
        this.guildService.redeemInvite(inviteId)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
                next: result => {
                    this.redeemResult.set(result ?? null);
                    this.dialogState.set('joined');
                    this.guildService.guildJoined$.next();
                    this.landInVoice(result);
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

    /** Connects to the voice channel a voice-target invite landed on. */
    private landInVoice(result: RedeemInviteResultDto | null | undefined): void {
        if (!result?.joinVoice || !result.channelId) return;

        this.guildService.getGuild(result.guildId)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
                next: guild => {
                    const channel = guild.channels.find(
                        c => c.id === result.channelId && c.type === ChannelType.Voice);
                    if (channel) void this.voiceChannels.joinChannel(channel, guild.name);
                },
                error: () => undefined,
            });
    }
}
