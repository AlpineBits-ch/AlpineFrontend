import {Component, computed, inject} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {VoiceChannelService} from '../../../../services/voice-channel.service';
import {NavigationService} from '../../navigation.service';
import {CallStatus, resolveCallStatus} from '../../../../shared/call/call-status';

@Component({
    selector: 'app-voice-status-bar',
    imports: [TranslateModule],
    templateUrl: './voice-status-bar.component.html',
})
export class VoiceStatusBarComponent {
    protected voiceSvc = inject(VoiceChannelService);
    private navService = inject(NavigationService);

    /**
     * The same resolver the in-call status row uses, so the sidebar cannot end up describing the
     * connection differently from the call it is a shortcut to.
     *
     * <p>Only the healthy label differs: "Voice connected" says which of several things is
     * connected, which matters in a sidebar and does not inside the call itself. The failure
     * banner this bar used to stack above itself is gone - the row is already red and pulsing, and
     * the detail sentence belongs in the call view where there is room to read it.</p>
     */
    protected readonly callStatus = computed((): CallStatus => {
        const status = resolveCallStatus({
            rtcState: this.voiceSvc.rtcState(),
            stalledAudio: false,
            aloneUntil: null,
        });
        return status.kind === 'connected'
            ? {...status, labelKey: 'VOICE_BAR.VOICE_CONNECTED'}
            : status;
    });

    protected readonly labelClass = computed(() => {
        const tone = this.callStatus().tone;
        if (tone === 'error') return 'text-offline';
        return tone === 'warn' ? 'text-connecting' : 'text-online';
    });

    protected readonly dotClass = computed(() => {
        const tone = this.callStatus().tone;
        const colour = tone === 'error' ? 'bg-offline' : tone === 'warn' ? 'bg-connecting' : 'bg-online';
        const pulse = tone === 'error' ? 'status-pulse status-pulse--urgent' : tone === 'warn' ? 'status-pulse' : '';
        return `size-2 shrink-0 rounded-full ${colour} ${pulse}`;
    });

    protected navigateToChannel(): void {
        const workspace = this.navService.workspace();
        if (workspace.type !== 'server') return;
        const channelId = this.voiceSvc.joinedChannelId();
        if (!channelId) return;
        const channel = workspace.guild.channels.find(c => c.id === channelId);
        if (channel) this.navService.openChannel(channel);
    }
}
