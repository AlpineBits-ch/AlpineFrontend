import {ComponentFixture, TestBed} from '@angular/core/testing';
import {signal} from '@angular/core';
import {provideTranslateService} from '@ngx-translate/core';
import {of, Subject} from 'rxjs';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {MenuItem} from '../../../../shared/context-menu/context-menu.model';
import {GuildMemberListComponent} from './guild-member-list.component';
import {GuildService} from '../../../../services/guild.service';
import {BotInstallDialogService} from '../../../bot-install/bot-install-dialog.service';
import {ToastService} from '../../../../services/toast.service';
import {BrokenImageService} from '../../../../services/broken-image.service';
import {UserActivityService} from '../../../../services/user-activity.service';
import {ApiConfigService} from '../../../../services/api-config.service';
import {ReportDialogService} from '../../../../services/report-dialog.service';
import {ProfilePopoutService} from '../../../../services/profile-popout.service';
import {GuildVoiceActivityService} from '../../../../services/guild-voice-activity.service';
import {VoiceChannelService} from '../../../../services/voice-channel.service';
import {CallFocusService} from '../../../../services/call-focus.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {HomeStatusService} from '../../../../services/home-status.service';
import {ProfileService} from '../../../../services/profile.service';
import {GuildDto, GuildKind} from '../../../../dtos/response/guild.dto';
import {GuildMemberDto, SelfGuildMemberDto} from '../../../../dtos/response/member.dto';
import {OnlineStatus} from '../../../../dtos/response/profile.dto';
import {MemberType} from '../../../../enums/member-type.enum';
import {RealtimeConnectionService} from '../../../../services/realtime-connection.service';
import {FakeRealtimeConnection} from '../../../../testing/fake-realtime-connection';

const GUILD_ID = 'guild-1';
const VOICE_CHANNEL_ID = 'channel-1';
const STREAMER_ID = 'user-streamer';
const QUIET_ID = 'user-quiet';
const OWNER_ID = 'owner';

