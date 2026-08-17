import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService, TranslateService} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';
import {FollowChannelDialogComponent} from './follow-channel-dialog.component';
import {ApiConfigService} from '../../../../services/api-config.service';

const BASE = 'https://api.test.example';
const FOLLOW_URL = `${BASE}/api/v1/guild/channels/src1/followers`;

function setup() {
    TestBed.configureTestingModule({
        imports: [FollowChannelDialogComponent],
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService({defaultLanguage: 'en'}),
            MessageService,
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
        ],
    }).compileComponents();

    const fixture: ComponentFixture<FollowChannelDialogComponent> = TestBed.createComponent(
        FollowChannelDialogComponent,
    );
    fixture.componentRef.setInput('sourceChannelId', 'src1');
    fixture.componentRef.setInput('sourceChannelName', 'announcements');
    fixture.componentRef.setInput('visible', true);
    const component = fixture.componentInstance;
    const ctrl = TestBed.inject(HttpTestingController);

    // The constructor eagerly loads the guild picker's options; irrelevant to the error-mapping behaviour under test here, so just drain it.
    ctrl.expectOne(r => r.url === `${BASE}/api/v1/guild/guilds`).flush([]);

    // Bypass the Select-driven guild/channel pickers and go straight to a submittable state, since these specs are only about what confirm() does with the HTTP response.
    (
        component as unknown as {
            selectedGuildId: {set(v: string): void};
            selectedChannelId: {set(v: string): void};
        }
    ).selectedGuildId.set('g1');
    (
        component as unknown as {
            selectedGuildId: {set(v: string): void};
            selectedChannelId: {set(v: string): void};
        }
    ).selectedChannelId.set('tgt1');

    return {fixture, component, ctrl};
}

function confirm(component: FollowChannelDialogComponent): void {
    (component as unknown as {confirm(): void}).confirm();
}

describe('FollowChannelDialogComponent confirm() error mapping', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('maps a 409 response to the ALREADY_FOLLOWING inline error, not a toast', () => {
        const {component, ctrl} = setup();
        const translate = TestBed.inject(TranslateService);
        const instantSpy = vi.spyOn(translate, 'instant');
        const messageService = TestBed.inject(MessageService);
        const addSpy = vi.spyOn(messageService, 'add');

        confirm(component);
        ctrl.expectOne(FOLLOW_URL).flush('conflict', {status: 409, statusText: 'Conflict'});

        expect((component as unknown as {inlineError: () => string | null}).inlineError()).toBe(
            'FOLLOW_CHANNEL.ALREADY_FOLLOWING',
        );
        expect(instantSpy).toHaveBeenCalledWith('FOLLOW_CHANNEL.ALREADY_FOLLOWING');
        expect(addSpy).not.toHaveBeenCalled();
    });

    it('maps a 403 response to the NEED_MANAGE_CHANNEL inline error, not a toast', () => {
        const {component, ctrl} = setup();
        const messageService = TestBed.inject(MessageService);
        const addSpy = vi.spyOn(messageService, 'add');

        confirm(component);
        ctrl.expectOne(FOLLOW_URL).flush('forbidden', {status: 403, statusText: 'Forbidden'});

        expect((component as unknown as {inlineError: () => string | null}).inlineError()).toBe(
            'FOLLOW_CHANNEL.NEED_MANAGE_CHANNEL',
        );
        expect(addSpy).not.toHaveBeenCalled();
    });

    it('falls through to toast.httpError for any other status, leaving the inline error unset', () => {
        const {component, ctrl} = setup();
        const messageService = TestBed.inject(MessageService);
        const addSpy = vi.spyOn(messageService, 'add');

        confirm(component);
        ctrl.expectOne(FOLLOW_URL).flush('boom', {status: 500, statusText: 'Internal Server Error'});

        expect((component as unknown as {inlineError: () => string | null}).inlineError()).toBeNull();
        expect(addSpy).toHaveBeenCalledTimes(1);
        expect(addSpy.mock.calls[0][0]).toEqual(expect.objectContaining({severity: 'error'}));
    });

    it('releases submitting() after any error so the form is resubmittable', () => {
        const {component, ctrl} = setup();

        confirm(component);
        ctrl.expectOne(FOLLOW_URL).flush('boom', {status: 500, statusText: 'Internal Server Error'});

        expect((component as unknown as {submitting: () => boolean}).submitting()).toBe(false);
    });
});
