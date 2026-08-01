import {TestBed} from '@angular/core/testing';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideHttpClient} from '@angular/common/http';
import {MlsTransportService} from './mls-transport.service';
import {ApiConfigService} from './api-config.service';

const BASE = 'https://api.test.example';
const MLS = `${BASE}/api/v1/messaging`;

function setup() {
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
        ],
    });
    return {
        service: TestBed.inject(MlsTransportService),
        ctrl: TestBed.inject(HttpTestingController),
    };
}

describe('MlsTransportService', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    describe('commits', () => {
        it('fetches conversation commits above an epoch', () => {
            const {service, ctrl} = setup();
            service.getCommits('conv1', false, 4).subscribe();
            const req = ctrl.expectOne(r => r.url === `${MLS}/conversations/conv1/mls/commits`);
            expect(req.request.method).toBe('GET');
            expect(req.request.params.get('sinceEpoch')).toBe('4');
            req.flush([]);
        });

        it('routes channel commits to the channel path', () => {
            const {service, ctrl} = setup();
            service.getCommits('chan1', true, 0).subscribe();
            const req = ctrl.expectOne(r => r.url === `${MLS}/channels/chan1/mls/commits`);
            req.flush([]);
        });

        it('pins the generation when one is given', () => {
            const {service, ctrl} = setup();
            service.getCommits('conv1', false, 0, 2).subscribe();
            const req = ctrl.expectOne(r => r.url === `${MLS}/conversations/conv1/mls/commits`);
            expect(req.request.params.get('generation')).toBe('2');
            req.flush([]);
        });

        it('omits the generation when none is given, so the server picks the live one', () => {
            const {service, ctrl} = setup();
            service.getCommits('conv1', false, 0).subscribe();
            const req = ctrl.expectOne(r => r.url === `${MLS}/conversations/conv1/mls/commits`);
            expect(req.request.params.has('generation')).toBe(false);
            req.flush([]);
        });

        it('publishes a commit with its generation and welcomes', () => {
            const {service, ctrl} = setup();
            service.publishCommit('conv1', false, {
                epoch: 5,
                commit: 'Y29tbWl0',
                senderDeviceId: 'device-a',
                generation: 2,
                welcomes: [{deviceId: 'device-b', userId: 'user-2', welcome: 'd2VsY29tZQ=='}],
            }).subscribe();

            const req = ctrl.expectOne(`${MLS}/conversations/conv1/mls/commits`);
            expect(req.request.method).toBe('POST');
            expect(req.request.body.epoch).toBe(5);
            expect(req.request.body.generation).toBe(2);
            expect(req.request.body.welcomes).toHaveLength(1);
            req.flush({contextId: 'conv1', generation: 2, epoch: 5});
        });
    });

    describe('welcomes', () => {
        it('scopes the fetch to one device', () => {
            const {service, ctrl} = setup();
            service.getPendingWelcomes('device-a').subscribe();
            const req = ctrl.expectOne(r => r.url === `${MLS}/conversations/welcomes`);
            expect(req.request.method).toBe('GET');
            // Sending the device id is what makes the read non-destructive server-side; without it
            // the server falls back to consuming on read.
            expect(req.request.params.get('deviceId')).toBe('device-a');
            req.flush([]);
        });

        it('acknowledges by id, scoped to this device', () => {
            const {service, ctrl} = setup();
            service.ackWelcomes(['pewe_1', 'pewe_2'], 'device-a').subscribe();
            const req = ctrl.expectOne(`${MLS}/conversations/welcomes/ack`);
            expect(req.request.method).toBe('POST');
            // Scoped by user alone, one device could acknowledge a Welcome addressed to another
            // device's leaf - bytes it cannot use, and which the owning device then never sees.
            expect(req.request.body).toEqual({welcomeIds: ['pewe_1', 'pewe_2'], deviceId: 'device-a'});
            req.flush({acknowledged: 2});
        });
    });

    describe('channel toggles', () => {
        it('enables with the group it just built', () => {
            const {service, ctrl} = setup();
            service.enableChannelEncryption('chan1', {
                mlsGroupId: 'Z3JvdXA=',
                epoch: 1,
                welcomes: [],
            }).subscribe();
            const req = ctrl.expectOne(`${MLS}/channels/chan1/mls/enable`);
            expect(req.request.method).toBe('POST');
            expect(req.request.body.mlsGroupId).toBe('Z3JvdXA=');
            req.flush({contextId: 'chan1', encrypted: true, generation: 1});
        });

        it('disables without a body', () => {
            const {service, ctrl} = setup();
            service.disableChannelEncryption('chan1').subscribe();
            const req = ctrl.expectOne(`${MLS}/channels/chan1/mls/disable`);
            expect(req.request.method).toBe('POST');
            req.flush({contextId: 'chan1', encrypted: false, terminatedGeneration: 1});
        });

        it('reads state from the matching context path', () => {
            const {service, ctrl} = setup();
            service.getState('chan1', true).subscribe();
            ctrl.expectOne(`${MLS}/channels/chan1/mls/state`).flush({
                contextId: 'chan1', encrypted: false, generations: [],
            });
        });
    });

    it('escapes ids so a crafted context id cannot reshape the path', () => {
        const {service, ctrl} = setup();
        service.getState('a/b', false).subscribe();
        ctrl.expectOne(`${MLS}/conversations/a%2Fb/mls/state`).flush({
            contextId: 'a/b', encrypted: false, generations: [],
        });
    });
});
