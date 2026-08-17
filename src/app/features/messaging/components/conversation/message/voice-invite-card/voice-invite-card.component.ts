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

/** Anything longer than this and the timer is not scheduled at all. */
const MAX_TIMER_MS = 5 * 60_000;

/** "Come and join me in here", left in the conversation after the ring itself is gone. */
@Component({
    selector: 'app-voice-invite-card',
    standalone: true,
    imports: [TranslateModule],
    templateUrl: './voice-invite-card.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VoiceInviteCardComponent {
    readonly embed = input.required<MessageEmbed>();

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

    /** The channel's name as it read when the invitation was sent. */
    protected readonly channelName = computed(() =>
        this.venta()?.channel_name || this.embed().title || '');

    /** Whether the ring can still be accepted. */
    protected readonly live = computed(() => {
        if (this.lapsed() || !this.ringId()) return false;
        const at = this.venta()?.expires_at;
        return !!at && new Date(at).getTime() > Date.now();
    });

    /** An invitation that was never a ring, and therefore never expires. */
    protected readonly standing = computed(() => !this.venta()?.expires_at);

    /** Whether this is our own invitation, seen from the sending side. */
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

    /** Accepts the ring, which closes the invitation and then joins. */
    protected accept(): void {
        const ringId = this.ringId();
        if (!ringId || !this.live()) return;
        this.ringState.accept(ringId);
    }

    /** Walks into the channel without answering anything. */
    protected joinAnyway(): void {
        const guildId = this.guildId();
        const channelId = this.channelId();
        if (!guildId || !channelId) return;
        this.ringState.joinVoiceChannel(guildId, channelId);
    }
}
