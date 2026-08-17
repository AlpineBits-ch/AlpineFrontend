import {ChangeDetectionStrategy, Component, computed, inject, OnInit, output, signal} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {AccountRegistryService, AccountSlot} from '../../../../services/account-registry.service';
import {AccountSwitchService} from '../../../../services/account-switch.service';
import {CallSessionService} from '../../../../services/call-session.service';

/** The accounts this machine holds, and the two things you can do with them. */
@Component({
    selector: 'app-account-switcher',
    imports: [TranslateModule],
    templateUrl: './account-switcher.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountSwitcherComponent implements OnInit {
    /** Asked for when the user wants to add one - the host owns the route change. */
    addAccount = output<void>();

    private readonly accounts = inject(AccountRegistryService);
    private readonly switcher = inject(AccountSwitchService);
    private readonly callSession = inject(CallSessionService);

    protected readonly slots = this.accounts.slots;
    protected readonly activeSlotId = this.accounts.activeSlotIdSnapshot;
    /** Set while a switch is in flight, so the row cannot be clicked twice into two reloads. */
    protected readonly busy = signal(false);

    protected readonly others = computed(() => this.slots().filter(s => s.id !== this.activeSlotId()));

    ngOnInit(): void {
        // The default is "no call", which is the safe answer for the check and the wrong one to
        // leave in place: a switch reloads the process, and a reload during a call drops it with
        // no warning. Wired here because this is the only component that owns both.
        this.switcher.environment.callIsLive = () => this.callSession.session() !== null;
        this.switcher.environment.confirmLeaveCall = async () =>
            confirm('Switching accounts will end your current call. Continue?');

        // Populates the signals - every read above is a snapshot of a file this has to have read.
        void this.accounts.list();
    }

    protected async choose(slot: AccountSlot): Promise<void> {
        if (this.busy()) return;
        this.busy.set(true);
        // Left set on the way out: a successful switch reloads, so nothing here runs again. Only a
        // refused one comes back, and that is the case that has to be clickable again.
        if (!(await this.switcher.switchTo(slot.id))) this.busy.set(false);
    }

    protected onAdd(): void {
        this.addAccount.emit();
    }

    /** The host name, so two accounts with one username on two servers are still distinguishable. */
    protected serverLabel(slot: AccountSlot): string {
        try {
            return new URL(slot.serverUrl).host;
        } catch {
            return slot.serverUrl;
        }
    }

    protected initial(slot: AccountSlot): string {
        return (slot.username || slot.displayName || '?').charAt(0).toUpperCase();
    }
}
