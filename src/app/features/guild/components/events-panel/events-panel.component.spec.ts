import {ComponentFixture, TestBed} from '@angular/core/testing';
import {signal, WritableSignal} from '@angular/core';
import {provideTranslateService} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';
import {Observable, Subject} from 'rxjs';
import {EventsPanelComponent} from './events-panel.component';
import {ScheduledEventService} from '../../../../services/scheduled-event.service';
import {GuildWebsocketService} from '../../../../services/guild-websocket.service';
import {ProfileService} from '../../../../services/profile.service';
import {VoiceChannelService} from '../../../../services/voice-channel.service';
import {ToastService} from '../../../../services/toast.service';
import {MinuteClockService} from '../../../../services/minute-clock.service';
import {ScheduledEventDto, ScheduledEventStatus} from '../../../../dtos/response/scheduled-event.dto';
import {provideFakePlatform} from '../../../../platform/testing/provide-fake-platform';

// Local-time components, not a UTC string: the day grouping compares local calendar days.
const NOW = new Date(2026, 7, 1, 12, 0, 0).getTime();
const MINUTE = 60 * 1000;

function event(id: string, overrides: Partial<ScheduledEventDto> = {}): ScheduledEventDto {
    return {
        id,
        guildId: 'g1',
        creatorUserId: 'u1',
        title: `Event ${id}`,
        description: null,
        startsAt: new Date(NOW + 60 * MINUTE).toISOString(),
        endsAt: null,
        location: null,
        voiceChannelId: null,
        status: ScheduledEventStatus.Scheduled,
        interestedCount: 0,
        isInterested: false,
        ...overrides,
    };
}

class FakeScheduledEventService {
    listPending: Subject<ScheduledEventDto[]>[] = [];

    list(_guildId: string): Observable<ScheduledEventDto[]> {
        const subject = new Subject<ScheduledEventDto[]>();
        this.listPending.push(subject);
        return subject.asObservable();
    }
}

class FakeGuildWebsocketService {
    eventCreatedObservable = new Subject<any>();
    eventUpdatedObservable = new Subject<any>();
    eventCancelledObservable = new Subject<any>();
}

function setup(events: ScheduledEventDto[], memberPermissions = '') {
    const api = new FakeScheduledEventService();
    // The clock is faked rather than pinned through the component, so the split depends on a value the test owns instead of on wall time.
    const now: WritableSignal<number> = signal(NOW);

    TestBed.configureTestingModule({
        imports: [EventsPanelComponent],
        providers: [
            provideFakePlatform(),
            provideTranslateService({defaultLanguage: 'en'}),
            MessageService,
            {provide: ScheduledEventService, useValue: api},
            {provide: GuildWebsocketService, useValue: new FakeGuildWebsocketService()},
            {provide: ProfileService, useValue: {ownProfile: signal(undefined)}},
            {
                provide: VoiceChannelService,
                useValue: {
                    joinedChannelId: () => null,
                    joinChannel: () => undefined,
                    channelParticipants: signal(new Map()),
                },
            },
            {provide: ToastService, useValue: {success: () => undefined, httpError: () => undefined}},
            {provide: MinuteClockService, useValue: {now, retain: () => undefined}},
        ],
    });

    const fixture: ComponentFixture<EventsPanelComponent> = TestBed.createComponent(EventsPanelComponent);
    fixture.componentRef.setInput('guildId', 'g1');
    fixture.componentRef.setInput('memberPermissions', memberPermissions);
    fixture.detectChanges();

    api.listPending[0].next(events);
    api.listPending[0].complete();
    fixture.detectChanges();

    const component = fixture.componentInstance;
    const ids = (list: ScheduledEventDto[]) => list.map(e => e.id);

    return {
        fixture,
        component,
        now,
        live: () => ids(component['live']()),
        upcoming: () => ids(component['upcoming']()),
        past: () => ids(component['past']()),
        groups: () => component['upcomingGroups']()
            .map(g => [g.bucket, ids(g.events)] as [string, string[]]),
    };
}

