import {ComponentFixture, TestBed} from '@angular/core/testing';
import {HttpErrorResponse} from '@angular/common/http';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {signal} from '@angular/core';
import {of, throwError} from 'rxjs';
import {vi} from 'vitest';
import {ChannelInvitePanelComponent} from './channel-invite-panel.component';
import {ChannelInviteRosterService} from './channel-invite-roster.service';
import {GuildMemberDto} from '../../../../../../dtos/response/member.dto';
import {OnlineStatus} from '../../../../../../dtos/response/profile.dto';
import {MemberType} from '../../../../../../enums/member-type.enum';
import {OsInfo} from '../../../../../../platform/ports/os-info.port';
import {FakeOsInfo} from '../../../../../../platform/testing/fake-os-info';
import {ApiConfigService} from '../../../../../../services/api-config.service';
import {ProfileService} from '../../../../../../services/profile.service';
import {VoiceChannelService} from '../../../../../../services/voice-channel.service';
import {VoiceRingService} from '../../../../../../services/voice-ring.service';
import {VoiceRingStateService} from '../../../../../../services/voice-ring-state.service';
import {RelationshipStore} from '../../../../../../stores/relationship.store';

const GUILD = 'guild_1';
const CHANNEL = 'chan_1';

function member(userId: string, status = OnlineStatus.Online): GuildMemberDto {
    return {
        id: `mem_${userId}`,
        guildId: GUILD,
        userId,
        inviteId: '',
        status,
        type: MemberType.Default,
        nickname: null,
        profile: {userName: userId} as GuildMemberDto['profile'],
        readState: [],
    } as GuildMemberDto;
}

interface SetupOptions {
    members?: GuildMemberDto[];
    /** Where this client is sitting, which is the only thing that offers the bell. */
    joinedChannelId?: string | null;
    /** What the message invitation answers with. */
    inviteFails?: HttpErrorResponse;
}

function setup(options: SetupOptions = {}) {
    const members = options.members ?? [member('ada')];

    const rings = {
        invite: vi.fn(() =>
            options.inviteFails ? throwError(() => options.inviteFails) : of({conversationId: 'conv_1'}),
        ),
    };
    const ringState = {
        send: vi.fn(),
        sending: signal(false),
        outgoingFor: () => null,
    };

    TestBed.configureTestingModule({
        imports: [ChannelInvitePanelComponent],
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService({defaultLanguage: 'en'}),
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
            // The avatar in each row reaches for it. Desktop, so the rows draw a p-avatar.
            {provide: OsInfo, useValue: new FakeOsInfo('windows', false)},
            {provide: VoiceRingService, useValue: rings},
            {provide: VoiceRingStateService, useValue: ringState},
            {
                provide: ChannelInviteRosterService,
                useValue: {load: () => of({members, viewers: members.map(m => m.userId)})},
            },
            {provide: RelationshipStore, useValue: {load: vi.fn(), friends: () => []}},
            {
                provide: ProfileService,
                useValue: {
                    ownProfile: () => ({userId: 'me'}),
                    // The avatar's two: a cache read and the fetch it kicks off on a miss.
                    getCachedByUserId: () => undefined,
                    resolveByUserId: vi.fn(),
                },
            },
            {
                provide: VoiceChannelService,
                useValue: {joinedChannelId: signal(options.joinedChannelId ?? null)},
            },
        ],
    });

    const fixture: ComponentFixture<ChannelInvitePanelComponent> =
        TestBed.createComponent(ChannelInvitePanelComponent);
    fixture.componentRef.setInput('guildId', GUILD);
    fixture.componentRef.setInput('channelId', CHANNEL);
    fixture.componentRef.setInput('channelName', 'General');
    fixture.detectChanges();

    const rows = (): HTMLButtonElement[] =>
        [...fixture.nativeElement.querySelectorAll('button')].filter(
            (b): b is HTMLButtonElement => !b.hasAttribute('aria-label'),
        );

    return {fixture, rings, ringState, rows};
}

describe('ChannelInvitePanelComponent', () => {
    afterEach(() => TestBed.resetTestingModule());

    it('sends the quiet invitation when a row is pressed, and says so on that row', () => {
        const {fixture, rings, rows} = setup();

        rows()[0].click();
        fixture.detectChanges();

        expect(rings.invite).toHaveBeenCalledWith(GUILD, CHANNEL, 'ada');
        expect(fixture.nativeElement.textContent).toContain('VOICE_RING.INVITE_SENT');
    });

    it('does not send a second time to somebody already invited', () => {
        const {fixture, rings, rows} = setup();

        rows()[0].click();
        fixture.detectChanges();
        rows()[0].click();

        expect(rings.invite).toHaveBeenCalledTimes(1);
    });

    it('names the recipient policy when that is what refused it', () => {
        const {fixture, rows} = setup({
            inviteFails: new HttpErrorResponse({status: 403, error: {reason: 'RecipientPolicy'}}),
        });

        rows()[0].click();
        fixture.detectChanges();

        expect(fixture.nativeElement.textContent).toContain('VOICE_RING.INVITE_REFUSED');
    });

    it('stays vague about a refusal that is not the recipient s to explain', () => {
        const {fixture, rows} = setup({
            inviteFails: new HttpErrorResponse({status: 500, error: null}),
        });

        rows()[0].click();
        fixture.detectChanges();

        expect(fixture.nativeElement.textContent).toContain('VOICE_RING.INVITE_FAILED');
    });

    it('offers no bell from outside the channel, because the server would refuse the ring', () => {
        const {fixture} = setup({joinedChannelId: null});

        expect(fixture.nativeElement.querySelector('[aria-label="VOICE_RING.RING_THEM"]')).toBeNull();
    });

    it('rings from inside it, and only from the bell', () => {
        const {fixture, ringState, rings} = setup({joinedChannelId: CHANNEL});

        const bell: HTMLButtonElement = fixture.nativeElement.querySelector(
            '[aria-label="VOICE_RING.RING_THEM"]',
        );
        bell.click();
        fixture.detectChanges();

        expect(ringState.send).toHaveBeenCalledWith(GUILD, CHANNEL, 'ada');
        // The bell sits inside the row's own hit area; ringing must not also send the message.
        expect(rings.invite).not.toHaveBeenCalled();
    });

    it('points at the full roster when it has nobody to offer', () => {
        const {fixture} = setup({members: [member('ghost', OnlineStatus.Offline)]});

        expect(fixture.nativeElement.textContent).toContain('VOICE_RING.NOBODY_AROUND');
        expect(fixture.nativeElement.textContent).toContain('VOICE_RING.SEARCH_EVERYONE');
    });
});
