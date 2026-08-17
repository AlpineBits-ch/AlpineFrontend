import {computed, inject, Injectable, signal} from '@angular/core';
import {catchError, firstValueFrom, forkJoin, of} from 'rxjs';
import {GuildVoiceService, VoiceStateDto} from './guild-voice.service';
import {VoiceService} from './voice.service';
import {VoiceChannelService} from './voice-channel.service';
import {GuildService} from './guild.service';
import {DeviceIdentityService} from './device-identity.service';
import {OngoingCallDto} from '../dtos/response/ongoing-call.dto';

/** A room this client was in when it went away, and can be put back into. */
export type VoiceResumeOffer =
    | {
          kind: 'channel';
          guildId: string;
          channelId: string;
          channelName: string | null;
          /** The device the roster holds the seat for. See {@link VoiceResumeService.reconnect}. */
          deviceId: string | null;
      }
    | {kind: 'call'; callId: string; conversationId: string};

/**
 * "You were in a voice room when this app last went away - do you want to go back?"
 *
 * <p>Force-quitting or crashing skips the leave path entirely, and the two room kinds fail
 * differently afterwards. A <b>guild channel seat outlives the client</b>: nothing but the server's
 * eviction sweep removes a participant, so the reopened app is still on the roster and everybody
 * else is looking at a ghost until it says otherwise. A <b>call is hung up as the socket drops</b>,
 * so there is no stale seat - only, sometimes, a call that carried on without us.</p>
 *
 * <p>Which is why declining matters as much as accepting. Dismissing a channel offer sends a real
 * leave: it is the only thing that releases the seat now rather than up to a sweep interval from
 * now, so the banner is the fix for the stale presence rather than a remark about it.</p>
 *
 * <p><b>Asked once per launch, never on reconnect.</b> This is a question about what happened while
 * the app was not running. Re-asking it whenever the socket blinks would offer to rejoin a room the
 * user is already sitting in.</p>
 */
@Injectable({providedIn: 'root'})
export class VoiceResumeService {
    private readonly guildVoice = inject(GuildVoiceService);
    private readonly voice = inject(VoiceService);
    private readonly voiceChannel = inject(VoiceChannelService);
    private readonly guilds = inject(GuildService);
    private readonly devices = inject(DeviceIdentityService);

    private readonly offerSignal = signal<VoiceResumeOffer | null>(null);
    private readonly busySignal = signal(false);
    private asked = false;

    /** A reconnect in flight, so the banner's buttons can stop inviting a second one. */
    readonly busy = this.busySignal.asReadonly();

    /**
     * What to offer, or null.
     *
     * <p>Suppressed while this client is in a voice channel. Joining one from the sidebar before
     * getting round to the banner answers the question by doing, and a second window or another
     * device that is live makes the offer wrong rather than merely redundant.</p>
     */
    readonly offer = computed<VoiceResumeOffer | null>(() =>
        this.voiceChannel.isInVoice() ? null : this.offerSignal(),
    );

    /**
     * Asks the server where it places this client, once.
     *
     * <p>Both reads go out together and neither is allowed to fail the other: they are answered by
     * different services, so a guild outage must not cost the call answer or the other way round.
     * Every failure is swallowed to null - there is no banner to show for a question that could not
     * be asked, and nothing here is worth a toast.</p>
     *
     * <p>The channel wins a tie. Both cannot be true of a well-behaved server, and if they somehow
     * are, the channel is the one carrying a seat that other people can see.</p>
     */
    check(): void {
        if (this.asked) return;
        this.asked = true;

        forkJoin({
            channel: this.guildVoice.getVoiceState().pipe(catchError(() => of(null))),
            call: this.voice.getActiveCall().pipe(catchError(() => of(null))),
        }).subscribe(({channel, call}) => this.offerSignal.set(toOffer(channel, call)));
    }

    /** Takes the banner down without touching the server. The two answers below do that themselves. */
    clear(): void {
        this.offerSignal.set(null);
    }

