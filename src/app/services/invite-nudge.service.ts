import {effect, inject, Injectable, OnDestroy, signal, untracked} from '@angular/core';
import {VoiceChannelService} from './voice-channel.service';

/**
 * How long the row waits to be noticed.
 *
 * <p>Long enough to read and reach, short enough that it is gone before it becomes furniture. The
 * row is a nudge at one moment - you walked into an empty room - and a nudge that stays is just a
 * list item nobody asked for.</p>
 */
export const INVITE_NUDGE_MS = 15_000;

/**
 * How long joining takes to settle before the row appears at all.
 *
 * <p>Joining a channel already redraws half the window at once: the roster opens under the channel,
 * your own name lands in it, the stage and the control bar come up. A row arriving inside that same
 * frame is just one more thing in a burst, and it read as part of the furniture rather than as an
 * offer. Letting the room settle first and then opening it is what makes it read as a nudge.</p>
 *
 * <p>It also buys the roster a beat to fill in. A channel with people already in it often reports
 * them a moment after the join itself, and this wait is long enough that the row is never raised for
 * a room that turns out not to be empty - see {@link InviteNudgeService.arm}, which re-checks when
 * the wait is up rather than trusting the count it saw on the way in.</p>
 */
export const INVITE_NUDGE_DELAY_MS = 1_000;

/**
 * Whether the "Invite friends" row is showing, and under which voice channel.
 *
 * <p><b>Why this is a service and not state inside the row.</b> Three unrelated things end the
 * nudge - somebody walks in, fifteen seconds pass, you leave - and only one of them is anything the
 * row can see. Holding it here keeps the row a plain button and puts the four rules somewhere they
 * can be tested without a DOM.</p>
 *
 * <p><b>It arms on joining, not on being alone.</b> Everybody leaving a room you are already in
 * does not raise it again: the prompt answers "you just arrived and there is nobody here", and by
 * then you have been sitting in that channel with the sidebar open the whole time.</p>
 */
@Injectable({providedIn: 'root'})
export class InviteNudgeService implements OnDestroy {
    /** The channel currently showing the row, or `null` for none. */
    readonly channelId = signal<string | null>(null);

    private readonly voice = inject(VoiceChannelService);
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor() {
        // Joining raises it; leaving - or being moved - takes it down with the room it belonged to.
        effect(() => {
            const joined = this.voice.joinedChannelId();
            untracked(() => joined ? this.arm(joined) : this.dismiss());
        });

        // Somebody arrived, so the question the row was asking has been answered. This covers the
        // row that is already up; a room that fills during the opening wait is caught by arm()'s
        // own re-check, which is what keeps the row from appearing for a beat and then vanishing.
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

    /**
     * Stops the countdown, because the row was used for what it is for.
     *
     * <p>The panel is open over it at this point. Pulling the row out from under an open panel to
     * satisfy a timer would close the thing somebody is in the middle of reading, so from here it
     * stays until they leave or somebody arrives.</p>
     */
    keep(): void {
        this.clearTimer();
    }

    dismiss(): void {
        this.clearTimer();
        this.channelId.set(null);
    }

    /**
     * Two waits, back to back: {@link INVITE_NUDGE_DELAY_MS} before the row appears, then
     * {@link INVITE_NUDGE_MS} before it goes again. One field holds both, so re-arming or leaving
     * cancels whichever of the two is running without either having to know about the other.
     */
    private arm(channelId: string): void {
        this.clearTimer();
        // Cleared, not left alone: joining a second channel while the first one's row is up must
        // take that row down now rather than leave it hanging under the room you walked out of.
        this.channelId.set(null);

        this.timer = setTimeout(() => {
            this.timer = null;

            // Re-checked here rather than on the way in. The count is what the roster reports now,
            // a second after the join, which is the first moment it can be trusted - and if
            // somebody was already here, or walked in during the wait, the question the row asks
            // has been answered and it never appears at all.
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
