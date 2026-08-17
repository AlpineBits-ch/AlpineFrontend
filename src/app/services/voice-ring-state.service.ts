import {computed, effect, inject, Injectable, OnDestroy, signal, untracked} from '@angular/core';
import {HttpErrorResponse} from '@angular/common/http';
import {TranslateService} from '@ngx-translate/core';
import {ChannelType} from '../dtos/response/guild.dto';
import {
    VoiceRingDto,
    VoiceRingRefusalDto,
    VoiceRingRefusalReason,
    VoiceRingRefusalReasonValue,
    VoiceRingReason,
    VoiceRingStatus,
    WsVoiceRing,
} from '../dtos/response/voice-ring.dto';
import {ConnectionState, RealtimeConnectionService} from './realtime-connection.service';
import {DeviceIdentityService} from './device-identity.service';
import {GuildService} from './guild.service';
import {GuildWebsocketService} from './guild-websocket.service';
import {ProfileService} from './profile.service';
import {ToastService} from './toast.service';
import {VoiceChannelService} from './voice-channel.service';
import {VoiceRingService} from './voice-ring.service';

/** One invitation waiting for an answer on this device. */
export interface IncomingRing {
    ring: WsVoiceRing;
    /** Seconds left, ticked locally from `expiresInSeconds` - never from `expiresAt`. */
    secondsLeft: number;
}

/** The invite button's own state, per channel. */
export interface OutgoingRing {
    ringId: string;
    guildId: string;
    channelId: string;
    targetUserId: string;
    secondsLeft: number;
}

/**
 * What the last send attempt came back with, so the button can say why it is disabled.
 *
 * <p>`messageKey` is already the honest wording for the reason - see {@link refusalMessageKey},
 * which is where the one refusal that must not be reported literally is handled.</p>
 */
export interface RingRefusal {
    messageKey: string;
    retryAfterSeconds: number;
}

const TICK_MS = 1000;

/**
 * The ephemeral voice-channel ring, on both sides of it.
 *
 * <p>Modelled on {@link CallStateService}, which is the DM call ring, and deliberately separate from
 * it. <b>A ring is not a call.</b> It holds no media session and no roster slot, it is an ordinary
 * notification rather than a CallKit screen, and accepting it connects nobody to anything - it
 * closes the invitation and hands back the channel's coordinates, after which this goes through the
 * same {@link VoiceChannelService.joinChannel} every other join uses. There is no second join
 * path, and there is no takeover event, because a superseded device has nothing to tear down.</p>
 *
 * <p>Three legs feed the incoming stack, and all three are needed: `guild.VoiceRingIncoming` while
 * connected, the push while backgrounded, and `GET .../rings/pending` on launch and on every
 * reconnect - the event is never replayed, so without that read a client that was offline for ten
 * seconds never finds out it was asked.</p>
 */
@Injectable({providedIn: 'root'})
export class VoiceRingStateService implements OnDestroy {
    /** Newest first. Two different people can ask you into two different channels at once. */
    readonly incoming = signal<IncomingRing[]>([]);
    /** Keyed by `${guildId}/${channelId}` - one live invitation per channel we are inviting into. */
    readonly outgoing = signal<Record<string, OutgoingRing>>({});
    /** Keyed the same way. Cleared when the countdown it names runs out. */
    readonly refusals = signal<Record<string, RingRefusal>>({});
    /** In flight, so a double click does not send twice. */
    readonly sending = signal(false);

    readonly hasIncoming = computed(() => this.incoming().length > 0);

    private readonly rings = inject(VoiceRingService);
    private readonly ws = inject(GuildWebsocketService);
    private readonly realtime = inject(RealtimeConnectionService);
    private readonly deviceIdentity = inject(DeviceIdentityService);
    private readonly voiceChannels = inject(VoiceChannelService);
    private readonly guildService = inject(GuildService);
    private readonly profileService = inject(ProfileService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);

    /** Resolved once and held, so the multi-device checks below are synchronous. */
    private ownDeviceId: string | null = null;
    private ticker: ReturnType<typeof setInterval> | null = null;
    private catchingUp = false;

