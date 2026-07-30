import {ComponentFixture, TestBed} from '@angular/core/testing';
import {UserStatusDotComponent} from './user-status-dot.component';
import {OnlineStatus} from '../../dtos/response/profile.dto';

describe('UserStatusDotComponent', () => {
    let fixture: ComponentFixture<UserStatusDotComponent>;

    async function render(status: OnlineStatus | null) {
        fixture = TestBed.createComponent(UserStatusDotComponent);
        fixture.componentRef.setInput('status', status);
        fixture.detectChanges();
        return fixture.nativeElement as HTMLElement;
    }

    beforeEach(async () => {
        await TestBed.configureTestingModule({imports: [UserStatusDotComponent]}).compileComponents();
    });

    // Colors come from the theme tokens in styles.css, not hardcoded palette
    // classes: --color-online is emerald-400, --color-connecting amber-400,
    // --color-offline rose-500.
    it('renders the online token (emerald) for Online', async () => {
        const el = await render(OnlineStatus.Online);
        expect(el.querySelector('div')?.className).toContain('bg-online');
    });

    it('renders the connecting token (amber) for Idle', async () => {
        const el = await render(OnlineStatus.Idle);
        expect(el.querySelector('div')?.className).toContain('bg-connecting');
    });

    it('renders the offline token (rose) for DoNotDisturb', async () => {
        const el = await render(OnlineStatus.DoNotDisturb);
        expect(el.querySelector('div')?.className).toContain('bg-offline');
    });

    it('renders muted grey for Offline', async () => {
        const el = await render(OnlineStatus.Offline);
        expect(el.querySelector('div')?.className).toContain('bg-white/20');
    });

    it('renders muted grey for Hidden', async () => {
        const el = await render(OnlineStatus.Hidden);
        expect(el.querySelector('div')?.className).toContain('bg-white/20');
    });

    it('renders nothing for null status', async () => {
        const el = await render(null);
        expect(el.querySelector('div')).toBeNull();
    });
});
