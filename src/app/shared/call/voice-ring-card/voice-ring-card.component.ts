import {ChangeDetectionStrategy, Component, computed, inject} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {Button} from 'primeng/button';
import {AppAvatarComponent} from '../../../components/avatar/avatar.component';
import {ProfileService} from '../../../services/profile.service';
import {VoiceChannelService} from '../../../services/voice-channel.service';
import {IncomingRing, VoiceRingStateService} from '../../../services/voice-ring-state.service';

/**
 * The stack of "come and join me in here" invitations waiting for an answer.
 *
 * <p><b>Inline, never fullscreen.</b> This is not the DM call ring: nobody is on the line waiting,
 * so it gets an ordinary card in the corner rather than the call screen a phone call earns. Two
 * different people can ask you into two different channels at once, so it is a stack - each answered
 * independently, newest first.</p>
 *
 * <p>Accept closes the invitation and then goes through the ordinary join; see
 * {@link VoiceRingStateService.accept}. Decline is deliberately its own obvious button, because it
 * is the only gesture that locks that inviter out - letting the card lapse does not.</p>
 */
@Component({
    selector: 'app-voice-ring-card',
    standalone: true,
    imports: [TranslateModule, Button, AppAvatarComponent],
    templateUrl: './voice-ring-card.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VoiceRingCardComponent {
    protected readonly ringState = inject(VoiceRingStateService);

    private readonly profileService = inject(ProfileService);
    private readonly voiceChannels = inject(VoiceChannelService);

    /**
     * Whether accepting will pull the user out of somewhere they already are.
     *
     * <p>Worth saying on the card: the join endpoint evicts them from their current channel for us,
     * so the move is silent unless this warns about it.</p>
     */
    protected readonly alreadyInVoice = computed(() => !!this.voiceChannels.joinedChannelId());

    /**
     * The inviter's name, resolved from the id rather than read off the frozen copy on the event.
     *
     * <p>`inviterName` on the payload can be null if the profile lookup failed server-side, and is
     * a snapshot besides - a rename between the ring going out and the card being read would show
     * the old one.</p>
     */
    protected name(incoming: IncomingRing): string {
        return (
            this.profileService.getCachedByUserId(incoming.ring.inviterId)?.userName ??
            incoming.ring.inviterName ??
            ''
        );
    }

    protected initial(incoming: IncomingRing): string {
        return (this.name(incoming) || '?').charAt(0).toUpperCase();
    }
}
