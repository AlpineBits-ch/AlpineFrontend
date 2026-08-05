import {ChangeDetectionStrategy, Component, computed, inject} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {primaryActivity} from '../../../../models/activity.model';
import {UserActivityService} from '../../../../services/user-activity.service';
import {ConnectionState, MessagingWebsocketService} from '../../../../services/messaging-websocket.service';
import {VoiceChannelService} from '../../../../services/voice-channel.service';
import {ScreenPickerService} from '../../../../services/screen-picker.service';
import {BrokenImageService} from '../../../../services/broken-image.service';

/**
 * What you are playing, and the offer to show it to the room.
 *
 * <p>Its own card rather than a row in the user strip below. A title like "Microsoft Flight
 * Simulator 2024" cannot share a line with an avatar and four buttons inside a 240px panel, and
 * separating the two by elevation rather than by a rule is what stops the footer reading as a
 * table.</p>
 *
 * <p><b>Renders nothing unless the socket is up.</b> A "playing X" line sitting over a dead
 * connection is telling the user about their machine when the thing they need to know is about the
 * app — and the line is stale by definition, since nothing is arriving to refresh it.</p>
 */
@Component({
    selector: 'app-self-activity-card',
    imports: [TranslateModule],
    templateUrl: './self-activity-card.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SelfActivityCardComponent {
    protected readonly voiceSvc = inject(VoiceChannelService);

    private readonly userActivity = inject(UserActivityService);
    private readonly websocket = inject(MessagingWebsocketService);
    private readonly picker = inject(ScreenPickerService);
    private readonly brokenImages = inject(BrokenImageService);

    protected readonly ownActivity = computed(() =>
        this.websocket.connectionState() === ConnectionState.Connected
            ? primaryActivity(this.userActivity.own())
            : null
    );

    /**
     * Cover art, when there is any.
     *
     * <p>`assets` is null on everything the server sends today — the image proxy that rewrites
     * these away from Discord's CDN is still to come. So the monogram tile below is the design
     * rather than a placeholder, sized and shaped so that a real URL arriving later is a swap and
     * not a re-layout.</p>
     */
    protected readonly artUrl = computed(() => {
        const url = this.ownActivity()?.assets?.largeImageUrl;
        if (!url) return null;
        return this.brokenImages.isBroken(url) ? null : url;
    });

    /** As much identity as a name alone can carry, for when there is no art. */
    protected readonly monogram = computed(() =>
        this.ownActivity()?.name?.trim()?.[0]?.toUpperCase() ?? '?'
    );

    /**
     * Whether this game is currently on screen for the room.
     *
     * <p>Approximate on purpose: the voice service knows a share is running, not which window it is
     * of. Claiming "Sharing" while the user is actually sharing a browser is a small lie, but the
     * alternative — plumbing the captured source id back through the publish path just to label one
     * line — buys precision nobody is reading this line for.</p>
     */
    protected readonly isSharing = computed(() => this.voiceSvc.localState().isScreenSharing);

    protected readonly canShare = computed(() => this.voiceSvc.isInVoice());

    protected readonly shareTooltipKey = computed(() => {
        if (!this.canShare()) return 'ACTIVITY.SHARE_NEEDS_VOICE';
        return this.isSharing() ? 'ACTIVITY.STOP_SHARING' : 'ACTIVITY.SHARE';
    });

    protected onArtError(url: string): void {
        this.brokenImages.markBroken(url);
    }

    protected onShare(): void {
        const activity = this.ownActivity();
        if (!activity || !this.canShare()) return;

        // Only on the way in. Stopping a share opens no picker, and leaving a preference behind
        // would arm the *next* picker with a stale name.
        if (!this.isSharing()) this.picker.preferSourceFor(activity.name);

        void this.voiceSvc.toggleScreenShare();
    }
}
