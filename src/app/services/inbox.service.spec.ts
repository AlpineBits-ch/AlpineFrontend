import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideHttpClient} from '@angular/common/http';
import {of, Subject} from 'rxjs';
import {InboxService} from './inbox.service';
import {ApiConfigService} from './api-config.service';
import {GuildService} from './guild.service';
import {GuildReadStateService} from './guild-read-state.service';
import {ConversationStore} from '../stores/conversation.store';
import {ProfileService} from './profile.service';
import {NavigationService} from '../features/main-page/navigation.service';
import {ConnectionState, RealtimeConnectionService} from './realtime-connection.service';
import {MlsService} from './mls.service';
import {MlsSyncService} from './mls-sync.service';
import {MlsHealthService} from './mls-health.service';
import {HouseholdAlertService} from './household-alert.service';
import {HouseholdAlert} from '../dtos/response/household-alert.dto';
import {
    InboxBreadcrumb,
    InboxMention,
    InboxMessage,
    InboxReadStateChanged,
    InboxTask,
    InboxUnreadGroup,
    InboxUnreadPage,
} from '../dtos/response/inbox.dto';

const BASE = 'https://api.test.example';
const INBOX = `${BASE}/api/v1/guild/inbox`;

/** Handlers registered on the fake hub, so a test can fire a server event by name. */
const hubHandlers = new Map<string, (payload: unknown) => void>();

/** The fake hub's connection state, so a test can drive the connected edge the badge primes on. */
let connectionState = signal(ConnectionState.Disconnected);

/** Stands in for `GuildReadStateService.channelRead$`, so a test can read a channel. */
let channelRead = new Subject<string>();

/** Stands in for `HouseholdAlertService.alerts$`, so a test can fire a household alert. */
let householdAlerts = new Subject<HouseholdAlert>();

function breadcrumb(overrides: Partial<InboxBreadcrumb> = {}): InboxBreadcrumb {
    return {
        guildId: 'gild_1',
        guildName: 'Echo',
        guildIconUrl: '/icon',
        guildIconThumbnailUrl: '/icon/thumbnail',
        categoryId: 'cate_1',
        categoryName: 'General',
        channelId: 'chan_1',
        channelName: 'announcements',
        channelType: 0,
        parentChannelId: null,
        parentChannelName: null,
        ...overrides,
    };
}

function message(overrides: Partial<InboxMessage> = {}): InboxMessage {
    return {
        id: 'mesg_1',
        createdAt: '2026-08-03T09:41:02.884Z',
        authorId: 'user_1',
        authorDisplayName: 'Ana',
        authorAvatarUrl: null,
        content: btoa('hello'),
        isEncrypted: false,
        mlsGeneration: null,
        type: 0,
        systemMessageVariant: null,
        embedsJson: null,
        ...overrides,
    };
}

function group(overrides: Partial<InboxUnreadGroup> = {}): InboxUnreadGroup {
    return {
        breadcrumb: breadcrumb(),
        lastActivityAt: '2026-08-03T10:14:22.115Z',
        unreadCount: 8,
        mentionCount: 2,
        previews: [message()],
        previewsTruncated: false,
        ...overrides,
    };
}

function mention(overrides: Partial<InboxMention> = {}): InboxMention {
    return {
        messageId: 'mesg_1',
        createdAt: '2026-08-03T09:41:02.884Z',
        kind: 'Direct',
        roleId: null,
        roleName: null,
        authorId: 'user_1',
        breadcrumb: breadcrumb(),
        conversationId: null,
        message: message(),
        ...overrides,
    };
}

function page(overrides: Partial<InboxUnreadPage> = {}): InboxUnreadPage {
    return {groups: [], nextCursor: null, previewsUnavailable: false, ...overrides};
}

