import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';
import {ReportDialogComponent} from './report-dialog.component';
import {ReportDialogService} from '../../services/report-dialog.service';
import {ApiConfigService} from '../../services/api-config.service';
import {MessageStore} from '../../stores/message.store';
import {RelationshipStore} from '../../stores/relationship.store';
import {ProfileService} from '../../services/profile.service';

async function setup() {
    // configureTestingModule must not run against a TestBed another spec file left
    // instantiated - see message.component.spec.ts for the same guard.
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
        imports: [ReportDialogComponent],
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService({defaultLanguage: 'en'}),
            MessageService,
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
            // The stores' dependency chains reach MlsService / Tauri plugins, unusable under
            // jsdom. Nothing in the escape path reads more than these.
            {provide: MessageStore, useValue: {entities: () => []}},
            {provide: RelationshipStore, useValue: {blocked: () => []}},
            {provide: ProfileService, useValue: {getCachedByUserId: () => undefined}},
        ],
    }).compileComponents();

    const service = TestBed.inject(ReportDialogService);
    service.open({
        kind: 'Message',
        subjectId: 'm1',
        targetUserId: 'u1',
        targetName: 'Someone',
        channelId: 'chan1',
    });

    const fixture: ComponentFixture<ReportDialogComponent> = TestBed.createComponent(ReportDialogComponent);
    fixture.detectChanges();
    await fixture.whenStable();

    return {fixture, service};
}

function pressEscape(): void {
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
}

describe('ReportDialogComponent dismissal', () => {
    it('closes on escape once the user has interacted with the form', async () => {
        const {fixture, service} = await setup();

        // Whatever the user clicked first - a reason, the evidence toggle - leaves the
        // dialog's own inputs unchanged, which is exactly the state escape has to survive.
        const reasonButton = fixture.nativeElement.querySelector('button[type="button"]') as HTMLButtonElement;
        expect(reasonButton).toBeTruthy();
        reasonButton.click();
        fixture.detectChanges();
        await fixture.whenStable();

        pressEscape();
        fixture.detectChanges();
        await fixture.whenStable();

        expect(service.subject()).toBeNull();
    });

    it('closes on escape before any interaction', async () => {
        const {fixture, service} = await setup();

        pressEscape();
        fixture.detectChanges();
        await fixture.whenStable();

        expect(service.subject()).toBeNull();
    });

    it('closes on escape from the confirmation stage', async () => {
        const {fixture, service} = await setup();
        const ctrl = TestBed.inject(HttpTestingController);

        // The component keeps its state protected; other specs in this codebase reach
        // protected internals the same way - via a narrow structural cast.
        const internal = fixture.componentInstance as unknown as {
            reason: {set(value: string): void};
            submit(): void;
        };
        internal.reason.set('Spam');
        internal.submit();
        fixture.detectChanges();
        ctrl.expectOne('https://api.test.example/api/v1/reports').flush({merged: false});
        fixture.detectChanges();
        await fixture.whenStable();

        pressEscape();
        fixture.detectChanges();
        await fixture.whenStable();

        expect(service.subject()).toBeNull();
    });
});
