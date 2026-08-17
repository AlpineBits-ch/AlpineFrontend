import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {BotInstallGuildPickerComponent} from './bot-install-guild-picker.component';
import {ApiConfigService} from '../../services/api-config.service';
import {ManageableGuildDto} from '../../dtos/response/bot-install.dto';

const BASE = 'https://api.test.example/api/v1/bots';

const GUILDS: ManageableGuildDto[] = [
    {id: 'g1', name: 'Alpha Server', description: '', installed: false},
    {id: 'g2', name: 'Beta Server', description: '', installed: true},
];

function setup() {
    TestBed.configureTestingModule({
        imports: [BotInstallGuildPickerComponent],
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
        ],
    });

    const fixture: ComponentFixture<BotInstallGuildPickerComponent> = TestBed.createComponent(
        BotInstallGuildPickerComponent,
    );
    fixture.componentRef.setInput('clientId', 'client_1');
    const component = fixture.componentInstance;
    const ctrl = TestBed.inject(HttpTestingController);
    fixture.detectChanges();

    return {fixture, component, ctrl};
}

describe('BotInstallGuildPickerComponent', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('fetches manageable guilds for the given clientId on init', () => {
        const {ctrl} = setup();
        const req = ctrl.expectOne(`${BASE}/guilds/manageable?clientId=client_1`);
        expect(req.request.method).toBe('GET');
        req.flush(GUILDS);
    });

    it('exposes the fetched guilds', () => {
        const {component, ctrl, fixture} = setup();
        ctrl.expectOne(`${BASE}/guilds/manageable?clientId=client_1`).flush(GUILDS);
        fixture.detectChanges();
        expect(component.guilds()).toEqual(GUILDS);
    });

    it('sets error() true when the fetch fails', () => {
        const {component, ctrl, fixture} = setup();
        ctrl.expectOne(`${BASE}/guilds/manageable?clientId=client_1`).flush('boom', {
            status: 500,
            statusText: 'Server Error',
        });
        fixture.detectChanges();
        expect(component.error()).toBe(true);
    });

    it('filters guilds by search text case-insensitively', () => {
        const {component, ctrl, fixture} = setup();
        ctrl.expectOne(`${BASE}/guilds/manageable?clientId=client_1`).flush(GUILDS);
        fixture.detectChanges();

        component.search.set('beta');
        expect(component.filteredGuilds()).toEqual([GUILDS[1]]);
    });

    it('returns all guilds when search is empty', () => {
        const {component, ctrl, fixture} = setup();
        ctrl.expectOne(`${BASE}/guilds/manageable?clientId=client_1`).flush(GUILDS);
        fixture.detectChanges();

        expect(component.filteredGuilds()).toEqual(GUILDS);
    });

    it('emits guildSelected with the guild id when a row is selected', () => {
        const {component, ctrl, fixture} = setup();
        ctrl.expectOne(`${BASE}/guilds/manageable?clientId=client_1`).flush(GUILDS);
        fixture.detectChanges();

        const emitted: string[] = [];
        component.guildSelected.subscribe((id: string) => emitted.push(id));

        component.selectGuild(GUILDS[0]);
        expect(emitted).toEqual(['g1']);
    });
});
