import {Component, output, ViewChild} from '@angular/core';
import {Popover} from 'primeng/popover';
import {SelfProfileMenuComponent} from '../self-profile-menu/self-profile-menu.component';

/**
 * The shell around the self menu: an anchored popover, and the routing of what the menu asks for.
 *
 * <p>It owns no dialogs. Settings and admin are hosted by the quick-settings footer, which holds
 * both the `@ViewChild` that selects a settings page and the effect honouring page requests from the
 * titlebar — so everything here is re-emitted upward rather than handled.</p>
 */
@Component({
    selector: 'app-self-profile-popover',
    imports: [Popover, SelfProfileMenuComponent],
    templateUrl: './self-profile-popover.component.html',
    styleUrl: './self-profile-popover.component.css',
})
export class SelfProfilePopoverComponent {
    editProfile = output<void>();
    openAdmin = output<void>();
    /** Asked for here, routed by the host - this popover owns no navigation. */
    addAccount = output<void>();

    @ViewChild('popover') private popoverRef!: Popover;
    @ViewChild(SelfProfileMenuComponent) private menu!: SelfProfileMenuComponent;

    toggle(event: Event): void {
        this.popoverRef.toggle(event);
    }

    /** Back to the root view, so reopening never resumes halfway inside a submenu. */
    protected onHide(): void {
        this.menu?.reset();
    }

    /**
     * Re-anchor the overlay after the menu swaps to a different-height view.
     *
     * <p>PrimeNG positions a popover once, when it opens, from the size it had then. This one opens
     * upward out of the footer, so a view that is shorter than the one it replaced leaves the
     * popover hanging in space above the bar rather than sitting on it.</p>
     *
     * <p>Deferred by a task because `align()` measures the container: called synchronously it would
     * read the outgoing view's height and re-anchor to the wrong number.</p>
     */
    protected realign(): void {
        setTimeout(() => this.popoverRef?.align());
    }

    protected onEditProfile(): void {
        this.popoverRef.hide();
        this.editProfile.emit();
    }

    protected onOpenAdmin(): void {
        this.popoverRef.hide();
        this.openAdmin.emit();
    }

    protected onAddAccount(): void {
        this.popoverRef.hide();
        this.addAccount.emit();
    }
}
