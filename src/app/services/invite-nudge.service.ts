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

        // Somebody arrived, so the question the row was asking has been answered. This also covers
        // joining a room that already has people in it: the count is above one on the first pass.
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

    private arm(channelId: string): void {
        this.clearTimer();
        this.channelId.set(channelId);
        this.timer = setTimeout(() => {
            this.timer = null;
            this.channelId.set(null);
        }, INVITE_NUDGE_MS);
    }

    private clearTimer(): void {
        if (this.timer === null) return;
        clearTimeout(this.timer);
        this.timer = null;
    }
}
