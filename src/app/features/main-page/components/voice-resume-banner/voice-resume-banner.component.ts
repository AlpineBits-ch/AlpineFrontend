import {Component, computed, inject} from '@angular/core';
import {TranslatePipe, TranslateService} from '@ngx-translate/core';
import {VoiceResumeService} from '../../../../services/voice-resume.service';

/** "You were connected to a voice channel, do you want to reconnect?" */
@Component({
    selector: 'app-voice-resume-banner',
    imports: [TranslatePipe],
    templateUrl: './voice-resume-banner.component.html',
})
export class VoiceResumeBannerComponent {
    protected readonly resume = inject(VoiceResumeService);
    private readonly translate = inject(TranslateService);

    /** The sentence to show. */
    protected readonly message = computed(() => {
        const offer = this.resume.offer();
        if (!offer) return '';
        if (offer.kind === 'call') return this.translate.instant('VOICE.RESUME.CALL');
        return offer.channelName
            ? this.translate.instant('VOICE.RESUME.CHANNEL_NAMED', {channel: offer.channelName})
            : this.translate.instant('VOICE.RESUME.CHANNEL');
    });
}
