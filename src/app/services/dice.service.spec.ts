import {TestBed} from '@angular/core/testing';
import {Subject} from 'rxjs';
import {describe, expect, it} from 'vitest';

import {DiceService} from './dice.service';
import {RoleplayApi} from './roleplay-api.service';
import {GuildWebsocketService} from './guild-websocket.service';

function setup() {
    const ws = {diceRolledObservable: new Subject<any>()};
    TestBed.configureTestingModule({
        providers: [
            {provide: RoleplayApi, useValue: {}},
            {provide: GuildWebsocketService, useValue: ws},
        ],
    });
    const service = TestBed.inject(DiceService);
    // The hub is only reached on the first read, which is what the tray does when it opens.
    service.recent('c1');
    return {service, ws};
}

function rolled(over: Record<string, unknown> = {}) {
    return {
        guildId: 'g1',
        channelId: 'c1',
        rollId: 'dr_1',
        messageId: 'm_1',
        personaId: 'per_1',
        expression: '4d6kh3',
        total: 14,
        breakdown: '[5, 4, ~1, 5]',
        visibility: 'Public',
        createdAt: '2026-08-18T10:00:00Z',
        ...over,
    };
}

describe('DiceService roll history', () => {
    it('offers back what the table rolled, not only this window', () => {
        const {service, ws} = setup();

        ws.diceRolledObservable.next(rolled());

        expect(service.recent('c1')).toEqual(['4d6kh3']);
    });

    it('keeps the history per channel', () => {
        const {service, ws} = setup();

        ws.diceRolledObservable.next(rolled({channelId: 'c2', expression: '1d20'}));

        expect(service.recent('c1')).toEqual([]);
        expect(service.recent('c2')).toEqual(['1d20']);
    });

    it('moves a repeated expression back to the front rather than doubling it', () => {
        const {service, ws} = setup();

        ws.diceRolledObservable.next(rolled({expression: '1d20'}));
        ws.diceRolledObservable.next(rolled({expression: '2d6'}));
        ws.diceRolledObservable.next(rolled({expression: '1d20'}));

        expect(service.recent('c1')).toEqual(['1d20', '2d6']);
    });
});
