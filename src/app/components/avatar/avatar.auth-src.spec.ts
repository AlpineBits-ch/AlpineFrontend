/**
 * `authSrc` is the group-icon path: `<app-conversation-avatar>` is the only place that sets it, and
 * only once the group has an icon of its own. The effect that fetches those bytes releases the
 * previous object URL first, and that release reads `authObjectUrl` inside the effect's reactive
 * context - so the effect depends on the signal it also writes. Landed bytes set it, the effect
 * re-runs, the release clears it, the effect re-runs, forever, allocating an object URL a turn.
 *
 * The fetch resolves from AuthImageService's cache, so every turn is a microtask: the loop never
 * yields and the tab stops responding. Counting createObjectURL keeps the failure a number rather
 * than a hung runner.
 */
import {ChangeDetectionStrategy, Component, signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {describe, expect, it, vi} from 'vitest';
import {AppAvatarComponent} from './avatar.component';
import {AuthImageService} from '../../services/auth-image.service';
import {ProfileService} from '../../services/profile.service';
import {provideFakePlatform} from '../../platform/testing/provide-fake-platform';

const ICON_URL = 'https://api.test.example/api/v1/messaging/conversations/conv_1/icon?v=2026-08-17';

@Component({
    imports: [AppAvatarComponent],
    template: `<app-avatar [authSrc]="icon()" label="G" />`,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
class HostComponent {
    readonly icon = signal<string | undefined>(ICON_URL);
}

function setup() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        imports: [HostComponent],
        providers: [
            provideFakePlatform(),
            {provide: AuthImageService, useValue: {fetch: () => Promise.resolve(new Blob(['icon']))}},
            {
                provide: ProfileService,
                useValue: {getCachedByUserId: () => undefined, resolveByUserId: vi.fn()},
            },
        ],
    });

    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    return fixture;
}

describe('AppAvatarComponent authSrc', () => {
    it('settles on one object URL instead of re-releasing what it just fetched', async () => {
        const created = vi.fn(() => `blob:${created.mock.calls.length}`);
        vi.stubGlobal('URL', {...URL, createObjectURL: created, revokeObjectURL: vi.fn()});

        const fixture = setup();
        // Enough turns that a self-retriggering effect shows up as a count, bounded so it cannot hang.
        for (let i = 0; i < 5; i++) {
            await Promise.resolve();
            fixture.detectChanges();
        }

        expect(created).toHaveBeenCalledTimes(1);
        vi.unstubAllGlobals();
    });

    it('still releases and refetches when the address changes', async () => {
        const created = vi.fn(() => `blob:${created.mock.calls.length}`);
        const revoked = vi.fn();
        vi.stubGlobal('URL', {...URL, createObjectURL: created, revokeObjectURL: revoked});

        const fixture = setup();
        await Promise.resolve();
        fixture.detectChanges();

        fixture.componentInstance.icon.set(`${ICON_URL}-2`);
        fixture.detectChanges();
        await Promise.resolve();
        fixture.detectChanges();

        expect(created).toHaveBeenCalledTimes(2);
        expect(revoked).toHaveBeenCalled();
        vi.unstubAllGlobals();
    });
});
