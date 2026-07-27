import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {MessageService} from 'primeng/api';
import {BotInstallConsentComponent} from './bot-install-consent.component';
import {ApiConfigService} from '../../services/api-config.service';
import {BotAuthorizeInfoDto} from '../../dtos/response/bot-install.dto';
import {Permissions, stringifyPermissions} from '../../enums/permissions.enum';

const BASE = 'https://api.test.example/api/v1/bots';

const INFO: BotAuthorizeInfoDto = {
    applicationId: 'client_1',
    name: 'Test Bot',
    iconUrl: 'https://example.com/icon.png',
    description: 'A bot that does things.',
    guildId: 'g1',
    requestedPermissions: stringifyPermissions(Permissions.ViewChannel | Permissions.BanMembers),
    grantablePermissions: stringifyPermissions(Permissions.ViewChannel),
};

function setup(guildName?: string) {
    TestBed.configureTestingModule({
        imports: [BotInstallConsentComponent],
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            MessageService,
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
        ],
    });

    const fixture: ComponentFixture<BotInstallConsentComponent> = TestBed.createComponent(BotInstallConsentComponent);
    fixture.componentRef.setInput('clientId', 'client_1');
    fixture.componentRef.setInput('permissions', Permissions.ViewChannel | Permissions.BanMembers);
    fixture.componentRef.setInput('guildId', 'g1');
    if (guildName !== undefined) fixture.componentRef.setInput('guildName', guildName);
    const component = fixture.componentInstance;
    const ctrl = TestBed.inject(HttpTestingController);
    fixture.detectChanges();

    return {fixture, component, ctrl};
}

function flushInfo(ctrl: HttpTestingController, fixture: ComponentFixture<BotInstallConsentComponent>) {
    ctrl.expectOne(req => req.url === `${BASE}/oauth2/authorize` && req.method === 'GET').flush(INFO);
    fixture.detectChanges();
}

describe('BotInstallConsentComponent fetch', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('fetches authorize info for the given clientId/permissions/guildId', () => {
        const {ctrl} = setup('Guild Name');
        const req = ctrl.expectOne(req => req.url === `${BASE}/oauth2/authorize` && req.method === 'GET');
        expect(req.request.params.get('clientId')).toBe('client_1');
        expect(req.request.params.get('guildId')).toBe('g1');
        req.flush(INFO);
    });

    it('sets state to ready and exposes info on success', () => {
        const {component, ctrl, fixture} = setup('Guild Name');
        flushInfo(ctrl, fixture);
        expect(component.state()).toBe('ready');
        expect(component.info()).toEqual(INFO);
    });

    it('sets state to error when the fetch fails', () => {
        const {component, ctrl, fixture} = setup('Guild Name');
        ctrl.expectOne(req => req.url === `${BASE}/oauth2/authorize` && req.method === 'GET')
            .flush('boom', {status: 500, statusText: 'Server Error'});
        fixture.detectChanges();
        expect(component.state()).toBe('error');
    });
});

describe('BotInstallConsentComponent guild name resolution', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('uses the guildName input directly when provided (no extra fetch)', () => {
        const {component, ctrl, fixture} = setup('Provided Guild');
        flushInfo(ctrl, fixture);
        expect(component.resolvedGuildName()).toBe('Provided Guild');
    });

    it('fetches the guild to resolve its name when guildName is not provided', () => {
        const {component, ctrl, fixture} = setup(undefined);
        flushInfo(ctrl, fixture);
        const guildReq = ctrl.expectOne(`https://api.test.example/api/v1/guild/guilds/g1`);
        guildReq.flush({id: 'g1', name: 'Fetched Guild', description: '', ownerId: '', categories: [], channels: [], roles: []});
        fixture.detectChanges();
        expect(component.resolvedGuildName()).toBe('Fetched Guild');
    });
});

describe('BotInstallConsentComponent permission diffing', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('computes clampedAway as the permissions requested but not grantable', () => {
        const {component, ctrl, fixture} = setup('Guild Name');
        flushInfo(ctrl, fixture);
        expect(component.clampedAway()).toEqual(['BanMembers']);
    });
});

describe('BotInstallConsentComponent.confirm', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('POSTs the authorize request and emits installed on success', () => {
        const {component, ctrl, fixture} = setup('Guild Name');
        flushInfo(ctrl, fixture);

        const emitted: unknown[] = [];
        component.installed.subscribe(r => emitted.push(r));

        component.confirm();
        expect(component.state()).toBe('installing');

        const req = ctrl.expectOne(`${BASE}/oauth2/authorize`);
        expect(req.request.method).toBe('POST');
        expect(req.request.body).toEqual({
            clientId: 'client_1',
            guildId: 'g1',
            permissions: (Permissions.ViewChannel | Permissions.BanMembers).toString(),
        });
        req.flush({guildId: 'g1', grantedPermissions: stringifyPermissions(Permissions.ViewChannel)});

        expect(emitted).toEqual([{guildId: 'g1', grantedPermissions: stringifyPermissions(Permissions.ViewChannel)}]);
    });

    it('resets to ready (not error) on confirm failure, keeping info intact', () => {
        const {component, ctrl, fixture} = setup('Guild Name');
        flushInfo(ctrl, fixture);

        component.confirm();
        ctrl.expectOne(`${BASE}/oauth2/authorize`).flush('boom', {status: 403, statusText: 'Forbidden'});

        expect(component.state()).toBe('ready');
        expect(component.info()).toEqual(INFO);
    });
});