    constructor() {
        void this.deviceIdentity.deviceId().then(id => this.ownDeviceId = id).catch(() => undefined);

        this.ws.voiceRingIncomingObservable.subscribe(ring => this.addIncoming(ring));
        this.ws.voiceRingSentObservable.subscribe(ring => this.trackOutgoing(ring));

        this.ws.voiceRingResolvedObservable.subscribe(event => {
            this.dropIncoming(event.ringId);
            this.dropOutgoing(event.ringId);

            // Our own device already rendered whatever it did. Re-announcing it would tell somebody
            // they declined an invitation a moment after they pressed decline.
            if (event.resolvedByDeviceId && event.resolvedByDeviceId === this.ownDeviceId) return;
            this.announceToInviter(event.status, event.reason);
        });

        // Addressed to one device, and never an error: it is the ordinary outcome of answering on
        // the laptop a second after the phone. The ring itself is untouched.
        this.ws.voiceRingDismissedObservable.subscribe(event => this.dropIncoming(event.ringId));

        // The realtime event is never replayed, so a reconnect is exactly the gap this read fills.
        effect(() => {
            if (this.realtime.connectionState() !== ConnectionState.Connected) return;
            untracked(() => this.catchUp());
        });

        this.startTicking();
    }

    ngOnDestroy(): void {
        if (this.ticker !== null) clearInterval(this.ticker);
    }

    /** Re-reads the rings currently asking us in. Safe to call on launch and on every reconnect. */
    catchUp(): void {
        if (this.catchingUp) return;
        this.catchingUp = true;

        this.rings.pending().subscribe({
            next: pending => {
                this.catchingUp = false;
                for (const ring of pending) this.addIncoming(fromDto(ring));
            },
            // Silent: a failed background read costs a card that the live event may still deliver.
            error: () => this.catchingUp = false,
        });
    }

    /** Whether an invitation into this channel is already out, so the button can hold still. */
    outgoingFor(guildId: string, channelId: string): OutgoingRing | null {
        return this.outgoing()[key(guildId, channelId)] ?? null;
    }

    refusalFor(guildId: string, channelId: string): RingRefusal | null {
        return this.refusals()[key(guildId, channelId)] ?? null;
    }

    /**
     * Asks somebody into a voice channel.
     *
     * <p>Every refusal shape is handled here rather than bubbled: a `409 TargetAlreadyInChannel` is
     * not a failure (they are in the room, and the roster already says so), a `400` is a bug in this
     * client and must not be shown to anybody, and a `403` with no body means we are not in the
     * channel - which the affordance should already have prevented.</p>
     */
    send(guildId: string, channelId: string, targetUserId: string): void {
        if (this.sending()) return;
        this.sending.set(true);

        this.rings.ring(guildId, channelId, targetUserId).subscribe({
            next: ring => {
                this.sending.set(false);
                this.clearRefusal(guildId, channelId);
                this.outgoing.update(map => ({
                    ...map,
                    [key(guildId, channelId)]: {
                        ringId: ring.ringId,
                        guildId,
                        channelId,
                        targetUserId,
                        secondsLeft: ring.expiresInSeconds,
                    },
                }));
            },
            error: (err: HttpErrorResponse) => {
                this.sending.set(false);
                this.applyRefusal(guildId, channelId, err);
            },
        });
    }

    /** The inviter takes it back. Deliberately a different act from the target's decline. */
    cancel(guildId: string, channelId: string): void {
        const outgoing = this.outgoingFor(guildId, channelId);
        if (!outgoing) return;

        this.dropOutgoing(outgoing.ringId);
        this.rings.cancel(outgoing.ringId).subscribe({error: () => undefined});
    }

    /**
     * Accepts, then joins.
     *
     * <p>Two calls in that order. Accepting only closes the invitation - if the join then fails we
     * are not in the channel but the invitation is still correctly closed, which is why the failure
     * points at an ordinary Join rather than at a second accept.</p>
     */
    accept(ringId: string): void {
        const held = this.incoming().find(i => i.ring.ringId === ringId);
        this.dropIncoming(ringId);

        this.rings.accept(ringId).subscribe({
            next: ring => this.joinAfterAccept(ring),
            error: (err: HttpErrorResponse) => {
                // 409 is the normal multi-device outcome - another of our devices answered, or the
                // clock ran out while this was in flight - and is never surfaced as an error.
                if (err?.status === 409) return;
                if (err?.status === 410) {
                    this.toast.info(this.translate.instant('VOICE_RING.CHANNEL_GONE'));
                    return;
                }
                if (held) this.toast.error(this.translate.instant('VOICE_RING.ACCEPT_FAILED'));
            },
        });
    }

