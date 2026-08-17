import {TestBed} from '@angular/core/testing';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideHttpClient} from '@angular/common/http';
import {signal} from '@angular/core';
import {Subject} from 'rxjs';
import {BotCommandService} from './bot-command.service';
import {ApiConfigService} from './api-config.service';
import {GuildWebsocketService} from './guild-websocket.service';
import {NavigationService} from '../features/main-page/navigation.service';

const BASE = 'https://api.test.example/api/v1/bots';

function setup() {
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
            {
                provide: GuildWebsocketService,
                useValue: {
                    botInstalledObservable: new Subject(),
                    botUninstalledObservable: new Subject(),
                    messageObservable: new Subject(),
                },
            },
            // A DM workspace so the roster effect has no guild to fetch commands for - this spec is
            // about the modal-submit call, and a stray discovery GET would fail `verify()`.
            {provide: NavigationService, useValue: {workspace: signal({type: 'dms'})}},
        ],
    });
    return {
        service: TestBed.inject(BotCommandService),
        ctrl: TestBed.inject(HttpTestingController),
    };
}

describe('BotCommandService.submitModal', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('POSTs to the channel-scoped modal-submit route, not a message-scoped one', () => {
        const {service, ctrl} = setup();
        service.submitModal('gild_1', 'chan_1', {botUserId: 'bot_1', customId: 'feedback', components: []}).subscribe();

        const req = ctrl.expectOne(`${BASE}/guilds/gild_1/channels/chan_1/modal-submit`);
        expect(req.request.method).toBe('POST');
        req.flush(null, {status: 202, statusText: 'Accepted'});
    });

    it('sends the dto verbatim, keeping the components snake_case on the wire', () => {
        const {service, ctrl} = setup();
        service.submitModal('gild_1', 'chan_1', {
            botUserId: 'bot_1',
            customId: 'feedback',
            components: [{type: 1, components: [{type: 4, custom_id: 'summary', value: 'It broke'}]}],
        }).subscribe();

        const req = ctrl.expectOne(`${BASE}/guilds/gild_1/channels/chan_1/modal-submit`);
        expect(req.request.body).toEqual({
            botUserId: 'bot_1',
            customId: 'feedback',
            components: [{type: 1, components: [{type: 4, custom_id: 'summary', value: 'It broke'}]}],
        });
        req.flush(null, {status: 202, statusText: 'Accepted'});
    });

    it('does not retry a 404 the way invokeCommandWithRetry does - the command list is irrelevant here', () => {
        const {service, ctrl} = setup();
        let status = 0;
        service.submitModal('gild_1', 'chan_1', {botUserId: 'bot_1', customId: 'feedback', components: []})
            .subscribe({error: err => status = err.status});

        ctrl.expectOne(`${BASE}/guilds/gild_1/channels/chan_1/modal-submit`)
            .flush('Bot is not installed in this guild.', {status: 404, statusText: 'Not Found'});

        expect(status).toBe(404);
        ctrl.expectNone(`${BASE}/guilds/gild_1/commands`);
    });
});
