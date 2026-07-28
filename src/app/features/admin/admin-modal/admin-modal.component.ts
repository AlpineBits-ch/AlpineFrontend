import {Component, effect, model, signal} from '@angular/core';
import {NgClass} from '@angular/common';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {FederationInstancesComponent} from './pages/federation-instances/federation-instances.component';
import {FederationPolicyComponent} from './pages/federation-policy/federation-policy.component';

export interface AdminNavItem {
    id: string;
    label: string;
    icon: string;
}

export interface AdminNavGroup {
    title: string;
    items: AdminNavItem[];
}

@Component({
    selector: 'app-admin-modal',
    imports: [
        NgClass,
        Dialog,
        Button,
        FederationInstancesComponent,
        FederationPolicyComponent,
    ],
    templateUrl: './admin-modal.component.html',
    styleUrl: './admin-modal.component.css',
})
export class AdminModalComponent {
    public isVisible = model.required<boolean>();
    public activePage = signal('federation-instances');
    public mobileView = signal<'nav' | 'content'>('nav');

    public readonly navGroups: AdminNavGroup[] = [
        {
            title: 'Federation',
            items: [
                {id: 'federation-instances', label: 'Instances', icon: 'pi pi-server'},
                {id: 'federation-policy', label: 'Settings', icon: 'pi pi-sliders-h'},
            ],
        },
    ];

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
