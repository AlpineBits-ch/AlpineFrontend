import {Component, output, ViewChild} from '@angular/core';
import {Popover} from 'primeng/popover';
import {SelfProfileMenuComponent} from '../self-profile-menu/self-profile-menu.component';

/** The shell around the self menu: an anchored popover, and the routing of what the menu asks for. */
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

    /** Re-anchor the overlay after the menu swaps to a different-height view. */
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