describe('EventsPanelComponent live/upcoming/past split', () => {
    it('files an event that has started but not ended under live, not upcoming', () => {
        const {live, upcoming, past} = setup([
            event('running', {
                startsAt: new Date(NOW - 30 * MINUTE).toISOString(),
                endsAt: new Date(NOW + 30 * MINUTE).toISOString(),
            }),
        ]);

        expect(live()).toEqual(['running']);
        expect(upcoming()).toEqual([]);
        expect(past()).toEqual([]);
    });

    it('keeps a just-started event with no end time live rather than filing it under past', () => {
        const {live, past} = setup([
            event('open-ended', {startsAt: new Date(NOW - MINUTE).toISOString(), endsAt: null}),
        ]);

        expect(live()).toEqual(['open-ended']);
        expect(past()).toEqual([]);
    });

    it('treats a blank endsAt like an absent one instead of dropping the event from every list', () => {
        const {live, upcoming, past} = setup([
            event('blank-future', {startsAt: new Date(NOW + MINUTE).toISOString(), endsAt: ''}),
            event('blank-running', {startsAt: new Date(NOW - MINUTE).toISOString(), endsAt: ''}),
        ]);

        expect(upcoming()).toEqual(['blank-future']);
        expect(live()).toEqual(['blank-running']);
        expect(past()).toEqual([]);
    });

    it('walks an event from upcoming to live to past as the clock advances', () => {
        const {now, live, upcoming, past} = setup([
            event('e1', {
                startsAt: new Date(NOW + 10 * MINUTE).toISOString(),
                endsAt: new Date(NOW + 20 * MINUTE).toISOString(),
            }),
        ]);

        expect(upcoming()).toEqual(['e1']);

        now.set(NOW + 15 * MINUTE);
        expect(live()).toEqual(['e1']);
        expect(upcoming()).toEqual([]);

        now.set(NOW + 21 * MINUTE);
        expect(past()).toEqual(['e1']);
        expect(live()).toEqual([]);
    });

    it('orders past events most recent first', () => {
        const {past} = setup([
            event('older', {
                startsAt: new Date(NOW - 300 * MINUTE).toISOString(),
                endsAt: new Date(NOW - 290 * MINUTE).toISOString(),
            }),
            event('newer', {
                startsAt: new Date(NOW - 200 * MINUTE).toISOString(),
                endsAt: new Date(NOW - 190 * MINUTE).toISOString(),
            }),
        ]);

        expect(past()).toEqual(['newer', 'older']);
    });
});

describe('EventsPanelComponent day grouping', () => {
    it('groups upcoming events by calendar day in start order', () => {
        const {groups} = setup([
            event('today-1', {startsAt: new Date(2026, 7, 1, 18, 0).toISOString()}),
            event('today-2', {startsAt: new Date(2026, 7, 1, 20, 0).toISOString()}),
            event('tomorrow-1', {startsAt: new Date(2026, 7, 2, 9, 0).toISOString()}),
            event('later-1', {startsAt: new Date(2026, 7, 5, 9, 0).toISOString()}),
        ]);

        expect(groups()).toEqual([
            ['today', ['today-1', 'today-2']],
            ['tomorrow', ['tomorrow-1']],
            ['later', ['later-1']],
        ]);
    });

    it('gives two separate later days their own groups', () => {
        const {groups} = setup([
            event('a', {startsAt: new Date(2026, 7, 5, 9, 0).toISOString()}),
            event('b', {startsAt: new Date(2026, 7, 6, 9, 0).toISOString()}),
        ]);

        expect(groups().map(([bucket]) => bucket)).toEqual(['later', 'later']);
        expect(groups().map(([, ids]) => ids)).toEqual([['a'], ['b']]);
    });
});

describe('EventsPanelComponent empty state', () => {
    it('stays out of the empty state while an event is live', () => {
        const {component} = setup([
            event('running', {
                startsAt: new Date(NOW - MINUTE).toISOString(),
                endsAt: new Date(NOW + MINUTE).toISOString(),
            }),
        ]);

        expect(component['showEmpty']()).toBe(false);
    });

    it('shows the empty state when everything has finished', () => {
        const {component} = setup([
            event('done', {
                startsAt: new Date(NOW - 300 * MINUTE).toISOString(),
                endsAt: new Date(NOW - 290 * MINUTE).toISOString(),
            }),
        ]);

        expect(component['showEmpty']()).toBe(true);
    });
});
