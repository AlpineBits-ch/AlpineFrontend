import {Component, computed, inject, signal} from '@angular/core';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {forkJoin} from 'rxjs';
import {LegalService} from '../../services/legal.service';
import {ExternalLinkService} from '../../services/external-link.service';
import {ToastService} from '../../services/toast.service';
import {ConsentRequirement, LegalDocumentType} from '../../dtos/response/UserDto';

/** Asks the account to accept a newly published Terms or Privacy version. Must stay non-dismissable. */
@Component({
    selector: 'app-legal-consent-dialog',
    imports: [Dialog, Button, TranslateModule],
    templateUrl: './legal-consent-dialog.component.html',
})
export class LegalConsentDialogComponent {
    private readonly legal = inject(LegalService);
    private readonly externalLinks = inject(ExternalLinkService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);

    protected readonly outstanding = this.legal.outstanding;
    protected readonly visible = computed(() => this.outstanding().length > 0);
    protected readonly accepting = signal(false);

    protected documentLabelKey(type: LegalDocumentType): string {
        switch (type) {
            case LegalDocumentType.Terms:
                return 'LEGAL.DOC_TERMS';
            case LegalDocumentType.Privacy:
                return 'LEGAL.DOC_PRIVACY';
            case LegalDocumentType.Cookies:
                return 'LEGAL.DOC_COOKIES';
        }
    }

    protected read(requirement: ConsentRequirement): void {
        void this.externalLinks.openExternalLink(requirement.url);
    }

    /** Accepts every outstanding document at once; the server records one row per document. */
    protected acceptAll(): void {
        const pending = this.outstanding();
        if (pending.length === 0 || this.accepting()) return;
        this.accepting.set(true);

        forkJoin(pending.map(r => this.legal.accept(r.documentType, r.version))).subscribe({
            next: () => this.accepting.set(false),
            error: () => {
                this.accepting.set(false);
                this.toast.error(this.translate.instant('LEGAL.ACCEPT_ERROR'));
            },
        });
    }
}
