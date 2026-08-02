import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideZonelessChangeDetection} from '@angular/core';
import {MlsUnreadableBannerComponent} from './mls-unreadable-banner.component';
import {MlsHealthService} from '../../services/mls-health.service';
import {describeRelinkOutcome, MlsRelinkStatus} from '../../services/mls-join-request.service';

const CONTEXT = 'conv-1';

function setup(): {
    fixture: ComponentFixture<MlsUnreadableBannerComponent>;
    health: MlsHealthService;
    text: () => string;
    status: (value: MlsRelinkStatus | null) => void;
} {
    TestBed.configureTestingModule({
        imports: [MlsUnreadableBannerComponent],
        providers: [provideZonelessChangeDetection()],
    });

    const fixture = TestBed.createComponent(MlsUnreadableBannerComponent);
    fixture.componentRef.setInput('contextId', CONTEXT);
    fixture.detectChanges();

    return {
        fixture,
        health: TestBed.inject(MlsHealthService),
        text: () => (fixture.nativeElement as HTMLElement).textContent ?? '',
        status: value => {
            fixture.componentRef.setInput('status', value);
            fixture.detectChanges();
        },
    };
}

describe('MlsUnreadableBannerComponent', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('says nothing while the context is readable', () => {
        const {text} = setup();
        expect(text().trim()).toBe('');
    });

    it('names exclusion rather than a decrypt problem when this device was never admitted', () => {
        const {health, fixture, text} = setup();
        health.recordFailure(CONTEXT, false, 'not-admitted');
        fixture.detectChanges();

        expect(text()).toContain('This device has not been added to the conversation');
    });

    it('reports a failed re-link instead of leaving the button looking like a no-op', () => {
        const {health, fixture, text, status} = setup();
        health.recordFailure(CONTEXT, false, 'not-admitted');
        fixture.detectChanges();

        status(describeRelinkOutcome({
            state: 'failed',
            message: "'device-a' is not one of your registered devices.",
        }));

        expect(text()).toContain('Re-linking failed');
        expect(text()).toContain("'device-a' is not one of your registered devices.");
    });

    it('stays visible after a re-link that only asked to be admitted', () => {
        const {health, fixture, text, status} = setup();
        health.recordFailure(CONTEXT, false, 'not-admitted');
        fixture.detectChanges();

        status(describeRelinkOutcome({state: 'requested', request: {} as never}));

        // The remedy is somebody else approving, so the banner must not read as resolved.
        expect(text()).toContain('This device has not been added to the conversation');
        expect(text()).toContain('Asked to be admitted');
    });
});