    /**
     * Turns it down.
     *
     * <p>This is the act that locks the inviter out for a while - letting the card lapse does not -
     * so it is never done implicitly. Nothing is confirmed back to the user: they know what they
     * pressed.</p>
     */
    decline(ringId: string): void {
        this.dropIncoming(ringId);
        this.rings.decline(ringId).subscribe({error: () => undefined});
    }

    /** Drops a card without answering it. Not a decline, and carries none of a decline's weight. */
    dropIncoming(ringId: string): void {
        this.incoming.update(list => list.filter(i => i.ring.ringId !== ringId));
    }

    private dropOutgoing(ringId: string): void {
        this.outgoing.update(map => {
            const entry = Object.entries(map).find(([, v]) => v.ringId === ringId);
            if (!entry) return map;
            const next = {...map};
            delete next[entry[0]];
            return next;
        });
    }

    private addIncoming(ring: WsVoiceRing): void {
        // A ring that arrived already dead - a push that sat in a queue, a catch-up read racing the
        // expiry - is dropped rather than drawn.
        if (ring.expiresInSeconds <= 0) return;

        this.profileService.resolveByUserId(ring.inviterId);

        this.incoming.update(list => {
            // The same inviter ringing a second channel supersedes the first, so never two cards
            // from one face. The server closes the older ring too; this is the local half.
            const kept = list.filter(i =>
                i.ring.ringId !== ring.ringId && i.ring.inviterId !== ring.inviterId);
            return [{ring, secondsLeft: ring.expiresInSeconds}, ...kept];
        });
    }

    /** Our own ring, seen from another window. Mirrors the pending state without re-sending it. */
    private trackOutgoing(ring: WsVoiceRing): void {
        this.outgoing.update(map => ({
            ...map,
            [key(ring.guildId, ring.channelId)]: {
                ringId: ring.ringId,
                guildId: ring.guildId,
                channelId: ring.channelId,
                targetUserId: ring.targetUserId,
                secondsLeft: ring.expiresInSeconds,
            },
        }));
    }

    private joinAfterAccept(ring: VoiceRingDto): void {
        this.joinVoiceChannel(ring.guildId, ring.channelId);
    }

    /**
     * Walks into a voice channel by id, with no invitation involved.
     *
     * <p>Public because the durable card in the DM needs it. A ring lapses after a minute but the
     * message it left behind is read for as long as the conversation exists, and the honest thing to
     * offer on an expired card is an ordinary join - which is subject to the same permission check
     * as clicking the channel in the sidebar, and accepts nothing.</p>
     *
     * <p>Shared with the accept path rather than copied, so that "the channel was deleted in the
     * meantime" is reported the same way from both.</p>
     */
    joinVoiceChannel(guildId: string, channelId: string): void {
        this.guildService.getGuild(guildId).subscribe({
            next: guild => {
                const channel = guild.channels.find(
                    c => c.id === channelId && c.type === ChannelType.Voice);
                if (!channel) {
                    this.toast.info(this.translate.instant('VOICE_RING.CHANNEL_GONE'));
                    return;
                }
                void this.voiceChannels.joinChannel(channel, guild.name);
            },
            error: err => this.toast.httpError(
                this.translate.instant('VOICE_RING.ACCEPT_FAILED'), err),
        });
    }

    private applyRefusal(guildId: string, channelId: string, err: HttpErrorResponse): void {
        const body = err?.error as VoiceRingRefusalDto | null;
        const status = err?.status ?? 0;

        // They walked in while the button was being clicked. The roster says so; nothing to show.
        if (status === 409) return;
        // A ring to ourselves, or at a channel that is not voice. Our bug, not something to report.
        if (status === 400) return;

        const messageKey = status === 403 && !body?.reason
            ? 'VOICE_RING.NOT_IN_CHANNEL'
            : status === 404
                ? 'VOICE_RING.TARGET_NOT_FOUND'
                : refusalMessageKey(body?.reason);

        const retryAfterSeconds = Math.max(0, body?.retryAfterSeconds ?? 0);
        this.refusals.update(map => ({...map, [key(guildId, channelId)]: {messageKey, retryAfterSeconds}}));
    }

