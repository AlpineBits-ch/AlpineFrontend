/**
 * Mark as Read on a server. The rail clearing is local; the requests are what makes it survive a
 * reload, and they were missing.
 */
import {TestBed} from '@angular/core/testing';
import {signal} from '@angular/core';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {Subject, of, throwError} from 'rxjs';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {ServerTaskbarComponent} from './server-taskbar.component';
import {ChannelDto, GuildDto} from '../../../../dtos/response/guild.dto';
import {ChannelReadState, GuildReadStateService} from '../../../../services/guild-read-state.service';
import {GuildService} from '../../../../services/guild.service';
import {GuildUiActionsService} from '../../../../services/guild-ui-actions.service';
import {GuildVoiceActivityService} from '../../../../services/guild-voice-activity.service';
import {RealtimeConnectionService} from '../../../../services/realtime-connection.service';
import {FakeRealtimeConnection} from '../../../../testing/fake-realtime-connection';
import {InboxApiService} from '../../../../services/inbox-api.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {ProfileService} from '../../../../services/profile.service';
import {ReportDialogService} from '../../../../services/report-dialog.service';
import {ToastService} from '../../../../services/toast.service';
import {provideFakePlatform} from '../../../../platform/testing/provide-fake-platform';

function channel(id: string): ChannelDto {
    return {id, name: id} as ChannelDto;
}

const guild = {
    id: 'g1',
    name: 'G',
    ownerId: 'owner',
    channels: [channel('chan_read'), channel('chan_unread'), channel('chan_thread')],
} as GuildDto;

/** Reaches the private handler the context menu item calls. */
interface Taskbar {
    markGuildAsRead(guild: GuildDto): void;
}

async function setup(unreadIds: string[], markResult = of(undefined)) {
    TestBed.resetTestingModule();

    const inboxApi = {markChannelRead: vi.fn(() => markResult)};
    const readState = {
        markChannelRead: vi.fn(),
        channelStates: signal({}),
        getChannelState: (id: string): ChannelReadState => ({
            isUnread: unreadIds.includes(id),
            mentionCount: 0,
        }),
    };
    const toast = {httpError: vi.fn(), success: vi.fn()};

    await TestBed.configureTestingModule({
        imports: [ServerTaskbarComponent],
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService({defaultLanguage: 'en'}),
            provideFakePlatform(),
            {provide: InboxApiService, useValue: inboxApi},
            {provide: GuildReadStateService, useValue: readState},
            {provide: ToastService, useValue: toast},
            {
                provide: GuildService,
                useValue: {
                    guilds: signal([guild]),
                    getGuilds: () => of([guild]),
                    guildJoined$: new Subject(),
                    guildUpdated$: new Subject(),
                },
            },
            {
                provide: NavigationService,
                useValue: {
                    workspace: signal({type: 'dms' as const}),
                    mainView: signal({type: 'home' as const}),
                },
            },
            {provide: GuildVoiceActivityService, useValue: {presence: signal({})}},
            {provide: GuildUiActionsService, useValue: {}},
            {provide: RealtimeConnectionService, useValue: new FakeRealtimeConnection()},
            {provide: ReportDialogService, useValue: {open: vi.fn()}},
            {provide: ProfileService, useValue: {ownProfile: () => ({userId: 'u1'})}},
        ],
    })
        // ngOnInit wires half the app up; this file is about one menu command.
        .overrideComponent(ServerTaskbarComponent, {set: {template: '', imports: [], styles: []}})
        .compileComponents();

    const fixture = TestBed.createComponent(ServerTaskbarComponent);
    const taskbar = fixture.componentInstance as unknown as Taskbar;

    return {taskbar, inboxApi, readState, toast};
}

describe('ServerTaskbarComponent mark as read', () => {
    beforeEach(() => vi.clearAllMocks());

    it('tells the server about every channel it just cleared', async () => {
        const {taskbar, inboxApi, readState} = await setup(['chan_unread', 'chan_thread']);

        taskbar.markGuildAsRead(guild);

        expect(readState.markChannelRead).toHaveBeenCalledWith('chan_unread');
        expect(readState.markChannelRead).toHaveBeenCalledWith('chan_thread');
        expect(inboxApi.markChannelRead).toHaveBeenCalledWith('chan_unread');
        expect(inboxApi.markChannelRead).toHaveBeenCalledWith('chan_thread');
    });

    it('leaves a channel that was already read alone', async () => {
        const {taskbar, inboxApi, readState} = await setup(['chan_unread']);

        taskbar.markGuildAsRead(guild);

        expect(readState.markChannelRead).toHaveBeenCalledOnce();
        expect(inboxApi.markChannelRead).toHaveBeenCalledExactlyOnceWith('chan_unread');
    });

    it('asks for nothing when the server has no unread channel', async () => {
        const {taskbar, inboxApi} = await setup([]);

        taskbar.markGuildAsRead(guild);

        expect(inboxApi.markChannelRead).not.toHaveBeenCalled();
    });

    it('says so when the write fails, rather than leaving the rail lying', async () => {
        const {taskbar, toast} = await setup(
            ['chan_unread'],
            throwError(() => ({status: 500})),
        );

        taskbar.markGuildAsRead(guild);

        expect(toast.httpError).toHaveBeenCalledOnce();
    });
});
