import {Component, computed, inject} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {VoiceChannelService} from '../../../../services/voice-channel.service';
import {CallSessionService} from '../../../../services/call-session.service';
import {CallWebRtcService} from '../../../../services/call-webrtc.service';
import {RustMediaService} from '../../../../services/rust-media.service';
import {ConversationStore} from '../../../../stores/conversation.store';
import {NavigationService} from '../../navigation.service';
import {CallStatus, resolveCallStatus} from '../../../../shared/call/call-status';
import {CallLiveBadgeComponent} from '../../../../shared/call/call-live-badge/call-live-badge.component';

@Component({
    selector: 'app-voice-status-bar',
    imports: [TranslateModule, CallLiveBadgeComponent],
    templateUrl: './voice-status-bar.component.html',
})
export class VoiceStatusBarComponent {
    protected voiceSvc = inject(VoiceChannelService);
    protected callSession = inject(CallSessionService);
    /**
     * Injected directly rather than wrapped: `publishPreview()` is read straight off the service on
     * every render, never copied into a field or a signal of our own. Task 10 pauses stale preview
     * frames by invalidating this signal at the source - a locally cached copy of the string would
     * be a second place that decision could not reach.
     */
    protected rustMedia = inject(RustMediaService);
    private callWebRtc = inject(CallWebRtcService);
    private conversationStore = inject(ConversationStore);
    private navService = inject(NavigationService);

    /**
     * Two call surfaces feed this bar and only one is ever live at a time - a DM call ends before
     * guild voice can be joined, and joining a guild channel ends any DM call first. Guild voice is
     * checked first because it is the surface this bar originally shipped for; `CallSessionService`
     * is only consulted once that is false, so the two shapes never have to be reconciled into one
     * type - every other member here just asks "which one is live" and branches once.
     */
    protected readonly isGuildVoice = computed(() => this.voiceSvc.isInVoice());
    protected readonly isDmCall = computed(() => !this.isGuildVoice() && this.callSession.session() !== null);
    protected readonly isActive = computed(() => this.isGuildVoice() || this.isDmCall());

    /**
     * The same resolver the in-call status row uses, so the sidebar cannot end up describing the
     * connection differently from the call it is a shortcut to. Sourced from whichever surface is
     * live, so a DM call is reported as accurately as guild voice rather than assumed connected.
     *
     * <p>Only the healthy label differs: "Voice connected" says which of several things is
     * connected, which matters in a sidebar and does not inside the call itself. The failure
     * banner this bar used to stack above itself is gone - the row is already red and pulsing, and
     * the detail sentence belongs in the call view where there is room to read it.</p>
     */
    protected readonly callStatus = computed((): CallStatus => {
        const rtcState = this.isGuildVoice() ? this.voiceSvc.rtcState() : this.callWebRtc.rtcState();
        const status = resolveCallStatus({rtcState, stalledAudio: false, aloneUntil: null});
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

    /**
     * True while this client's own screen is going out, on whichever surface is active.
     *
     * <p>This is the only place outside the call view itself that can answer that question - see
     * `CallScreenLayoutComponent.selfCard`, which goes null the moment nobody else is sharing and
     * stops saying anything at all once the call view is navigated away from.</p>
     */
    protected readonly isSharing = computed(() => this.isGuildVoice()
        ? this.voiceSvc.localState().isScreenSharing
        : (this.callSession.session()?.local.isSharing ?? false));

    /**
     * The other participant(s) in a DM call - the label a guild channel gets for free from its own
     * name. Joined the same way `CallStateService.resolveCallInfo` names an incoming group call,
     * so a DM call with more than two people reads consistently wherever a peer name is shown.
     */
    protected readonly dmPeerName = computed(() => {
        const others = this.callSession.session()?.participants.filter(p => !p.isLocal) ?? [];
        return others.map(p => p.displayName).join(', ');
    });

    /** Jumps back to whichever surface is active - the guild channel, or the DM conversation. */
    protected navigate(): void {
        if (this.isGuildVoice()) {
            this.navigateToChannel();
            return;
        }
        const conversationId = this.callSession.session()?.conversationId;
        if (!conversationId) return;
        const conversation = this.conversationStore.entities().find(c => c.id === conversationId);
        if (conversation) this.navService.openConversation(conversation);
    }

    private navigateToChannel(): void {
        const workspace = this.navService.workspace();
        if (workspace.type !== 'server') return;
        const channelId = this.voiceSvc.joinedChannelId();
        if (!channelId) return;
        const channel = workspace.guild.channels.find(c => c.id === channelId);
        if (channel) this.navService.openChannel(channel);
    }

    /** Ends whichever surface is active. */
    protected disconnect(): void {
        if (this.isGuildVoice()) void this.voiceSvc.leaveChannel();
        else this.callSession.end();
    }

    /**
     * `VOICE_BAR.DISCONNECT` says "Disconnect from voice **channel**" in German and French, not just
     * in English. Correct for guild voice, which has a channel; wrong for a DM call, which does not
     * - a DM user told to disconnect from a channel is being told about something that is not in
     * their UI. `CALL.DISCONNECT` is the existing, locale-neutral "Disconnect" for that branch.
     */
    protected readonly disconnectLabelKey = computed(() =>
        this.isGuildVoice() ? 'VOICE_BAR.DISCONNECT' : 'CALL.DISCONNECT');

    /**
     * Stops the local screen share through the same path the in-call controls bar uses. There is
     * exactly one stop-sharing control in the whole app now, this button included - Task 8's
     * mini-player must not grow a second one.
     */
    protected stopSharing(): void {
        if (this.isGuildVoice()) void this.voiceSvc.toggleScreenShare();
        else void this.callSession.toggleScreenShare();
    }
}
