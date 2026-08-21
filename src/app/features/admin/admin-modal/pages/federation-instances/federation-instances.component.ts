import {ChangeDetectionStrategy, Component, inject, OnInit, signal} from '@angular/core';
import {NgClass} from '@angular/common';
import {Button} from 'primeng/button';
import {
    AdminFederationService,
    FederationInstance,
    FederationStatus,
} from '../../../../../services/admin-federation.service';

type FilterTab = 'All' | FederationStatus;

@Component({
    selector: 'app-federation-instances',
    imports: [NgClass, Button],
    templateUrl: './federation-instances.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FederationInstancesComponent implements OnInit {
    private svc = inject(AdminFederationService);

    readonly instances = signal<FederationInstance[]>([]);
    readonly loading = signal(false);
    readonly actionLoading = signal<string | null>(null);
    readonly activeFilter = signal<FilterTab>('All');
    readonly error = signal<string | null>(null);

    readonly filters: FilterTab[] = [
        'All',
        FederationStatus.Pending,
        FederationStatus.Active,
        FederationStatus.Blocked,
        FederationStatus.Defederated,
    ];

    get filtered(): FederationInstance[] {
        const f = this.activeFilter();
        return f === 'All' ? this.instances() : this.instances().filter(i => i.status === f);
    }

    ngOnInit(): void {
        this.load();
    }

    load(): void {
        this.loading.set(true);
        this.error.set(null);
        this.svc.getInstances().subscribe({
            next: list => {
                this.instances.set(list);
                this.loading.set(false);
            },
            error: () => {
                this.error.set('Failed to load instances.');
                this.loading.set(false);
            },
        });
    }

    approve(id: string): void {
        this.actionLoading.set(id);
        this.svc.approveInstance(id).subscribe({
            next: () => {
                this.updateStatus(id, FederationStatus.Active);
                this.actionLoading.set(null);
            },
            error: () => this.actionLoading.set(null),
        });
    }

    deny(id: string): void {
        this.actionLoading.set(id);
        this.svc.denyInstance(id).subscribe({
            next: () => {
                this.updateStatus(id, FederationStatus.Blocked);
                this.actionLoading.set(null);
            },
            error: () => this.actionLoading.set(null),
        });
    }

    defederate(id: string): void {
        this.actionLoading.set(id);
        this.svc.defederateInstance(id).subscribe({
            next: () => {
                this.updateStatus(id, FederationStatus.Defederated);
                this.actionLoading.set(null);
            },
            error: () => this.actionLoading.set(null),
        });
    }

    private updateStatus(id: string, status: FederationStatus): void {
        this.instances.update(list => list.map(i => (i.id === id ? {...i, status} : i)));
    }

    statusClass(status: FederationStatus): string {
        switch (status) {
            case FederationStatus.Active:
                return 'text-emerald-400 bg-emerald-400/10 border border-emerald-400/20';
            case FederationStatus.Pending:
                return 'text-amber-400 bg-amber-400/10 border border-amber-400/20';
            case FederationStatus.Blocked:
                return 'text-rose-400 bg-rose-400/10 border border-rose-400/20';
            case FederationStatus.Defederated:
                return 'text-text-muted bg-white/[0.04] border border-white/[0.08]';
        }
    }

    protected readonly FederationStatus = FederationStatus;
}
