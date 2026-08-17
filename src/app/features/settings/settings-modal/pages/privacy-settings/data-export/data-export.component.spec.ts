/** The download control on a host where the download cannot happen. */
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';
import {OAuthService} from 'angular-oauth2-oidc';
import {describe, expect, it} from 'vitest';
import {DataExportComponent} from './data-export.component';
import {DataExportDto} from '../../../../../../services/data-export.service';
import {ApiConfigService} from '../../../../../../services/api-config.service';
import {provideFakePlatform} from '../../../../../../platform/testing/provide-fake-platform';
import {PlatformHost} from '../../../../../../platform/host';

const BASE = 'https://api.test.example/api/v1/identity/data-exports';

function readyExport(): DataExportDto {
    return {
        exportId: 'exp_1',
        status: 'Ready',
        requestedAt: '2026-08-11T10:00:00Z',
        completedAt: '2026-08-11T10:04:00Z',
        expiresAt: '2026-08-18T10:04:00Z',
        failureReason: null,
        missingServices: [],
    };
}

function render(
    host: PlatformHost,
    items: DataExportDto[] = [readyExport()],
): ComponentFixture<DataExportComponent> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService(),
            MessageService,
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
            // Reached through `DataExportService -> AuthService`; nothing here authenticates.
            {provide: OAuthService, useValue: {getAccessToken: () => 'tok'}},
            provideFakePlatform({host}),
        ],
    });

    const fixture = TestBed.createComponent(DataExportComponent);
    fixture.detectChanges();
    TestBed.inject(HttpTestingController).expectOne(BASE).flush(items);
    fixture.detectChanges();
    return fixture;
}

function downloadButton(fixture: ComponentFixture<DataExportComponent>): HTMLElement | null {
    // The request button is a `p-button` too, so the download one is found by its label key.
    const buttons = [...fixture.nativeElement.querySelectorAll('p-button')] as HTMLElement[];
    return buttons.find(b => b.textContent?.includes('SETTINGS.PRIVACY.EXPORT_DOWNLOAD')) ?? null;
}

function reason(fixture: ComponentFixture<DataExportComponent>): HTMLElement | null {
    return fixture.nativeElement.querySelector('[data-testid="export-download-unsupported"]');
}

describe('DataExportComponent download', () => {
    it('is offered on the desktop shell, which streams the artifact itself', () => {
        const fixture = render('tauri');

        expect(downloadButton(fixture)).not.toBeNull();
        expect(reason(fixture)).toBeNull();
    });

    it('is replaced by a reason in a browser rather than failing every time', () => {
        const fixture = render('web');

        expect(downloadButton(fixture)).toBeNull();
        expect(reason(fixture)?.textContent?.trim()).toBe('SETTINGS.PRIVACY.EXPORT_DOWNLOAD_UNSUPPORTED');
    });

    it('still lets a browser user request one', () => {
        // The gate is about collecting the archive, not about asking for it. Taking the request button
        // away would strip a working GDPR control from the web client.
        expect(render('web').nativeElement.textContent).toContain('SETTINGS.PRIVACY.EXPORT_REQUEST_ACTION');
    });

    it('says nothing about downloading an export that is not downloadable', () => {
        // `Failed` has no artifact, so the reason line would be answering a question nobody asked.
        const failed: DataExportDto = {...readyExport(), status: 'Failed', expiresAt: null};

        expect(reason(render('web', [failed]))).toBeNull();
    });
});
