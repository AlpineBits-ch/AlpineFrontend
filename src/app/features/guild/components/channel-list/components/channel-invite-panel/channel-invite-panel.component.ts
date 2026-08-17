import {
    ChangeDetectionStrategy,
    Component,
    computed,
    DestroyRef,
    inject,
    input,
    OnInit,
    output,
    signal,
} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {HttpErrorResponse} from '@angular/common/http';
import {NgClass} from '@angular/common';
import {TranslateModule} from '@ngx-translate/core';
import {AppAvatarComponent} from '../../../../../../components/avatar/avatar.component';
import {VoiceRingRefusalDto} from '../../../../../../dtos/response/voice-ring.dto';
import {ProfileService} from '../../../../../../services/profile.service';
import {VoiceChannelService} from '../../../../../../services/voice-channel.service';
import {VoiceRingService} from '../../../../../../services/voice-ring.service';
import {VoiceRingStateService} from '../../../../../../services/voice-ring-state.service';
import {RelationshipStore} from '../../../../../../stores/relationship.store';
import {InviteCandidate, pickInviteCandidates} from './channel-invite-candidates.util';
import {ChannelInviteRosterService, ChannelRoster} from './channel-invite-roster.service';

/**
 * The five-name shortcut for asking somebody into a voice channel: a quiet invitation (a DM card, no interruption, never expires) and a louder ring (buzzes the phone, lapses in a minute, a decline locks the sender out for hours).
 * The ring is only offered from inside the channel: the server refuses one from anybody who is not, with a bodiless 403.
 * Owns no overlay; the host anchors it (e.g. a popover off the context menu or off the row under your own name).
 */
@Component({
    selector: 'app-channel-invite-panel',
    standalone: true,
    imports: [NgClass, TranslateModule, AppAvatarComponent],
    templateUrl: './channel-invite-panel.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChannelInvitePanelComponent implements OnInit {
    readonly guildId = input.required<string>();
    readonly channelId = input.required<string>();
    readonly channelName = input.required<string>();
    /** Who is already in the room, so they are not offered. */
    readonly alreadyIn = input<readonly string[]>([]);

    /** Search everyone was pressed; the host opens the full picker. */
    readonly more = output<void>();

    protected readonly ringState = inject(VoiceRingStateService);

    private readonly rings = inject(VoiceRingService);
    private readonly rosterService = inject(ChannelInviteRosterService);
    private readonly relationships = inject(RelationshipStore);
    private readonly profileService = inject(ProfileService);
    private readonly voiceChannels = inject(VoiceChannelService);
    private readonly destroyRef = inject(DestroyRef);

    /** Null until the roster read answers, which is exactly the loading state. */
    private readonly roster = signal<ChannelRoster | null>(null);
    /** Who has been sent an invitation since this panel opened. */
    protected readonly invited = signal<ReadonlySet<string>>(new Set());
    /** The one request in flight, so a double click does not send twice. */
    protected readonly inviting = signal<string | null>(null);
    protected readonly refusal = signal<{userId: string; messageKey: string} | null>(null);

    protected readonly loading = computed(() => this.roster() === null);

    /** Derived rather than assigned, so a friend list that lands after the roster still reorders the five names; both reads are in flight at once and either can win. */
    protected readonly candidates = computed<InviteCandidate[]>(() => {
        const roster = this.roster();
        if (!roster) return [];

        return pickInviteCandidates({
            members: roster.members,
            viewers: roster.viewers,
            friendIds: new Set(this.relationships.friends().map(f => f.other.userId)),
            alreadyIn: this.alreadyIn(),
            selfUserId: this.profileService.ownProfile()?.userId ?? '',
        });
    });

    /** Sitting in the room, which is the one thing a ring needs and an invitation does not. */
    protected readonly canRing = computed(() => this.voiceChannels.joinedChannelId() === this.channelId());

    /** A ring already out of this channel. One at a time, so the bells hold still while it stands. */
    protected readonly pendingRing = computed(() =>
        this.ringState.outgoingFor(this.guildId(), this.channelId()),
    );

    /** Loaded once per mount, since the host builds/destroys this panel on open/close. Must be ngOnInit, not the constructor: required inputs aren't set yet there (NG0950). */
    ngOnInit(): void {
        this.relationships.load();
        this.load();
    }

    /** The quiet invitation. Held here rather than in {@link VoiceRingStateService} since there's nothing global to track (no countdown, nothing to take back); its one refusal (recipient not accepting DMs) is shown on their row, not a panel-wide banner. */
    protected invite(candidate: InviteCandidate): void {
        if (this.inviting() || this.invited().has(candidate.userId)) return;

        this.inviting.set(candidate.userId);
        this.refusal.set(null);

        this.rings
            .invite(this.guildId(), this.channelId(), candidate.userId)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
                next: () => {
                    this.inviting.set(null);
                    this.invited.update(sent => new Set(sent).add(candidate.userId));
                },
                error: (err: HttpErrorResponse) => {
                    this.inviting.set(null);
                    this.refusal.set({
                        userId: candidate.userId,
                        messageKey:
                            (err?.error as VoiceRingRefusalDto | null)?.reason === 'RecipientPolicy'
                                ? 'VOICE_RING.INVITE_REFUSED'
                                : 'VOICE_RING.INVITE_FAILED',
                    });
                },
            });
    }

    /** The loud one. Every refusal it has is handled centrally, so this is the whole call. */
    protected ring(candidate: InviteCandidate, event: MouseEvent): void {
        // The bell sits inside the row's own hit area, and ringing must never also send the message.
        event.stopPropagation();
        this.ringState.send(this.guildId(), this.channelId(), candidate.userId);
    }

    private load(): void {
        this.rosterService
            .load(this.guildId(), this.channelId())
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(roster => this.roster.set(roster));
    }
}