    /**
     * Goes back into the room the offer named.
     *
     * <p>Through the ordinary authorised path in both cases - {@link VoiceChannelService.joinChannel}
     * and {@link VoiceService.acceptCall} - never by asserting we are still there. The server
     * refuses to re-admit anybody on their own say-so, and it is right to: a seat held by somebody
     * since kicked, banned, or denied Connect is exactly the one this banner would otherwise hand
     * back. A refusal is reported by the join path itself.</p>
     *
     * <p>The banner comes down first either way. The offer has been answered; if the rejoin fails,
     * what the user needs is the error the join path raises, not a banner still asking.</p>
     *
     * <p><b>The seat is released before it is taken again.</b> A join by somebody already on the
     * roster refreshes their device and nothing else, so every trace of the session that went away
     * survives it: the media session id, the track names, the screen shares nobody closed, the
     * original join time the video cap ranks by, and this user's entry in the room's attention
     * state. Peers are still subscribed to tracks that no longer exist and are never told
     * otherwise. Only a leave clears any of it.</p>
     */
    async reconnect(): Promise<void> {
        const offer = this.offerSignal();
        if (!offer || this.busySignal()) return;

        this.busySignal.set(true);
        this.clear();
        try {
            if (offer.kind === 'call') {
                await firstValueFrom(this.voice.acceptCall(offer.callId));
                return;
            }

            await this.releaseOwnSeat(offer);

            // Read the guild rather than synthesising a channel from the three fields the offer
            // carries. joinChannel wants the real thing and the real guild name - it puts both on
            // the status bar - and a hand-built stand-in would be a second, quietly diverging idea
            // of what a channel is.
            const guild = await firstValueFrom(this.guilds.getGuild(offer.guildId));
            const channel = guild.channels.find(c => c.id === offer.channelId);
            if (!channel) return;

            await this.voiceChannel.joinChannel(channel, guild.name);
        } catch (err) {
            console.error('Could not rejoin the voice room this session was dropped from', err);
        } finally {
            this.busySignal.set(false);
        }
    }

    /**
     * Drops the ghost seat so the rejoin starts from an empty roster entry.
     *
     * <p>Only when the roster holds it for this device. A seat under another device id is this
     * user's phone or second machine, and it is live rather than stale: leaving on its behalf takes
     * it off the roster with nothing sent to tell it, where the join transfers it and sends
     * `KickedByOtherDevice`. A device id we cannot read is treated as somebody else's.</p>
     *
     * <p>A failed leave is logged and not retried. It leaves the rejoin exactly where it was before
     * this ran, which is worth having anyway.</p>
     */
    private async releaseOwnSeat(offer: VoiceResumeOffer & {kind: 'channel'}): Promise<void> {
        const ours = await this.devices.deviceId().catch(() => null);
        if (offer.deviceId && offer.deviceId !== ours) return;

        try {
            await firstValueFrom(this.guildVoice.leave(offer.guildId, offer.channelId));
        } catch (err) {
            console.error('Could not release the voice seat the last session left behind', err);
        }
    }

    /**
     * Releases the seat the offer named.
     *
     * <p>Only meaningful for a channel: a call was already hung up by the disconnect that ended the
     * last session, so declining one is nothing but taking the banner down.</p>
     *
     * <p>Fire and forget. The user has said they are not going back, and a failed leave leaves them
     * exactly where the sweep would have found them anyway - so there is nothing to report and
     * nothing to retry.</p>
     */
    dismiss(): void {
        const offer = this.offerSignal();
        this.clear();
        if (offer?.kind !== 'channel') return;

        this.guildVoice.leave(offer.guildId, offer.channelId).subscribe({
            next: () => void 0,
            error: () => void 0,
        });
    }
}

/**
 * Picks what to offer from the two answers.
 *
 * <p>Split out so the precedence is testable without a live injector, and so it reads as the one
 * decision it is.</p>
 */
export function toOffer(channel: VoiceStateDto | null, call: OngoingCallDto | null): VoiceResumeOffer | null {
    if (channel) {
        return {
            kind: 'channel',
            guildId: channel.guildId,
            channelId: channel.channelId,
            channelName: channel.channelName,
            deviceId: channel.deviceId,
        };
    }
    if (call) return {kind: 'call', callId: call.callId, conversationId: call.conversationId};
    return null;
}
