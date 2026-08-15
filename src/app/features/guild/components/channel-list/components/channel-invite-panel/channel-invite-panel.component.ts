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
 * The five-name shortcut for asking somebody into a voice channel.
 *
 * <p><b>The same two acts as {@link VoiceRingPickerComponent}, in the same order of loudness.</b>
 * The row sends the quiet invitation - a card in the two people's conversation, which interrupts
 * nobody, expires never, and is what somebody means by "invite them" almost every time. The small
 * bell beside it rings: it buzzes a phone, it lapses inside a minute, and a decline locks the sender
 * out for hours, so it is deliberately not the thing you hit by aiming at a name.</p>
 *
 * <p><b>The bell is only offered from inside the channel.</b> A ring's whole claim is "I am in here,
 * come and join me", and the server refuses one from anybody who is not - with a bodiless `403` that
 * says nothing worth showing. The quiet invitation carries no such claim and needs no such rule,
 * which is what lets this panel hang off a channel you are merely looking at.</p>
 *
 * <p>This owns no overlay. The host anchors it - a popover off the context menu, a popover off the
 * row under your own name - because those two want different anchors and the same body.</p>
 */
@Component({
    selector: 'app-channel-invite-panel',
    standalone: true,
    imports: [NgClass, TranslateModule, AppAvatarComponent],
    templateUrl: './channel-invite-panel.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChannelInvitePanelComponent implements OnInit {
    guildId = input.required<string>();
    channelId = input.required<string>();
    channelName = input.required<string>();
    /** Who is already in the room, so they are not offered. */
    alreadyIn = input<readonly string[]>([]);

    /** Search everyone was pressed - the host opens the full picker. */
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

    /**
     * Derived rather than assigned, so a friend list that lands after the roster still reorders the
     * five names. Both reads are in flight at once when the panel opens and either can win.
     */
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
    protected readonly canRing = computed(() =>
        this.voiceChannels.joinedChannelId() === this.channelId());

    /** A ring already out of this channel. One at a time, so the bells hold still while it stands. */
    protected readonly pendingRing = computed(() =>
        this.ringState.outgoingFor(this.guildId(), this.channelId()));

    /**
     * Loaded once per mount rather than on a visibility input: the host builds this panel when it
     * opens it and destroys it when it closes, so a mount is exactly one opening.
     *
     * <p>In `ngOnInit` and not the constructor, because the reads below need the required inputs and
     * those are only set once the instance exists. Asking for one a moment earlier is `NG0950`.</p>
     */
    ngOnInit(): void {
        this.relationships.load();
        this.load();
    }

    /**
     * The quiet invitation, and what a row does.
     *
     * <p>Held here rather than in {@link VoiceRingStateService} because there is nothing global to
     * hold - no ring exists, nothing counts down and nothing can be taken back. It is one request,
     * and then it is finished.</p>
     *
     * <p>Its one refusal is about the two people rather than the channel: the recipient may not
     * accept direct messages from this sender, which is ordinary rather than exceptional when the
     * product default is friends-only. Said on their row, not in a banner over the whole panel.</p>
     */
    protected invite(candidate: InviteCandidate): void {
        if (this.inviting() || this.invited().has(candidate.userId)) return;

        this.inviting.set(candidate.userId);
        this.refusal.set(null);

        this.rings.invite(this.guildId(), this.channelId(), candidate.userId)
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
                        messageKey: (err?.error as VoiceRingRefusalDto | null)?.reason === 'RecipientPolicy'
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
        this.rosterService.load(this.guildId(), this.channelId())
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(roster => this.roster.set(roster));
    }
}
