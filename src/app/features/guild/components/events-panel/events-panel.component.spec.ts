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
import {ScheduledEventDto, ScheduledEventStatus} from '../../../../dtos/response/scheduled-event.dto';

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0); // 2026-08-01T12:00:00Z

function event(id: string, overrides: Partial<ScheduledEventDto> = {}): ScheduledEventDto {
    return {
        id,
        guildId: 'g1',
        creatorUserId: 'u1',
        title: `Event ${id}`,
        description: null,
        startsAt: new Date(NOW + 60 * 60 * 1000).toISOString(),
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

    TestBed.configureTestingModule({
        imports: [EventsPanelComponent],
        providers: [
            provideTranslateService({defaultLanguage: 'en'}),
            MessageService,
            {provide: ScheduledEventService, useValue: api},
            {provide: GuildWebsocketService, useValue: new FakeGuildWebsocketService()},
            {provide: ProfileService, useValue: {ownProfile: signal(undefined)}},
            {provide: VoiceChannelService, useValue: {joinedChannelId: () => null, joinChannel: () => undefined}},
            {provide: ToastService, useValue: {success: () => undefined, httpError: () => undefined}},
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
    // The component's own clock signal is private; pinning it makes the
    // upcoming/past split deterministic instead of dependent on wall time.
    const now = component['now'] as WritableSignal<number>;
    now.set(NOW);

    return {
        fixture,
        component,
        now,
        upcoming: () => (component['upcoming']() as ScheduledEventDto[]).map(e => e.id),
        past: () => (component['past']() as ScheduledEventDto[]).map(e => e.id),
    };
}

describe('EventsPanelComponent upcoming/past split', () => {
    it('keeps an event that has started but not ended in upcoming', () => {
        const {upcoming, past} = setup([
            event('running', {
                startsAt: new Date(NOW - 30 * 60 * 1000).toISOString(),
                endsAt: new Date(NOW + 30 * 60 * 1000).toISOString(),
            }),
        ]);

        expect(upcoming()).toEqual(['running']);
        expect(past()).toEqual([]);
    });

    it('falls back to startsAt when endsAt is null', () => {
        const {upcoming, past} = setup([
            event('future', {startsAt: new Date(NOW + 60 * 1000).toISOString(), endsAt: null}),
            event('finished', {startsAt: new Date(NOW - 60 * 1000).toISOString(), endsAt: null}),
        ]);

        expect(upcoming()).toEqual(['future']);
        expect(past()).toEqual(['finished']);
    });

    it('treats a blank endsAt like an absent one instead of dropping the event from both lists', () => {
        // `new Date('')` is NaN, and NaN compares false in both directions - without the
        // fallback the event would vanish from upcoming AND past.
        const {upcoming, past} = setup([
            event('blank-future', {startsAt: new Date(NOW + 60 * 1000).toISOString(), endsAt: ''}),
            event('blank-past', {startsAt: new Date(NOW - 60 * 1000).toISOString(), endsAt: ''}),
        ]);

        expect(upcoming()).toEqual(['blank-future']);
        expect(past()).toEqual(['blank-past']);
    });

    it('moves an event from upcoming to past as the clock advances', () => {
        const {now, upcoming, past} = setup([
            event('e1', {
                startsAt: new Date(NOW + 10 * 60 * 1000).toISOString(),
                endsAt: new Date(NOW + 20 * 60 * 1000).toISOString(),
            }),
        ]);

        expect(upcoming()).toEqual(['e1']);
        expect(past()).toEqual([]);

        now.set(NOW + 21 * 60 * 1000);

        expect(upcoming()).toEqual([]);
        expect(past()).toEqual(['e1']);
    });
});
