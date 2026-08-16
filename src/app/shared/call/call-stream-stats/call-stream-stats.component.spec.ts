import {ComponentFixture, TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it} from 'vitest';
import {TranslateModule} from '@ngx-translate/core';
import {CallStreamStatsComponent} from './call-stream-stats.component';
import {StreamStatsSnapshot} from '../stream-stats';

function snapshot(overrides: Partial<StreamStatsSnapshot> = {}): StreamStatsSnapshot {
    return {
        direction: 'outbound',
        source: 'webview',
        capturedAt: 0,
        layers: [{rid: 'a', width: 1920, height: 1080, fps: 30, kbps: 2480, targetKbps: 2600}],
        ...overrides,
    };
}

function setup(stats: StreamStatsSnapshot | null): ComponentFixture<CallStreamStatsComponent> {
    TestBed.configureTestingModule({
        imports: [CallStreamStatsComponent, TranslateModule.forRoot()],
    });
    const fixture = TestBed.createComponent(CallStreamStatsComponent);
    fixture.componentRef.setInput('stats', stats);
    fixture.detectChanges();
    return fixture;
}

describe('CallStreamStatsComponent', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('renders one section per layer', () => {
        const fixture = setup(snapshot({
            layers: [{rid: 'a', width: 1920, height: 1080}, {rid: 'b', width: 960, height: 540}],
        }));

        const sections = fixture.nativeElement.querySelectorAll('[data-testid="stats-layer"]');
        expect(sections.length).toBe(2);
    });

    it('shows the measured bitrate against the rung target, which is the simulcast finding', () => {
        const fixture = setup(snapshot());

        const text = fixture.nativeElement.textContent as string;
        expect(text).toContain('2480');
        expect(text).toContain('2600');
    });

    /**
     * The rule the whole model exists for: a field the pipeline could not produce must not render
     * as a zero. Mutating the snapshot to drop `fps` must remove the row, not show "0".
     */
    it('omits a row whose field is absent rather than rendering it as zero', () => {
        const fixture = setup(snapshot({layers: [{rid: 'a', width: 1920, height: 1080}]}));

        const rows = fixture.nativeElement.querySelectorAll('[data-testid="row-fps"]');
        expect(rows.length).toBe(0);
    });

    it('renders a genuinely reported zero as a row', () => {
        const fixture = setup(snapshot({layers: [{rid: 'a', fps: 0}]}));

        const rows = fixture.nativeElement.querySelectorAll('[data-testid="row-fps"]');
        expect(rows.length).toBe(1);
        expect((rows[0].textContent as string)).toContain('0');
    });

    it('says it has no data rather than rendering an empty panel', () => {
        const fixture = setup(null);

        expect(fixture.nativeElement.querySelectorAll('[data-testid="stats-layer"]').length).toBe(0);
        expect(fixture.nativeElement.querySelector('[data-testid="stats-empty"]')).toBeTruthy();
    });

    it('emits close when the close button is pressed', () => {
        const fixture = setup(snapshot());
        let closed = false;
        fixture.componentInstance.close.subscribe(() => (closed = true));

        fixture.nativeElement.querySelector('[data-testid="stats-close"]').click();

        expect(closed).toBe(true);
    });
});
