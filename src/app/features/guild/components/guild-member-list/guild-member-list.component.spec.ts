import {ComponentFixture, TestBed} from '@angular/core/testing';
import {signal} from '@angular/core';
import {provideTranslateService} from '@ngx-translate/core';
import {of, Subject} from 'rxjs';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {GuildMemberListComponent} from './guild-member-list.component';
import {GuildService} from '../../../../services/guild.service';
import {GuildWebsocketService} from '../../../../services/guild-websocket.service';
import {BotInstallDialogService} from '../../../bot-install/bot-install-dialog.service';
import {ToastService} from '../../../../services/toast.service';
import {BrokenImageService} from '../../../../services/broken-image.service';
import {UserActivityService} from '../../../../services/user-activity.service';
import {ApiConfigService} from '../../../../services/api-config.service';
import {ReportDialogService} from '../../../../services/report-dialog.service';
import {ProfileDialogService} from '../../../../services/profile-dialog.service';
import {GuildVoiceActivityService} from '../../../../services/guild-voice-activity.service';
import {VoiceChannelService} from '../../../../services/voice-channel.service';
import {CallFocusService} from '../../../../services/call-focus.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {HomeStatusService} from '../../../../services/home-status.service';
import {ProfileService} from '../../../../services/profile.service';
import {GuildDto, GuildKind} from '../../../../dtos/response/guild.dto';
import {GuildMemberDto} from '../../../../dtos/response/member.dto';
import {OnlineStatus} from '../../../../dtos/response/profile.dto';
import {MemberType} from '../../../../enums/member-type.enum';

const GUILD_ID = 'guild-1';
const VOICE_CHANNEL_ID = 'channel-1';
const STREAMER_ID = 'user-streamer';
const QUIET_ID = 'user-quiet';

function guildFixture(): GuildDto {
    return {
        id: GUILD_ID,
        name: 'Test Guild',
        ownerId: 'owner',
        kind: GuildKind.Community,
        channels: [{
            id: VOICE_CHANNEL_ID,
            guildId: GUILD_ID,
            name: 'General Voice',
            description: '',
            createdAt: new Date(0),
            updatedAt: new Date(0),
            type: 0,
            isAgeRestricted: false,
            isPrivate: false,
            categoryId: undefined,
            permissions: [],
            position: 0,
            slowModeSeconds: 0,
            parentChannelId: undefined,
        }],
    } as unknown as GuildDto;
}

function memberFixture(userId: string, userName: string): GuildMemberDto {
    return {
        id: `member-${userId}`,
        guildId: GUILD_ID,
        userId,
        inviteId: 'invite',
        permissions: '',
        status: OnlineStatus.Online,
        type: MemberType.Default,
        nickname: null,
        profile: {userId, userName} as any,
        readState: [],
        roleMembers: [],
    };
}

function setup(opts: { streamingUserId?: string | null } = {}) {
    const members = [memberFixture(STREAMER_ID, 'Streamer'), memberFixture(QUIET_ID, 'Quiet')];

    const guildWs = {
        memberBannedObservable: new Subject(),
        memberKickedObservable: new Subject(),
        memberLeftObservable: new Subject(),
        memberMovedOutObservable: new Subject(),
        memberMutedObservable: new Subject(),
        memberUnmutedObservable: new Subject(),
        presenceChangedObservable: new Subject(),
        memberJoinedObservable: new Subject(),
        memberUpdatedObservable: new Subject(),
    };

    // undefined -> default fixture (STREAMER_ID is live); null -> nobody is.
    const liveUserId = opts.streamingUserId === undefined ? STREAMER_ID : opts.streamingUserId;
    const navService = {openChannel: (_: unknown) => undefined};
    const callFocus = {request: (_scopeKey: string, _target: unknown) => undefined};
    const voiceChannel = {
        joinedChannelId: signal<string | null>(null),
        joinChannel: (_channel: unknown, _guildName: string) => Promise.resolve(),
    };
    const guildVoiceActivity = {
        isStreaming: (userId: string) => userId === liveUserId,
        streamingChannelId: (_guildId: string, userId: string) =>
            userId === liveUserId ? VOICE_CHANNEL_ID : undefined,
    };

    TestBed.configureTestingModule({
        imports: [GuildMemberListComponent],
        providers: [
            provideTranslateService({defaultLanguage: 'en'}),
            {provide: GuildService, useValue: {
                getMembers: () => of(members),
                getOwnMember: () => of({userId: 'me', roleMembers: [], permissions: ''}),
            }},
            {provide: GuildWebsocketService, useValue: guildWs},
            {provide: BotInstallDialogService, useValue: {installedIntoGuild: new Subject()}},
            {provide: ToastService, useValue: {success: () => undefined, httpError: () => undefined, info: () => undefined}},
            {provide: BrokenImageService, useValue: {isBroken: () => false}},
            {provide: UserActivityService, useValue: {primaryFor: () => null, seedFromMembers: () => undefined}},
            {provide: ApiConfigService, useValue: {baseUrl: signal('https://example.test')}},
            {provide: ReportDialogService, useValue: {open: () => undefined}},
            {provide: ProfileDialogService, useValue: {open: () => undefined}},
            {provide: GuildVoiceActivityService, useValue: guildVoiceActivity},
            {provide: VoiceChannelService, useValue: voiceChannel},
            {provide: CallFocusService, useValue: callFocus},
            {provide: NavigationService, useValue: navService},
            // Short-circuits the home-status board's own dependency chain (RealtimeConnectionService
            // -> AuthService -> OAuthService/HttpClient), which this spec has no use for - the
            // board itself renders nothing without the Presence module, which this guild fixture
            // does not have.
            {provide: HomeStatusService, useValue: {statuses: () => [], own: () => null, isUnavailable: () => true, isLoading: () => false}},
            {provide: ProfileService, useValue: {ownProfile: () => undefined, getCachedByUserId: () => undefined}},
        ],
    });

    const fixture: ComponentFixture<GuildMemberListComponent> = TestBed.createComponent(GuildMemberListComponent);
    fixture.componentRef.setInput('guild', guildFixture());
    fixture.detectChanges();
    return {fixture, navService, callFocus, voiceChannel};
}