function setup() {
    hubHandlers.clear();
    connectionState = signal(ConnectionState.Disconnected);
    channelRead = new Subject<string>();
    householdAlerts = new Subject<HouseholdAlert>();
    // Explicit, so one test that throws before its module is torn down does not turn every later
    // test in the file into "the test module has already been instantiated" and bury the real
    // failure seven reports down.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
            {provide: GuildService, useValue: {guilds: () => []}},
            {
                provide: GuildReadStateService,
                useValue: {markChannelRead: () => undefined, channelRead$: channelRead},
            },
            {provide: ConversationStore, useValue: {entities: () => []}},
            {
                provide: ProfileService,
                useValue: {getCachedByUserId: () => undefined, getByUserId: () => of({})},
            },
            {provide: NavigationService, useValue: {selectServer: () => undefined, openChannel: () => undefined, openConversation: () => undefined}},
            {
                provide: RealtimeConnectionService,
                useValue: {
                    on: (event: string, handler: (payload: unknown) => void) =>
                        hubHandlers.set(event, handler),
                    connectionState,
                },
            },
            // Plaintext previews never reach the decryptor's MLS calls, and the encrypted-path
            // behaviour is `decryptMessages`' own contract, covered where it lives.
            {provide: MlsService, useValue: {getEncryptionFloor: async () => null}},
            {provide: MlsSyncService, useValue: {}},
            {provide: MlsHealthService, useValue: {recordFailure: () => undefined}},
            // The real one reaches the OS notification bridge in its constructor. All this service
            // wants from it is the stream that says a household thing started waiting on the user.
            {provide: HouseholdAlertService, useValue: {alerts$: householdAlerts}},
        ],
    });
    return {
        service: TestBed.inject(InboxService),
        ctrl: TestBed.inject(HttpTestingController),
    };
}

/**
 * Drains the microtask queue.
 *
 * <p>For `open`, which is a fire-and-forget UI hook and returns nothing to await - its three
 * requests settle through several `await`s each (the decryptor alone is a few), so a single
 * `Promise.resolve` is not enough.</p>
 */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * Fetches the summary and settles it.
 *
 * <p>The flush has to happen while the call is still in flight, so the request is answered before
 * the `await` - hence the promise is held rather than awaited inline.</p>
 */
async function loadSummary(
    service: InboxService,
    ctrl: HttpTestingController,
    body: {
        unreadChannelCount?: number;
        mentionCount?: number;
        taskCount?: number;
        capped?: boolean;
    } = {},
): Promise<void> {
    const done = service.refreshSummary();
    ctrl.expectOne(`${INBOX}/summary`).flush({
        unreadChannelCount: body.unreadChannelCount ?? 0,
        mentionCount: body.mentionCount ?? 0,
        taskCount: body.taskCount ?? 0,
        capped: body.capped ?? false,
    });
    await done;
}

function task(overrides: Partial<InboxTask> = {}): InboxTask {
    return {
        kind: 'ChoreDue',
        targetId: 'choc_1',
        breadcrumb: breadcrumb({channelName: 'chores'}),
        title: 'Bins',
        subtitle: 'Your turn',
        dueAt: '2026-08-06T18:00:00.000Z',
        isOverdue: false,
        ...overrides,
    };
}

/** Loads the first page of unread groups and settles it. */
async function loadUnread(
    service: InboxService,
    ctrl: HttpTestingController,
    body: InboxUnreadPage,
): Promise<void> {
    const done = service.loadMoreUnread();
    ctrl.expectOne(`${INBOX}/unread?limit=10`).flush(body);
    await done;
}

