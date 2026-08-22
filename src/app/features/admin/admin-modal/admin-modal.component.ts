import {ChangeDetectionStrategy, Component, effect, model, signal} from '@angular/core';
import {NgClass} from '@angular/common';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {FederationInstancesComponent} from './pages/federation-instances/federation-instances.component';
import {FederationPolicyComponent} from './pages/federation-policy/federation-policy.component';
import {AdminDiscoveryComponent} from './pages/discovery/discovery.component';
import {TranslateModule} from '@ngx-translate/core';

/** One page in the admin nav. */
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
    {
        titleKey: 'ADMIN.NAV.DISCOVERY',
        items: [{id: 'discovery-bans', labelKey: 'ADMIN.NAV.DISCOVERY_BANS', icon: 'pi pi-ban'}],
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
        AdminDiscoveryComponent,
        TranslateModule,
    ],
    templateUrl: './admin-modal.component.html',
    styleUrl: './admin-modal.component.css',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminModalComponent {
    public readonly isVisible = model.required<boolean>();
    public readonly activePage = signal('federation-instances');
    public readonly mobileView = signal<'nav' | 'content'>('nav');

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
            'text-text-secondary': !active,
        };
    }
}