function guildFixture(features?: string): GuildDto {
    return {
        id: GUILD_ID,
        name: 'Test Guild',
        ownerId: OWNER_ID,
        kind: GuildKind.Community,
        features,
        channels: [
            {
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
            },
        ],
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

const OWN_MEMBER: Partial<SelfGuildMemberDto> = {userId: 'me', roleMembers: [], permissions: ''};
/** Carries no permissions and no roles, exactly as the server sends an owner's row. */
const OWNER_MEMBER: Partial<SelfGuildMemberDto> = {userId: OWNER_ID, roleMembers: [], permissions: ''};

function roleGrant(permissions: string): Partial<SelfGuildMemberDto> {
    return {userId: 'me', permissions: '', roleMembers: [{role: {id: 'role-1', permissions} as never}]};
}

function setup(
    opts: {
        streamingUserId?: string | null;
        ownMember?: Partial<SelfGuildMemberDto>;
        features?: string;
    } = {},
) {
    const members = [
        memberFixture(STREAMER_ID, 'Streamer'),
        memberFixture(QUIET_ID, 'Quiet'),
        memberFixture(OWNER_ID, 'Owner'),
    ];

    const guildWs = new FakeRealtimeConnection();

    // undefined -> default fixture (STREAMER_ID is live); null -> nobody is.
    const liveUserId = opts.streamingUserId === undefined ? STREAMER_ID : opts.streamingUserId;
    const navService = {openChannel: (_: unknown) => undefined};
    const callFocus = {request: (_scopeKey: string, _target: unknown) => undefined};
    const voiceChannel = {
        joinedChannelId: signal<string | null>(null),
        // Answers whether the join actually happened; a stub that resolves undefined reads as a refusal, and everything the caller does after the join is gated on it.
        joinChannel: (_channel: unknown, _guildName: string) => Promise.resolve(true),
    };
    const guildService = {
        getMembers: () => of(members),
        getOwnMember: () => of(opts.ownMember ?? OWN_MEMBER),
        kickMember: vi.fn(() => of(undefined)),
        banMember: vi.fn(() => of(undefined)),
        muteMember: vi.fn(() => of(undefined)),
        unmuteMember: vi.fn(() => of(undefined)),
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
            {provide: GuildService, useValue: guildService},
            {provide: RealtimeConnectionService, useValue: guildWs},
            {provide: BotInstallDialogService, useValue: {installedIntoGuild: new Subject()}},
            {
                provide: ToastService,
                useValue: {success: () => undefined, httpError: () => undefined, info: () => undefined},
            },
            {provide: BrokenImageService, useValue: {isBroken: () => false}},
            {
                provide: UserActivityService,
                useValue: {primaryFor: () => null, seedFromMembers: () => undefined},
            },
            {provide: ApiConfigService, useValue: {baseUrl: signal('https://example.test')}},
            {provide: ReportDialogService, useValue: {open: () => undefined}},
            {provide: ProfilePopoutService, useValue: {open: () => undefined}},
            {provide: GuildVoiceActivityService, useValue: guildVoiceActivity},
            {provide: VoiceChannelService, useValue: voiceChannel},
            {provide: CallFocusService, useValue: callFocus},
            {provide: NavigationService, useValue: navService},
            // Short-circuits the home-status board's own dependency chain (RealtimeConnectionService -> AuthService -> OAuthService/HttpClient), which this spec has no use for; the board itself renders nothing without the Presence module, which this guild fixture does not have.
            {
                provide: HomeStatusService,
                useValue: {
                    statuses: () => [],
                    own: () => null,
                    isUnavailable: () => true,
                    isLoading: () => false,
                },
            },
            {
                provide: ProfileService,
                useValue: {ownProfile: () => undefined, getCachedByUserId: () => undefined},
            },
        ],
    });

    const fixture: ComponentFixture<GuildMemberListComponent> =
        TestBed.createComponent(GuildMemberListComponent);
    fixture.componentRef.setInput('guild', guildFixture(opts.features));
    fixture.detectChanges();
    return {fixture, navService, callFocus, voiceChannel, guildService};
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
            return Promise.resolve(true);
        };

        const button: HTMLButtonElement =
            fixture.nativeElement.querySelector('button:has(app-call-live-badge)') ??
            fixture.nativeElement.querySelector('app-call-live-badge').closest('button');
        button.click();
        // watchStream joins before arming the request (matching the row it sits inside), so the request lands after the joinChannel() promise settles rather than synchronously.
        await vi.waitFor(() => expect(requested).toBeDefined());

        expect(openedChannelId).toBe(VOICE_CHANNEL_ID);
        expect(joinedWith).toEqual({channelId: VOICE_CHANNEL_ID, guildName: 'Test Guild'});
        expect(requested).toEqual({key: `channel:${VOICE_CHANNEL_ID}`, target: {userId: STREAMER_ID}});
    });

    it("does not re-join voice when already in the streaming member's channel", async () => {
        const {fixture, callFocus, voiceChannel} = setup();
        voiceChannel.joinedChannelId = signal(VOICE_CHANNEL_ID);
        let joinCalled = false;
        voiceChannel.joinChannel = (_channel: any, _guildName: string) => {
            joinCalled = true;
            return Promise.resolve(true);
        };
        let requested: unknown;
        callFocus.request = (key: string, target: unknown) => {
            requested = {key, target};
        };

        const button: HTMLButtonElement =
            fixture.nativeElement.querySelector('button:has(app-call-live-badge)') ??
            fixture.nativeElement.querySelector('app-call-live-badge').closest('button');
        button.click();
        await vi.waitFor(() => expect(requested).toBeDefined());

        expect(joinCalled).toBe(false);
    });

    /** A refused join has already told the user why; focusing a stream in a room this client isn't in would leave the stage waiting on a participant that never arrives. */
    it('arms no focus request when the join was refused', async () => {
        const {fixture, callFocus, voiceChannel} = setup();
        let requested: unknown;
        let joinCalled = false;
        callFocus.request = (key: string, target: unknown) => {
            requested = {key, target};
        };
        voiceChannel.joinChannel = (_channel: any, _guildName: string) => {
            joinCalled = true;
            return Promise.resolve(false);
        };

        const button: HTMLButtonElement =
            fixture.nativeElement.querySelector('button:has(app-call-live-badge)') ??
            fixture.nativeElement.querySelector('app-call-live-badge').closest('button');
        button.click();
        await vi.waitFor(() => expect(joinCalled).toBe(true));

        expect(requested).toBeUndefined();
    });

    it('does not also open the profile dialog when the badge is clicked', () => {
        const {fixture} = setup();
        let profileOpened = false;
        (fixture.componentInstance as any).profilePopout = {
            open: () => {
                profileOpened = true;
            },
        };

        const button: HTMLButtonElement = fixture.nativeElement
            .querySelector('app-call-live-badge')
            .closest('button');
        button.click();

        expect(profileOpened).toBe(false);
    });
});

/** Swaps the menu for a plain capture object: the assertions are about the rows that get built, not the overlay. */
function menuFor(fixture: ComponentFixture<GuildMemberListComponent>, name: string): MenuItem[] {
    let captured: MenuItem[] = [];
    const stub = {show: (_event: MouseEvent, items: MenuItem[] = []) => (captured = items)};
    (fixture.componentInstance as never as {memberMenu: unknown}).memberMenu = () => stub;

    const row = [...fixture.nativeElement.querySelectorAll('div.cursor-pointer')].find((el: HTMLElement) =>
        el.textContent?.includes(name),
    ) as HTMLElement;
    row.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true}));
    return captured;
}

function labels(items: MenuItem[]): string[] {
    return items.filter(i => !i.separator).map(i => i.label as string);
}

function invoke(items: MenuItem[], label: string): void {
    items.find(i => i.label === label)!.command!({} as never);
}

function submenu(items: MenuItem[], label: string): MenuItem[] {
    return items.find(i => i.label === label)!.items!;
}

