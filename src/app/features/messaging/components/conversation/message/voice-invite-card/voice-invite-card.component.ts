import {
    ChangeDetectionStrategy,
    Component,
    computed,
    DestroyRef,
    effect,
    inject,
    input,
    signal,
} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {MessageEmbed} from '../../../../../../dtos/response/message.dto';
import {ProfileService} from '../../../../../../services/profile.service';
import {VoiceChannelService} from '../../../../../../services/voice-channel.service';
import {VoiceRingStateService} from '../../../../../../services/voice-ring-state.service';

/**
 * Anything longer than this and the timer is not scheduled at all.
 *
 * <p>A ring lives sixty seconds. A card claiming to expire in an hour means the sender's clock or
 * ours is wrong, and holding a timer open for it would pin the component alive for that long to
 * flip a state nobody is still looking at. Such a card just renders live until it is scrolled past.</p>
 */
const MAX_TIMER_MS = 5 * 60_000;

/**
 * "Come and join me in here", left in the conversation after the ring itself is gone.
 *
 * <p><b>Why this exists when there is already a ring card.</b> {@link VoiceRingCardComponent} is the
 * live toast: it appears the moment somebody rings, counts down, and is gone inside a minute whether
 * or not anyone looked. This is the durable half - a message the server writes into the two people's
 * DM - and it is read for as long as the conversation exists. Most of the time it is already history
 * by the time anybody sees it, which is why the expired state is the interesting one rather than an
 * edge case.</p>
 *
 * <p><b>Purely presentational, like the other venta cards.</b> Everything it draws is on the embed;
 * there is no fetch on mount and no loading state. {@link EmbedCardComponent} has already checked the
 * server-generated flag, which is what makes the identifiers below safe to act on.</p>
 */
@Component({
    selector: 'app-voice-invite-card',
    standalone: true,
    imports: [TranslateModule],
    templateUrl: './voice-invite-card.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VoiceInviteCardComponent {
    embed = input.required<MessageEmbed>();

    private readonly ringState = inject(VoiceRingStateService);
    private readonly profileService = inject(ProfileService);
    private readonly voiceChannels = inject(VoiceChannelService);
    private readonly destroyRef = inject(DestroyRef);

    /** Flipped by the timer below, so a card that is live when drawn stops being live in place. */
    private readonly lapsed = signal(false);
    private timer: ReturnType<typeof setTimeout> | null = null;

    protected readonly venta = computed(() => this.embed().venta);

    protected readonly guildId = computed(() => this.venta()?.guild_id);
    protected readonly channelId = computed(() => this.venta()?.channel_id);
    protected readonly ringId = computed(() => this.venta()?.ring_id);

    /**
     * The channel's name as it read when the invitation was sent.
     *
     * <p>Falls back to the embed's title, which the server sets to the same string - it is there so
     * a Discord-compatible client that has never heard of this type still renders something legible.</p>
     */
    protected readonly channelName = computed(() =>
        this.venta()?.channel_name || this.embed().title || '');

    /**
     * Whether the ring can still be accepted.
     *
     * <p>Compared against this machine's clock at render time rather than trusted as a stored state.
     * An absolute instant stays right forever; a boolean written at post time would have been wrong
     * within the minute.</p>
     */
    protected readonly live = computed(() => {
        if (this.lapsed() || !this.ringId()) return false;
        const at = this.venta()?.expires_at;
        return !!at && new Date(at).getTime() > Date.now();
    });

    /**
     * An invitation that was never a ring, and therefore never expires.
     *
     * <p><b>The distinction that "no ring id" alone cannot make.</b> A card sent with
     * <c>delivery: Message</c> carries neither a ring nor an expiry, and reading that as "lapsed"
     * would stamp "this invitation has expired" on one that was valid the second it arrived - and
     * stays valid. The absence of <c>expires_at</c> is the signal; a card that <i>had</i> an expiry
     * and is past it is the genuinely lapsed case.</p>
     */
    protected readonly standing = computed(() => !this.venta()?.expires_at);

    /**
     * Whether this is our own invitation, seen from the sending side.
     *
     * <p>The card lands in a conversation, so both people read the same row. Offering the inviter a
     * Join button for the channel they are sitting in - which is the only way they were allowed to
     * send this at all - would be nonsense, so they get the same card without the affordance.</p>
     */
    protected readonly isOwnInvitation = computed(() => {
        const me = this.profileService.ownProfile()?.userId;
        const inviter = this.venta()?.inviter_id;
        return !!me && !!inviter && me === inviter;
    });

    /** Whether joining will pull them out of a channel they are already in. Worth saying. */
    protected readonly willMove = computed(() =>
        !!this.voiceChannels.joinedChannelId()
        && this.voiceChannels.joinedChannelId() !== this.channelId());

    constructor() {
        effect(() => {
            const at = this.venta()?.expires_at;

            if (this.timer !== null) {
                clearTimeout(this.timer);
                this.timer = null;
            }

            if (!at) return;

            const remaining = new Date(at).getTime() - Date.now();
            if (remaining <= 0) {
                this.lapsed.set(true);
                return;
            }

            this.lapsed.set(false);
            if (remaining > MAX_TIMER_MS) return;
            this.timer = setTimeout(() => this.lapsed.set(true), remaining);
        });

        this.destroyRef.onDestroy(() => {
            if (this.timer !== null) clearTimeout(this.timer);
        });
    }

    /**
     * Accepts the ring, which closes the invitation and then joins.
     *
     * <p>Only reachable while {@link live}. Past the expiry the ring no longer exists and this would
     * answer `409` - {@link joinAnyway} is the honest affordance there, and it accepts nothing.</p>
     */
    protected accept(): void {
        const ringId = this.ringId();
        if (!ringId || !this.live()) return;
        this.ringState.accept(ringId);
    }

    /**
     * Walks into the channel without answering anything.
     *
     * <p>What an expired card offers, and deliberately not dressed up as accepting a minute-old
     * invitation. It is the same join as clicking the channel in the sidebar, subject to the same
     * permission check - so it correctly fails for somebody who has since lost access.</p>
     */
    protected joinAnyway(): void {
        const guildId = this.guildId();
        const channelId = this.channelId();
        if (!guildId || !channelId) return;
        this.ringState.joinVoiceChannel(guildId, channelId);
    }
}