    private clearRefusal(guildId: string, channelId: string): void {
        this.refusals.update(map => {
            const k = key(guildId, channelId);
            if (!(k in map)) return map;
            const next = {...map};
            delete next[k];
            return next;
        });
    }

    /** A quiet line to the inviter about how their invitation ended. Never to the target. */
    private announceToInviter(status: string, reason: string | null): void {
        if (status === VoiceRingStatus.Declined) {
            this.toast.info(this.translate.instant('VOICE_RING.DECLINED'));
            return;
        }
        if (reason === VoiceRingReason.TimedOut) {
            this.toast.info(this.translate.instant('VOICE_RING.NO_ANSWER'));
        }
    }

    /**
     * One interval for every countdown on screen.
     *
     * <p>Ticks a locally-held count rather than differencing `expiresAt` against `Date.now()`: a
     * machine whose clock is minutes out is ordinary, and there it would draw an invitation that is
     * already dead or one that never lapses.</p>
     */
    private startTicking(): void {
        this.ticker = setInterval(() => {
            this.incoming.update(list => list
                .map(i => ({...i, secondsLeft: i.secondsLeft - 1}))
                .filter(i => i.secondsLeft > 0));

            this.outgoing.update(map => {
                const next: Record<string, OutgoingRing> = {};
                for (const [k, v] of Object.entries(map)) {
                    if (v.secondsLeft > 1) next[k] = {...v, secondsLeft: v.secondsLeft - 1};
                }
                return next;
            });

            this.refusals.update(map => {
                let changed = false;
                const next: Record<string, RingRefusal> = {};
                for (const [k, v] of Object.entries(map)) {
                    if (v.retryAfterSeconds <= 1) {
                        // Only a countdown clears itself. A refusal with no retry - "they cannot
                        // reach this channel" - stays until something else replaces it.
                        if (v.retryAfterSeconds === 0) next[k] = v;
                        else changed = true;
                        continue;
                    }
                    next[k] = {...v, retryAfterSeconds: v.retryAfterSeconds - 1};
                    changed = true;
                }
                return changed ? next : map;
            });
        }, TICK_MS);
    }
}

function key(guildId: string, channelId: string): string {
    return `${guildId}/${channelId}`;
}

/** The catch-up read answers a `VoiceRingDto`; the card is written against the event's shape. */
function fromDto(ring: VoiceRingDto): WsVoiceRing {
    return {
        ringId: ring.ringId,
        guildId: ring.guildId,
        channelId: ring.channelId,
        channelName: ring.channelName,
        inviterId: ring.inviterId,
        inviterName: null,
        inviterAvatarUrl: null,
        targetUserId: ring.targetUserId,
        createdAt: ring.createdAt,
        expiresAt: ring.expiresAt,
        expiresInSeconds: ring.expiresInSeconds,
        participantUserIds: [],
    };
}

/**
 * The honest wording for a refusal.
 *
 * <p><b>`Unavailable` is deliberately generic.</b> It comes back when a block exists in one
 * direction or the other, and the server will not say which - so neither may this. Rendering it as
 * "you are blocked" would turn a refusal into a disclosure about somebody else's block list, and
 * "they blocked you" would be a guess that is wrong half the time.</p>
 *
 * <p>`RecentlyDeclined` gets no countdown either, even though one arrives: the value runs to 24
 * hours, and "later" is kinder and just as true.</p>
 */
export function refusalMessageKey(reason: VoiceRingRefusalReasonValue | undefined): string {
    switch (reason) {
        case VoiceRingRefusalReason.TargetCannotJoinChannel:
            return 'VOICE_RING.REFUSED_NO_ACCESS';
        case VoiceRingRefusalReason.Unavailable:
            return 'VOICE_RING.REFUSED_UNAVAILABLE';
        case VoiceRingRefusalReason.RecentlyDeclined:
            return 'VOICE_RING.REFUSED_RECENTLY_DECLINED';
        case VoiceRingRefusalReason.InviterFlooding:
            return 'VOICE_RING.REFUSED_TOO_MANY_SENT';
        case VoiceRingRefusalReason.TargetSaturated:
            return 'VOICE_RING.REFUSED_TARGET_SATURATED';
        default:
            return 'VOICE_RING.REFUSED_GENERIC';
    }
}