describe('GuildMemberListComponent - member actions', () => {
    beforeEach(() => TestBed.resetTestingModule());

    // The union fallback cannot see ownership: the owner's row carries no permissions and their only
    // role is @everyone, so gating on it alone hid every action from the one person who always has them.
    it('offers kick, timeout and ban to the owner, whose row carries no permissions', () => {
        const {fixture} = setup({ownMember: OWNER_MEMBER});
        expect(labels(menuFor(fixture, 'Quiet'))).toEqual([
            'MEMBER_ACTIONS.KICK',
            'MEMBER_ACTIONS.TIMEOUT',
            'MEMBER_ACTIONS.BAN',
            'REPORT.TITLE_MEMBER',
        ]);
    });

    it('offers only report to a member with no moderation permissions', () => {
        const {fixture} = setup();
        expect(labels(menuFor(fixture, 'Quiet'))).toEqual(['REPORT.TITLE_MEMBER']);
    });

    it('offers kick but not ban to a member granted only KickMembers', () => {
        const {fixture} = setup({ownMember: roleGrant('KickMembers')});
        const items = labels(menuFor(fixture, 'Quiet'));
        expect(items).toContain('MEMBER_ACTIONS.KICK');
        expect(items).not.toContain('MEMBER_ACTIONS.BAN');
    });

    it('prefers the server-resolved mask over the role union', () => {
        const {fixture} = setup({
            ownMember: {...roleGrant('KickMembers'), effectivePermissions: 'BanMembers'},
        });
        const items = labels(menuFor(fixture, 'Quiet'));
        expect(items).toContain('MEMBER_ACTIONS.BAN');
        expect(items).not.toContain('MEMBER_ACTIONS.KICK');
    });

    it('offers nothing but report when the Moderation module is off', () => {
        const {fixture} = setup({ownMember: OWNER_MEMBER, features: 'VoiceChannels'});
        expect(labels(menuFor(fixture, 'Quiet'))).toEqual(['REPORT.TITLE_MEMBER']);
    });

    it('does not kick until the dialog is confirmed', () => {
        const {fixture, guildService} = setup({ownMember: OWNER_MEMBER});
        invoke(menuFor(fixture, 'Quiet'), 'MEMBER_ACTIONS.KICK');
        expect(guildService.kickMember).not.toHaveBeenCalled();

        (fixture.componentInstance as never as {confirmKick: () => void}).confirmKick();
        expect(guildService.kickMember).toHaveBeenCalledWith(GUILD_ID, `member-${QUIET_ID}`);
    });

    it('does not ban until the dialog is confirmed, and sends the reason typed into it', () => {
        const {fixture, guildService} = setup({ownMember: OWNER_MEMBER});
        invoke(menuFor(fixture, 'Quiet'), 'MEMBER_ACTIONS.BAN');
        expect(guildService.banMember).not.toHaveBeenCalled();

        const component = fixture.componentInstance as never as {
            banReason: {set: (v: string) => void};
            confirmBan: () => void;
        };
        component.banReason.set('spam');
        component.confirmBan();
        expect(guildService.banMember).toHaveBeenCalledWith(GUILD_ID, {userId: QUIET_ID, reason: 'spam'});
    });

    it('omits an empty reason rather than sending a blank one', () => {
        const {fixture, guildService} = setup({ownMember: OWNER_MEMBER});
        invoke(menuFor(fixture, 'Quiet'), 'MEMBER_ACTIONS.BAN');
        (fixture.componentInstance as never as {confirmBan: () => void}).confirmBan();
        expect(guildService.banMember).toHaveBeenCalledWith(GUILD_ID, {userId: QUIET_ID, reason: undefined});
    });

    it('mutes for the duration chosen from the timeout submenu', () => {
        const {fixture, guildService} = setup({ownMember: OWNER_MEMBER});
        const items = submenu(menuFor(fixture, 'Quiet'), 'MEMBER_ACTIONS.TIMEOUT');
        invoke(items, 'MEMBER_ACTIONS.TIMEOUT_1H');
        expect(guildService.muteMember).toHaveBeenCalledWith(GUILD_ID, `member-${QUIET_ID}`, 60);
    });

    it('lifts a timeout through the unmute endpoint', () => {
        const {fixture, guildService} = setup({ownMember: OWNER_MEMBER});
        const items = submenu(menuFor(fixture, 'Quiet'), 'MEMBER_ACTIONS.TIMEOUT');
        invoke(items, 'MEMBER_ACTIONS.TIMEOUT_REMOVE');
        expect(guildService.unmuteMember).toHaveBeenCalledWith(GUILD_ID, `member-${QUIET_ID}`);
    });

    // The server refuses all three against the owner, so offering them only buys the user a 403.
    it('offers no moderation actions against the owner', () => {
        const {fixture} = setup({ownMember: roleGrant('KickMembers, BanMembers, ModerateMembers')});
        expect(labels(menuFor(fixture, 'Owner'))).toEqual(['REPORT.TITLE_MEMBER']);
        expect(labels(menuFor(fixture, 'Quiet'))).toContain('MEMBER_ACTIONS.KICK');
    });

    it('offers no actions at all against your own row', () => {
        const {fixture} = setup({ownMember: {...roleGrant('KickMembers'), userId: QUIET_ID}});
        expect(labels(menuFor(fixture, 'Quiet'))).toEqual(['MEMBER_ACTIONS.NONE']);
    });
});