describe('InboxService', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    describe('paging', () => {
        it('keeps paging when a page is empty but still has a cursor', async () => {
            const {service, ctrl} = setup();
            const done = service.loadMoreUnread();

            // Muting and permission filtering are applied after the page is taken, so this is
            // "keep going", not "you're done" - the single easiest thing to get wrong here.
            ctrl.expectOne(`${INBOX}/unread?limit=10`).flush(page({nextCursor: 'c1'}));
            await Promise.resolve();

            const second = ctrl.expectOne(`${INBOX}/unread?limit=10&cursor=c1`);
            second.flush(page({groups: [group()], nextCursor: 'c2'}));
            await done;

            expect(service.unread().length).toBe(1);
            expect(service.unreadHasMore()).toBe(true);
        });

        it('stops on a null cursor even though the page was empty', async () => {
            const {service, ctrl} = setup();
            const done = service.loadMoreUnread();

            ctrl.expectOne(`${INBOX}/unread?limit=10`).flush(page({nextCursor: null}));
            await done;

            expect(service.unread().length).toBe(0);
            expect(service.unreadHasMore()).toBe(false);
        });

        it('sends the cursor from the previous mentions page', async () => {
            const {service, ctrl} = setup();
            const first = service.loadMoreMentions();
            ctrl.expectOne(`${INBOX}/mentions?limit=25`)
                .flush({mentions: [mention()], nextCursor: 'm1'});
            await first;

            const second = service.loadMoreMentions();
            ctrl.expectOne(`${INBOX}/mentions?limit=25&cursor=m1`)
                .flush({mentions: [], nextCursor: null});
            await second;

            expect(service.mentions().length).toBe(1);
            expect(service.mentionsHasMore()).toBe(false);
        });
    });

    describe('open', () => {
        it('refetches from the first page rather than keeping the previous rows', async () => {
            const {service, ctrl} = setup();
            await loadUnread(service, ctrl, page({groups: [group()], nextCursor: 'c1'}));
            expect(service.unread().length).toBe(1);

            service.open();
            ctrl.expectOne(`${INBOX}/summary`)
                .flush({unreadChannelCount: 0, mentionCount: 0, taskCount: 0, capped: false});
            // No cursor: a keyset cursor held across a closed popout describes a list that has
            // since reordered.
            ctrl.expectOne(`${INBOX}/unread?limit=10`).flush(page({groups: [group()]}));
            ctrl.expectOne(`${INBOX}/mentions?limit=25`).flush({mentions: [], nextCursor: null});
            ctrl.expectOne(`${INBOX}/tasks?limit=25`).flush({tasks: [], truncated: false});
            await settle();

            expect(service.unread().length).toBe(1);
        });
    });

    describe('waiting on you', () => {
        it('replaces the list rather than appending - there is no cursor to append against', async () => {
            const {service, ctrl} = setup();

            const first = service.loadTasks();
            ctrl.expectOne(`${INBOX}/tasks?limit=25`).flush({tasks: [task()], truncated: true});
            await first;

            expect(service.tasks().length).toBe(1);
            expect(service.tasksTruncated()).toBe(true);

            const second = service.loadTasks();
            ctrl.expectOne(`${INBOX}/tasks?limit=25`)
                .flush({tasks: [task({targetId: 'deci_9', kind: 'DecisionVote'})], truncated: false});
            await second;

            // Doing a task removes it from the next answer - which is what makes a refetch the
            // right refresh, and appending flatly wrong.
            expect(service.tasks().length).toBe(1);
            expect(service.tasks()[0].targetId).toBe('deci_9');
        });

        it('counts tasks in the badge', async () => {
            const {service, ctrl} = setup();
            // A list channel holds no messages, so nothing else would ever light the badge for the
            // modules people most want reminding about.
            await loadSummary(service, ctrl, {unreadChannelCount: 1, mentionCount: 1, taskCount: 2});

            expect(service.badgeLabel()).toBe('4');
        });

        it('keeps the task count through a mark-all-read', async () => {
            const {service, ctrl} = setup();
            await loadSummary(service, ctrl, {unreadChannelCount: 3, taskCount: 2});

            const done = service.markAllRead();
            ctrl.expectOne(`${INBOX}/read-all`).flush(null);
            await done;

            // `read-all` marks messages read. A chore that is due is still due afterwards, and
            // zeroing it here would clear a badge the server puts straight back.
            expect(service.summary().taskCount).toBe(2);
            expect(service.badgeLabel()).toBe('2');
        });

        it('refetches the badge when a household alert says something started waiting', async () => {
            const {service, ctrl} = setup();
            await loadSummary(service, ctrl, {taskCount: 0});

            householdAlerts.next({
                guildId: 'gild_1',
                channelId: 'chan_chores',
                kind: 'chore.due',
                targetId: 'choc_1',
                title: 'Your turn',
                body: 'Bins',
            });

            ctrl.expectOne(`${INBOX}/summary`)
                .flush({unreadChannelCount: 0, mentionCount: 0, taskCount: 1, capped: false});
            await settle();

            expect(service.badgeLabel()).toBe('1');
        });
    });

    describe('dismissMention', () => {
        it('sends the mention row createdAt verbatim, not the message timestamp', async () => {
            const {service, ctrl} = setup();
            const load = service.loadMoreMentions();
            // The index is keyed on the row's own timestamp; re-deriving it from the message
            // would return 204 and delete nothing.
            ctrl.expectOne(`${INBOX}/mentions?limit=25`).flush({
                mentions: [mention({
                    createdAt: '2026-08-03T09:41:02.884Z',
                    message: message({createdAt: '2026-08-03T09:41:02.000Z'}),
                })],
                nextCursor: null,
            });
            await load;

            const dismissed = service.dismissMention(service.mentions()[0]);
            const req = ctrl.expectOne(
                `${INBOX}/mentions/mesg_1?createdAt=2026-08-03T09:41:02.884Z`);
            expect(req.request.method).toBe('DELETE');
            req.flush(null);
            await dismissed;

            expect(service.mentions().length).toBe(0);
        });

        it('restores the row when the delete fails', async () => {
            const {service, ctrl} = setup();
            const load = service.loadMoreMentions();
            ctrl.expectOne(`${INBOX}/mentions?limit=25`)
                .flush({mentions: [mention()], nextCursor: null});
            await load;

            const dismissed = service.dismissMention(service.mentions()[0]);
            ctrl.expectOne(r => r.url === `${INBOX}/mentions/mesg_1`)
                .flush(null, {status: 500, statusText: 'Server Error'});
            await dismissed;

            expect(service.mentions().length).toBe(1);
        });
    });

    describe('markChannelRead', () => {
        it('drops the row and decrements the badge optimistically', async () => {
            const {service, ctrl} = setup();
            await loadUnread(service, ctrl, page({groups: [group({mentionCount: 2})]}));
            await loadSummary(service, ctrl, {unreadChannelCount: 1, mentionCount: 5});

            const marked = service.markChannelRead('chan_1');
            // Both before the request is answered - the row must not linger until the server agrees.
            expect(service.unread().length).toBe(0);
            expect(service.summary().mentionCount).toBe(3);

            ctrl.expectOne(`${INBOX}/channels/chan_1/read`).flush(null);
            await marked;
        });

        it('puts the row back when the POST fails', async () => {
            const {service, ctrl} = setup();
            await loadUnread(service, ctrl, page({groups: [group()]}));

            const marked = service.markChannelRead('chan_1');
            ctrl.expectOne(`${INBOX}/channels/chan_1/read`)
                .flush(null, {status: 500, statusText: 'Server Error'});
            await marked;

            expect(service.unread().length).toBe(1);
        });
    });

    describe('badge', () => {
        it('counts unread channels alongside mentions', async () => {
            const {service, ctrl} = setup();
            await loadSummary(service, ctrl, {unreadChannelCount: 3, mentionCount: 6});

            expect(service.badgeLabel()).toBe('9');
        });

        it('shows a badge for unread channels even when nothing mentioned the user', async () => {
            const {service, ctrl} = setup();
            await loadSummary(service, ctrl, {unreadChannelCount: 3, mentionCount: 0});

            // The case the button exists for: a DM and a channel of replies, no ping in either.
            expect(service.badgeLabel()).toBe('3');
        });

        it('renders 99+ when the two counts sum past the cap', async () => {
            const {service, ctrl} = setup();
            await loadSummary(service, ctrl, {unreadChannelCount: 60, mentionCount: 60});

            expect(service.badgeLabel()).toBe('99+');
        });

        it('renders 99+ when the server reports the count as capped', async () => {
            const {service, ctrl} = setup();
            await loadSummary(service, ctrl, {unreadChannelCount: 4, mentionCount: 12, capped: true});

            expect(service.badgeLabel()).toBe('99+');
        });

        it('leaves a capped count alone rather than nudging it', async () => {
            const {service, ctrl} = setup();
            await loadSummary(service, ctrl, {mentionCount: 200, capped: true});

            hubHandlers.get('inbox.MentionAdded')?.({messageId: 'mesg_9'});

            // Past the cap the reported number is already a floor, and it renders the same either way.
            expect(service.summary().mentionCount).toBe(200);
            expect(service.badgeLabel()).toBe('99+');
        });

        it('is null when there is nothing waiting', async () => {
            const {service, ctrl} = setup();
            await loadSummary(service, ctrl, {mentionCount: 0});

            expect(service.badgeLabel()).toBeNull();
        });
    });

    describe('keeping the badge current', () => {
        it('fetches the count when the connection comes up, with the panel never opened', async () => {
            const {service, ctrl} = setup();

            connectionState.set(ConnectionState.Connected);
            TestBed.tick();

            ctrl.expectOne(`${INBOX}/summary`)
                .flush({unreadChannelCount: 2, mentionCount: 1, taskCount: 0, capped: false});
            await settle();

            // The whole point: this is a cold start, and `open` was never called.
            expect(service.badgeLabel()).toBe('3');
        });

        it('refetches on a reconnect, because nothing replays what the socket missed', async () => {
            const {service, ctrl} = setup();
            connectionState.set(ConnectionState.Connected);
            TestBed.tick();
            ctrl.expectOne(`${INBOX}/summary`)
                .flush({unreadChannelCount: 0, mentionCount: 0, taskCount: 0, capped: false});
            await settle();

            connectionState.set(ConnectionState.Connecting);
            TestBed.tick();
            // Nothing to ask while it is down.
            ctrl.expectNone(`${INBOX}/summary`);

            connectionState.set(ConnectionState.Connected);
            TestBed.tick();
            ctrl.expectOne(`${INBOX}/summary`)
                .flush({unreadChannelCount: 0, mentionCount: 4, taskCount: 0, capped: false});
            await settle();

            expect(service.badgeLabel()).toBe('4');
        });

        it('does not refetch when the connection reports connected twice', async () => {
            const {ctrl} = setup();
            connectionState.set(ConnectionState.Connected);
            TestBed.tick();
            ctrl.expectOne(`${INBOX}/summary`)
                .flush({unreadChannelCount: 0, mentionCount: 0, taskCount: 0, capped: false});
            await settle();

            connectionState.set(ConnectionState.Connected);
            TestBed.tick();

            ctrl.expectNone(`${INBOX}/summary`);
        });

        it('refetches once after a burst of channels is read elsewhere in the app', async () => {
            vi.useFakeTimers();
            try {
                const {service, ctrl} = setup();

                channelRead.next('chan_1');
                channelRead.next('chan_2');
                // Clicking through a server is one burst, not one request per stop.
                ctrl.expectNone(`${INBOX}/summary`);

                await vi.advanceTimersByTimeAsync(2_000);
                ctrl.expectOne(`${INBOX}/summary`)
                    .flush({unreadChannelCount: 0, mentionCount: 4, taskCount: 0, capped: false});
                await vi.advanceTimersByTimeAsync(0);

                expect(service.badgeLabel()).toBe('4');
            } finally {
                vi.useRealTimers();
            }
        });
    });

    describe('realtime', () => {
        it('bumps the badge on inbox.MentionAdded', async () => {
            const {service, ctrl} = setup();
            await loadSummary(service, ctrl, {mentionCount: 1});

            hubHandlers.get('inbox.MentionAdded')?.({messageId: 'mesg_9'});

            expect(service.summary().mentionCount).toBe(2);
        });

        it('clears everything on a read-all from another device', async () => {
            const {service, ctrl} = setup();
            await loadUnread(service, ctrl, page({groups: [group()]}));
            await loadSummary(service, ctrl, {unreadChannelCount: 1, mentionCount: 7});

            // `{all: true}` carries no channel id - a handler that only looks for one ignores it.
            const event: InboxReadStateChanged = {all: true};
            hubHandlers.get('inbox.ReadStateChanged')?.(event);

            expect(service.unread().length).toBe(0);
            expect(service.summary().mentionCount).toBe(0);
        });

        it('drops just the acked channel on a per-channel read state change', async () => {
            const {service, ctrl} = setup();
            await loadUnread(service, ctrl, page({
                groups: [
                    group(),
                    group({breadcrumb: breadcrumb({channelId: 'chan_2', channelName: 'dev'})}),
                ],
            }));

            hubHandlers.get('inbox.ReadStateChanged')?.(
                {channelId: 'chan_1', lastReadMessageId: 'mesg_1', mentionCount: 0});

            expect(service.unread().map(e => e.breadcrumb.channelId)).toEqual(['chan_2']);
        });
    });

    describe('previews', () => {
        it('renders groups and flags the tab when the message service is down', async () => {
            const {service, ctrl} = setup();
            // A 200, not an error: the counts and breadcrumbs come from a different service and
            // are still correct.
            await loadUnread(service, ctrl, page({
                groups: [group({previews: []})],
                previewsUnavailable: true,
            }));

            expect(service.unread().length).toBe(1);
            expect(service.previewsUnavailable()).toBe(true);
        });

        it('decodes a plaintext preview body', async () => {
            const {service, ctrl} = setup();
            await loadUnread(service, ctrl, page({groups: [group()]}));

            expect(service.unread()[0].previews[0].message.content).toBe(btoa('hello'));
            expect(service.unread()[0].previews[0].authorDisplayName).toBe('Ana');
        });

        it('maps the inbox numeric message type rather than indexing the app enum', async () => {
            const {service, ctrl} = setup();
            // 2 is GuildMemberJoin on the wire. The app enum has System at 1, so a naive ordinal
            // read would land on Invite here.
            await loadUnread(service, ctrl,
                page({groups: [group({previews: [message({type: 2})]})]}));

            expect(service.unread()[0].previews[0].message.type).toBe('GuildMemberJoin');
        });
    });
});
