import {ChangeDetectionStrategy, Component, inject, OnInit, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {NgClass} from '@angular/common';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {
    AdminFederationService,
    AcceptancePolicy,
    HandshakeResponse,
} from '../../../../../services/admin-federation.service';

@Component({
    selector: 'app-federation-policy',
    imports: [FormsModule, NgClass, Button, InputText],
    templateUrl: './federation-policy.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FederationPolicyComponent implements OnInit {
    private svc = inject(AdminFederationService);

    readonly policy = signal<AcceptancePolicy | null>(null);
    readonly policyLoading = signal(false);
    readonly policyError = signal<string | null>(null);

    readonly policyOptions: {value: AcceptancePolicy; label: string; desc: string}[] = [
        {
            value: AcceptancePolicy.AutoAccept,
            label: 'Auto Accept',
            desc: 'Automatically approve all incoming federation requests.',
        },
        {
            value: AcceptancePolicy.RequireApproval,
            label: 'Require Approval',
            desc: 'Queue incoming requests for manual review before activation.',
        },
    ];

    readonly targetHost = signal('');
    readonly initiating = signal(false);
    readonly initiateResult = signal<HandshakeResponse | null>(null);
    readonly initiateError = signal<string | null>(null);

    ngOnInit(): void {
        this.loadPolicy();
    }

    loadPolicy(): void {
        this.policyLoading.set(true);
        this.svc.getSettings().subscribe({
            next: s => {
                this.policy.set(s.acceptancePolicy);
                this.policyLoading.set(false);
            },
            error: () => {
                this.policyError.set('Failed to load settings.');
                this.policyLoading.set(false);
            },
        });
    }

    setPolicy(value: AcceptancePolicy): void {
        this.policy.set(value);
        this.svc.updateSettings(value).subscribe({
            error: () => this.policyError.set('Failed to save policy.'),
        });
    }

    initiateHandshake(): void {
        const host = this.targetHost().trim();
        if (!host) return;
        this.initiating.set(true);
        this.initiateResult.set(null);
        this.initiateError.set(null);
        this.svc.initiateHandshake(host).subscribe({
            next: r => {
                this.initiateResult.set(r);
                this.initiating.set(false);
            },
            error: () => {
                this.initiateError.set('Handshake failed. Check the host URL and try again.');
                this.initiating.set(false);
            },
        });
    }
}
