import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {vi} from 'vitest';
import {VoiceInviteCardComponent} from './voice-invite-card.component';
import {EmbedFlags, MessageEmbed} from '../../../../../../dtos/response/message.dto';
import {ProfileService} from '../../../../../../services/profile.service';
import {VoiceChannelService} from '../../../../../../services/voice-channel.service';
import {VoiceRingStateService} from '../../../../../../services/voice-ring-state.service';

const GENERATED = EmbedFlags.Generated;

const ME = 'user_me';
const INVITER = 'user_inviter';

function embed(overrides: Partial<MessageEmbed['venta']> = {}, expiresInMs = 60_000): MessageEmbed {
    return {
        type: 'venta.voice_invite',
        title: 'General',
        description: 'You have been invited to join this voice channel.',
        flags: GENERATED,
        fields: [],
        venta: {
            kind: 'voice_invite',
            resolved: true,
            ring_id: 'vrng_1',
            guild_id: 'gild_1',
            channel_id: 'chan_1',
            channel_name: 'General',
            inviter_id: INVITER,
            expires_at: new Date(Date.now() + expiresInMs).toISOString(),
            ...overrides,
        },
    };
}

function setup(value: MessageEmbed, ownUserId = ME, joinedChannelId: string | null = null) {
    const ringState = {
        accept: vi.fn(),
        joinVoiceChannel: vi.fn(),
    };

    TestBed.configureTestingModule({
        imports: [VoiceInviteCardComponent],
        providers: [
            provideTranslateService({defaultLanguage: 'en'}),
            {provide: VoiceRingStateService, useValue: ringState},
            {provide: ProfileService, useValue: {ownProfile: () => ({userId: ownUserId})}},
            {provide: VoiceChannelService, useValue: {joinedChannelId: () => joinedChannelId}},
        ],
    });

    const fixture: ComponentFixture<VoiceInviteCardComponent> =
        TestBed.createComponent(VoiceInviteCardComponent);
    fixture.componentRef.setInput('embed', value);
    fixture.detectChanges();

    return {fixture, ringState, button: () => fixture.nativeElement.querySelector('button')};
}

describe('VoiceInviteCardComponent while the ring is live', () => {
    afterEach(() => TestBed.resetTestingModule());

    it('names the channel from the venta block', () => {
        const {fixture} = setup(embed());
        expect(fixture.nativeElement.textContent).toContain('General');
    });

    it('offers the accept, and accepting goes through the ring', () => {
        const {ringState, button} = setup(embed());

        expect(button().textContent).toContain('VOICE_RING.ACCEPT');
        button().click();

        expect(ringState.accept).toHaveBeenCalledWith('vrng_1');
        expect(ringState.joinVoiceChannel).not.toHaveBeenCalled();
    });

    it('warns that joining will move them out of the channel they are in', () => {
        const {fixture} = setup(embed(), ME, 'chan_other');
        expect(fixture.nativeElement.textContent).toContain('VOICE_RING.WILL_MOVE_YOU');
    });

    it('does not warn about a move when they are already in this very channel', () => {
        const {fixture} = setup(embed(), ME, 'chan_1');
        expect(fixture.nativeElement.textContent).not.toContain('VOICE_RING.WILL_MOVE_YOU');
    });
});

describe('VoiceInviteCardComponent once the ring has lapsed', () => {
    afterEach(() => TestBed.resetTestingModule());

    it('offers an ordinary join instead of an accept', () => {
        // The card outlives the ring by design - it is read for as long as the conversation exists,
        // and the ring is gone within the minute. Accepting a dead ring answers 409, so the honest
        // affordance is the join anybody could make, which accepts nothing.
        const {ringState, button} = setup(embed({}, -1_000));

        expect(button().textContent).toContain('VOICE_RING.CARD_JOIN_ANYWAY');
        button().click();

        expect(ringState.joinVoiceChannel).toHaveBeenCalledWith('gild_1', 'chan_1');
        expect(ringState.accept).not.toHaveBeenCalled();
    });

    it('says so rather than looking live', () => {
        const {fixture} = setup(embed({}, -1_000));
        expect(fixture.nativeElement.textContent).toContain('VOICE_RING.CARD_LAPSED');
    });

    it('treats a card with no ring id as lapsed even inside the window', () => {
        // Nothing produces this today. If something ever does, offering an accept for a ring that
        // was never named would call the endpoint with undefined.
        const {ringState, button} = setup(embed({ring_id: undefined}));

        expect(button().textContent).toContain('VOICE_RING.CARD_JOIN_ANYWAY');
        button().click();
        expect(ringState.accept).not.toHaveBeenCalled();
    });

    it('flips in place when the expiry passes while it is on screen', async () => {
        vi.useFakeTimers();
        try {
            const {fixture, button} = setup(embed({}, 2_000));
            expect(button().textContent).toContain('VOICE_RING.ACCEPT');

            vi.advanceTimersByTime(2_001);
            fixture.detectChanges();

            expect(button().textContent).toContain('VOICE_RING.CARD_JOIN_ANYWAY');
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('VoiceInviteCardComponent for an invitation sent without a ring', () => {
    afterEach(() => TestBed.resetTestingModule());

    /** delivery: "Message" - no ring id and no expiry. It never lapses. */
    function standing(): MessageEmbed {
        const value = embed({ring_id: undefined});
        value.venta!.expires_at = undefined;
        return value;
    }

    it('does not claim to have expired', () => {
        // The bug this pins. Reading "no expiry" as "lapsed" stamps "this invitation has expired"
        // on a card that was valid the second it arrived and stays valid.
        const {fixture} = setup(standing());

        expect(fixture.nativeElement.textContent).not.toContain('VOICE_RING.CARD_LAPSED');
        expect(fixture.nativeElement.textContent).toContain('VOICE_RING.CARD_SUBTITLE');
    });

    it('offers a join that goes straight to the channel', () => {
        const {ringState, button} = setup(standing());

        expect(button().textContent).toContain('VOICE_RING.CARD_JOIN_ANYWAY');
        button().click();

        expect(ringState.joinVoiceChannel).toHaveBeenCalledWith('gild_1', 'chan_1');
        expect(ringState.accept).not.toHaveBeenCalled();
    });
});

describe('VoiceInviteCardComponent seen by the person who sent it', () => {
    afterEach(() => TestBed.resetTestingModule());

    it('shows the card with no button at all', () => {
        // Both people read the same row. The inviter is already sitting in the channel - that is the
        // only way they were allowed to send this - so a Join button would be nonsense.
        const {fixture, button} = setup(embed(), INVITER);

        expect(fixture.nativeElement.textContent).toContain('General');
        expect(button()).toBeNull();
    });
});
