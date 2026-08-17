import {ComponentFixture, TestBed} from '@angular/core/testing';
import {UserStatusDotComponent} from './user-status-dot.component';
import {OnlineStatus} from '../../dtos/response/profile.dto';

describe('UserStatusDotComponent', () => {
    let fixture: ComponentFixture<UserStatusDotComponent>;

    async function render(
        status: OnlineStatus | null,
        options: {standalone?: boolean; borderColor?: string} = {},
    ) {
        fixture = TestBed.createComponent(UserStatusDotComponent);
        fixture.componentRef.setInput('status', status);
        if (options.standalone !== undefined) fixture.componentRef.setInput('standalone', options.standalone);
        if (options.borderColor !== undefined)
            fixture.componentRef.setInput('borderColor', options.borderColor);
        fixture.detectChanges();
        return fixture.nativeElement as HTMLElement;
    }

    /** The outer element carries position and the surface colour. */
    function outer(el: HTMLElement): HTMLElement | null {
        return el.querySelector('div');
    }

    /** The inner element carries the colour and the silhouette. */
    function inner(el: HTMLElement): HTMLElement | null {
        return (outer(el)?.firstElementChild as HTMLElement) ?? null;
    }

    // Colors come from the theme tokens in styles.css, not hardcoded palette classes.
    it('renders the online token (emerald) for Online', async () => {
        const el = await render(OnlineStatus.Online);
        expect(inner(el)?.className).toContain('bg-online');
    });

    it('renders the connecting token (amber) for Idle', async () => {
        const el = await render(OnlineStatus.Idle);
        expect(inner(el)?.className).toContain('bg-connecting');
    });

    it('renders the offline token (rose) for DoNotDisturb', async () => {
        const el = await render(OnlineStatus.DoNotDisturb);
        expect(inner(el)?.className).toContain('bg-offline');
    });

    it('renders muted grey for Offline', async () => {
        const el = await render(OnlineStatus.Offline);
        expect(inner(el)?.className).toContain('bg-text-muted');
    });

    it('renders muted grey for Hidden', async () => {
        const el = await render(OnlineStatus.Hidden);
        expect(inner(el)?.className).toContain('bg-text-muted');
    });

    it('renders nothing for null status', async () => {
        const el = await render(null);
        expect(outer(el)).toBeNull();
    });

    // ── Silhouettes ─────────────────────────────────────────────────────────
    // Hue alone fails a colour-blind reader, so each status gets a shape as well.

    it('leaves Online as a plain filled disc', async () => {
        const el = await render(OnlineStatus.Online);
        expect(inner(el)?.className).not.toContain('status-shape');
    });

    it('gives every other status its own silhouette', async () => {
        const cases: [OnlineStatus, string][] = [
            [OnlineStatus.Idle, 'status-shape-idle'],
            [OnlineStatus.DoNotDisturb, 'status-shape-dnd'],
            [OnlineStatus.Hidden, 'status-shape-invisible'],
            [OnlineStatus.Offline, 'status-shape-invisible'],
        ];

        for (const [status, shape] of cases) {
            const el = await render(status);
            expect(inner(el)?.className).toContain(shape);
        }
    });

    /** Without an opaque backing on the outer element, the silhouette's notch shows the avatar behind it. */
    it('backs the dot with the surface it is drawn on', async () => {
        expect(outer(await render(OnlineStatus.Idle, {borderColor: 'border-card'}))?.className).toContain(
            'bg-card',
        );
        expect(outer(await render(OnlineStatus.Idle, {borderColor: 'border-app-bg'}))?.className).toContain(
            'bg-app-bg',
        );
    });

    it('falls back to the sidebar surface for an unrecognised border colour', async () => {
        const el = await render(OnlineStatus.Idle, {borderColor: 'border-something-else'});
        expect(outer(el)?.className).toContain('bg-sidebar');
    });

    it('positions itself as an avatar badge by default', async () => {
        const el = await render(OnlineStatus.Online);
        expect(outer(el)?.className).toContain('absolute');
        expect(outer(el)?.className).toContain('border-sidebar');
    });

    it('drops the badge positioning when standalone', async () => {
        const el = await render(OnlineStatus.Online, {standalone: true});
        expect(outer(el)?.className).not.toContain('absolute');
        expect(outer(el)?.className).not.toContain('border-2');
    });
});
