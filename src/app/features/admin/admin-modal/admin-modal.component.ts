import {Component, effect, model, signal} from '@angular/core';
import {NgClass} from '@angular/common';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {FederationInstancesComponent} from './pages/federation-instances/federation-instances.component';
import {FederationPolicyComponent} from './pages/federation-policy/federation-policy.component';
import {TranslateModule} from '@ngx-translate/core';

/**
 * One page in the admin nav.
 *
 * <p>`labelKey` is a translation key, not a label - same contract as {@link SettingsNavItem}, and
 * renamed for the same reason: this table held English string literals that the template printed
 * directly, so the admin nav stayed English in every language. The type now makes that unspellable.
 * </p>
 */
export interface AdminNavItem {
    id: string;
    labelKey: string;
    icon: string;
}

export interface AdminNavGroup {
    titleKey: string;
    items: AdminNavItem[];
}

/**
 * The admin nav table. Module-level so a test can read it without standing up a component that
 * wants an injector and a `Dialog` - see `admin-modal.component.spec.ts`.
 */
export const ADMIN_NAV_GROUPS: readonly AdminNavGroup[] = [
    {
        titleKey: 'ADMIN.NAV.FEDERATION',
        items: [
            {id: 'federation-instances', labelKey: 'ADMIN.NAV.INSTANCES', icon: 'pi pi-server'},
            {id: 'federation-policy', labelKey: 'ADMIN.NAV.SETTINGS', icon: 'pi pi-sliders-h'},
        ],
    },
];

@Component({
    selector: 'app-admin-modal',
    imports: [
        NgClass,
        Dialog,
        Button,
        FederationInstancesComponent,
        FederationPolicyComponent,
        TranslateModule,
    ],
    templateUrl: './admin-modal.component.html',
    styleUrl: './admin-modal.component.css',
})
export class AdminModalComponent {
    public isVisible = model.required<boolean>();
    public activePage = signal('federation-instances');
    public mobileView = signal<'nav' | 'content'>('nav');

    public readonly navGroups = ADMIN_NAV_GROUPS;

    constructor() {
        effect(() => {
            if (!this.isVisible()) this.mobileView.set('nav');
        });
    }

    selectPage(id: string): void {
        this.activePage.set(id);
        this.mobileView.set('content');
    }

    navItemClasses(id: string): Record<string, boolean> {
        const active = this.activePage() === id;
        return {
            'bg-[color-mix(in_srgb,var(--color-brand)_15%,transparent)]': active,
            'text-[var(--color-brand-dim)]': active,
            'text-white/50': !active,
        };
    }
}
