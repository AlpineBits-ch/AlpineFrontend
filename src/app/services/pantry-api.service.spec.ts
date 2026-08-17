import {TestBed} from '@angular/core/testing';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideHttpClient} from '@angular/common/http';
import {PantryApiService} from './pantry-api.service';
import {ApiConfigService} from './api-config.service';

const BASE = 'https://api.test.example';
const GUILD = `${BASE}/api/v1/guild`;

function setup() {
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
        ],
    });
    return {
        service: TestBed.inject(PantryApiService),
        ctrl: TestBed.inject(HttpTestingController),
    };
}

describe('PantryApiService', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('listItems GETs the channel-scoped route', () => {
        const {service, ctrl} = setup();
        service.listItems('chan_1').subscribe();
        const req = ctrl.expectOne(`${GUILD}/channels/chan_1/pantry-items`);
        expect(req.request.method).toBe('GET');
        req.flush([]);
    });

    it('createItem POSTs the body verbatim, including a null threshold', () => {
        const {service, ctrl} = setup();
        service.createItem('chan_1', {name: 'Rice', quantity: 2, lowThreshold: null}).subscribe();
        const req = ctrl.expectOne(`${GUILD}/channels/chan_1/pantry-items`);
        expect(req.request.method).toBe('POST');
        expect(req.request.body).toEqual({name: 'Rice', quantity: 2, lowThreshold: null});
        req.flush({});
    });

    it('createItem sends a 0 threshold rather than dropping it', () => {
        const {service, ctrl} = setup();
        service.createItem('chan_1', {name: 'Rice', quantity: 2, lowThreshold: 0}).subscribe();
        const req = ctrl.expectOne(`${GUILD}/channels/chan_1/pantry-items`);
        expect(req.request.body.lowThreshold).toBe(0);
        req.flush({});
    });

    it('updateItem PATCHes by item id with no channel in the path', () => {
        const {service, ctrl} = setup();
        service.updateItem('pitm_1', {quantity: 1}).subscribe();
        const req = ctrl.expectOne(`${GUILD}/pantry-items/pitm_1`);
        expect(req.request.method).toBe('PATCH');
        expect(req.request.body).toEqual({quantity: 1});
        req.flush({});
    });

    it('deleteItem DELETEs by item id', () => {
        const {service, ctrl} = setup();
        service.deleteItem('pitm_1').subscribe();
        const req = ctrl.expectOne(`${GUILD}/pantry-items/pitm_1`);
        expect(req.request.method).toBe('DELETE');
        req.flush(null);
    });

    it('expiring is guild-scoped, not channel-scoped', () => {
        const {service, ctrl} = setup();
        service.expiring('gild_1', 7).subscribe();
        const req = ctrl.expectOne(r => r.url === `${GUILD}/guilds/gild_1/pantry/expiring`);
        expect(req.request.method).toBe('GET');
        expect(req.request.params.get('days')).toBe('7');
        req.flush([]);
    });

    it('sends no days at all by default, so each pantry applies its own expiryWarningDays', () => {
        const {service, ctrl} = setup();
        service.expiring('gild_1').subscribe();
        const req = ctrl.expectOne(r => r.url === `${GUILD}/guilds/gild_1/pantry/expiring`);
        // A flat number here overrides every pantry at once, which makes a 14-day freezer report
        // nothing until two days out.
        expect(req.request.params.has('days')).toBe(false);
        req.flush([]);
    });

    it('treats an explicit null the same as omitting it, not as days=null', () => {
        const {service, ctrl} = setup();
        service.expiring('gild_1', null).subscribe();
        const req = ctrl.expectOne(r => r.url === `${GUILD}/guilds/gild_1/pantry/expiring`);
        expect(req.request.params.has('days')).toBe(false);
        req.flush([]);
    });

    it('getConfig GETs the channel config', () => {
        const {service, ctrl} = setup();
        service.getConfig('chan_1').subscribe();
        const req = ctrl.expectOne(`${GUILD}/channels/chan_1/pantry/config`);
        expect(req.request.method).toBe('GET');
        req.flush({channelId: 'chan_1', restockListChannelId: null, expiryWarningDays: 3});
    });

    it('updateItem sends clearLowThreshold rather than a null the server would ignore', () => {
        const {service, ctrl} = setup();
        service.updateItem('pitm_1', {clearLowThreshold: true}).subscribe();
        const req = ctrl.expectOne(`${GUILD}/pantry-items/pitm_1`);
        expect(req.request.body).toEqual({clearLowThreshold: true});
        req.flush({});
    });

    it('updateItem sends clearExpiresAt to drop a date', () => {
        const {service, ctrl} = setup();
        service.updateItem('pitm_1', {clearExpiresAt: true}).subscribe();
        const req = ctrl.expectOne(`${GUILD}/pantry-items/pitm_1`);
        expect(req.request.body).toEqual({clearExpiresAt: true});
        req.flush({});
    });

    it('putConfig PUTs clearRestockList to switch the loop off, with no id alongside it', () => {
        const {service, ctrl} = setup();
        service.putConfig('chan_1', {clearRestockList: true, expiryWarningDays: 5}).subscribe();
        const req = ctrl.expectOne(`${GUILD}/channels/chan_1/pantry/config`);
        expect(req.request.method).toBe('PUT');
        expect(req.request.body).toEqual({clearRestockList: true, expiryWarningDays: 5});
        req.flush({channelId: 'chan_1', restockListChannelId: null, expiryWarningDays: 5});
    });

    it('putConfig PUTs the id when a list is chosen', () => {
        const {service, ctrl} = setup();
        service.putConfig('chan_1', {restockListChannelId: 'chan_list', expiryWarningDays: 5}).subscribe();
        const req = ctrl.expectOne(`${GUILD}/channels/chan_1/pantry/config`);
        expect(req.request.body).toEqual({restockListChannelId: 'chan_list', expiryWarningDays: 5});
        req.flush({channelId: 'chan_1', restockListChannelId: 'chan_list', expiryWarningDays: 5});
    });
});
