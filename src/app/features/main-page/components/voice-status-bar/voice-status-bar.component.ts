import {Component, inject} from '@angular/core';
import {VoiceChannelService} from '../../../../services/voice-channel.service';
import {NavigationService} from '../../navigation.service';
import {TranslateModule} from '@ngx-translate/core';

@Component({
    selector: 'app-voice-status-bar',
    imports: [TranslateModule],
    templateUrl: './voice-status-bar.component.html',
})
export class VoiceStatusBarComponent {
    protected voiceSvc = inject(VoiceChannelService);
    private navService = inject(NavigationService);

    protected navigateToChannel(): void {
        const workspace = this.navService.workspace();
        if (workspace.type !== 'server') return;
        const channelId = this.voiceSvc.joinedChannelId();
        if (!channelId) return;
        const channel = workspace.guild.channels.find(c => c.id === channelId);
        if (channel) this.navService.openChannel(channel);
    }
}