describe('GuildMemberListComponent - streaming badge', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('shows the LIVE badge beside a streaming member', () => {
        const {fixture} = setup();
        expect(fixture.nativeElement.textContent).toContain('CALL.LIVE');
    });

    it('renders exactly one badge when only one member is streaming', () => {
        const {fixture} = setup();
        const badges = fixture.nativeElement.querySelectorAll('app-call-live-badge');
        expect(badges.length).toBe(1);
    });

    it('renders no badge when nobody is streaming', () => {
        const {fixture} = setup({streamingUserId: null});
        expect(fixture.nativeElement.querySelectorAll('app-call-live-badge').length).toBe(0);
    });

    it('opens the channel, joins voice, and arms a focus request when the badge is clicked', async () => {
        const {fixture, navService, callFocus, voiceChannel} = setup();
        let openedChannelId: string | undefined;
        let requested: {key: string; target: unknown} | undefined;
        let joinedWith: {channelId: string; guildName: string} | undefined;
        navService.openChannel = (c: any) => {
            openedChannelId = c.id;
        };
        callFocus.request = (key: string, target: unknown) => {
            requested = {key, target};
        };
        voiceChannel.joinChannel = (channel: any, guildName: string) => {
            joinedWith = {channelId: channel.id, guildName};
            return Promise.resolve();
        };

        const button: HTMLButtonElement = fixture.nativeElement.querySelector('button:has(app-call-live-badge)')
            ?? fixture.nativeElement.querySelector('app-call-live-badge').closest('button');
        button.click();
        // watchStream now joins before arming the request (matching the row it sits inside), so the
        // request lands after the joinChannel() promise settles rather than synchronously.
        await vi.waitFor(() => expect(requested).toBeDefined());

        expect(openedChannelId).toBe(VOICE_CHANNEL_ID);
        expect(joinedWith).toEqual({channelId: VOICE_CHANNEL_ID, guildName: 'Test Guild'});
        expect(requested).toEqual({key: `channel:${VOICE_CHANNEL_ID}`, target: {userId: STREAMER_ID}});
    });

    it('does not re-join voice when already in the streaming member\'s channel', async () => {
        const {fixture, callFocus, voiceChannel} = setup();
        voiceChannel.joinedChannelId = signal(VOICE_CHANNEL_ID);
        let joinCalled = false;
        voiceChannel.joinChannel = (_channel: any, _guildName: string) => {
            joinCalled = true;
            return Promise.resolve();
        };
        let requested: unknown;
        callFocus.request = (key: string, target: unknown) => {
            requested = {key, target};
        };

        const button: HTMLButtonElement = fixture.nativeElement.querySelector('button:has(app-call-live-badge)')
            ?? fixture.nativeElement.querySelector('app-call-live-badge').closest('button');
        button.click();
        await vi.waitFor(() => expect(requested).toBeDefined());

        expect(joinCalled).toBe(false);
    });

    it('does not also open the profile dialog when the badge is clicked', () => {
        const {fixture} = setup();
        let profileOpened = false;
        (fixture.componentInstance as any).profileDialogSvc = {open: () => {
            profileOpened = true;
        }};

        const button: HTMLButtonElement = fixture.nativeElement.querySelector('app-call-live-badge').closest('button');
        button.click();

        expect(profileOpened).toBe(false);
    });
});
