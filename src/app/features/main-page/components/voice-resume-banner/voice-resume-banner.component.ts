import {Component, computed, inject} from '@angular/core';
import {TranslatePipe, TranslateService} from '@ngx-translate/core';
import {VoiceResumeService} from '../../../../services/voice-resume.service';

/**
 * "You were connected to a voice channel, do you want to reconnect?"
 *
 * <p>Shown once per launch, for a room this client was force-quit or crashed out of. See
 * {@link VoiceResumeService} for where the offer comes from and why declining sends a real
 * leave.</p>
 *
 * <p>Green, unlike its neighbour {@link AccountDeletionBannerComponent}: this is an offer, not a
 * warning, and the two sit in the same slot at the top of the shell.</p>
 */
@Component({
    selector: 'app-voice-resume-banner',
    imports: [TranslatePipe],
    templateUrl: './voice-resume-banner.component.html',
})
export class VoiceResumeBannerComponent {
    protected readonly resume = inject(VoiceResumeService);
    private readonly translate = inject(TranslateService);

    /**
     * The sentence to show.
     *
     * <p>Named where the server gave us a name. A channel whose name we do not have is still worth
     * offering back - the seat is real either way - so the unnamed wording is a fallback rather
     * than a reason to stay silent.</p>
     */
    protected readonly message = computed(() => {
        const offer = this.resume.offer();
        if (!offer) return '';
        if (offer.kind === 'call') return this.translate.instant('VOICE.RESUME.CALL');
        return offer.channelName
            ? this.translate.instant('VOICE.RESUME.CHANNEL_NAMED', {channel: offer.channelName})
            : this.translate.instant('VOICE.RESUME.CHANNEL');
    });
}
