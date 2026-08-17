import {effect, inject, Injectable, OnDestroy, signal, untracked} from '@angular/core';
import {VoiceChannelService} from './voice-channel.service';

/** How long the row waits to be noticed. */
export const INVITE_NUDGE_MS = 15_000;

/** How long joining takes to settle before the row appears at all. Also buys the roster a beat to fill in, so {@link InviteNudgeService.arm} re-checks when the wait is up rather than trusting the count it saw on the way in. */
export const INVITE_NUDGE_DELAY_MS = 1_000;

/** Whether the "Invite friends" row is showing, and under which voice channel. It arms on joining, not on being alone. */
@Injectable({providedIn: 'root'})
export class InviteNudgeService implements OnDestroy {
    /** The channel currently showing the row, or `null` for none. */
    readonly channelId = signal<string | null>(null);

    private readonly voice = inject(VoiceChannelService);
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor() {
        // Joining raises it; leaving, or being moved, takes it down with the room it belonged to.
        effect(() => {
            const joined = this.voice.joinedChannelId();
            untracked(() => joined ? this.arm(joined) : this.dismiss());
        });

        // Somebody arrived, so the question the row was asking has been answered. A room that fills during the opening wait is caught by arm()'s own re-check instead.
        effect(() => {
            const nudging = this.channelId();
            if (!nudging) return;

            const others = this.voice.channelParticipants().get(nudging)?.length ?? 0;
            if (others > 1) untracked(() => this.dismiss());
        });
    }

    ngOnDestroy(): void {
        this.clearTimer();
    }

    /** Stops the countdown, because the row was used for what it is for. The panel is open over it, so from here the row stays until they leave or somebody arrives. */
    keep(): void {
        this.clearTimer();
    }

    dismiss(): void {
        this.clearTimer();
        this.channelId.set(null);
    }

    /** Two waits back to back: {@link INVITE_NUDGE_DELAY_MS} before the row appears, then {@link INVITE_NUDGE_MS} before it goes again. One field holds both, so re-arming cancels whichever is running. */
    private arm(channelId: string): void {
        this.clearTimer();
        // Cleared, not left alone: joining a second channel must take the first one's row down now.
        this.channelId.set(null);

        this.timer = setTimeout(() => {
            this.timer = null;

            // Re-checked here rather than on the way in: a second after the join is the first moment the roster count can be trusted.
            if ((this.voice.channelParticipants().get(channelId)?.length ?? 0) > 1) return;

            this.channelId.set(channelId);
            this.timer = setTimeout(() => {
                this.timer = null;
                this.channelId.set(null);
            }, INVITE_NUDGE_MS);
        }, INVITE_NUDGE_DELAY_MS);
    }

    private clearTimer(): void {
        if (this.timer === null) return;
        clearTimeout(this.timer);
        this.timer = null;
    }
}
