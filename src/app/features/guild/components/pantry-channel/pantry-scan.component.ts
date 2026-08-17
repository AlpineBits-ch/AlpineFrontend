import {ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {PantryBarcode} from '../../../../dtos/response/pantry.dto';
import {ScanPantryItemDto} from '../../../../dtos/request/pantry.dto';
import {PantryService} from '../../../../services/pantry.service';
import {ToastService} from '../../../../services/toast.service';

/** The name is asked for only when the server's `learned` response says the code was unknown; there is no third-party lookup, only manual entry with completion off codes the guild has already learned. A camera path can be dropped in behind {@link submit}. */
@Component({
    selector: 'app-pantry-scan',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [Button, InputText, FormsModule, TranslateModule],
    templateUrl: './pantry-scan.component.html',
})
export class PantryScanComponent {
    readonly guildId = input.required<string>();
    readonly channelId = input.required<string>();

    /** Fired after a successful scan, so the host can drop back to the stock list. */
    scanned = output<void>();

    private pantry = inject(PantryService);
    private toast = inject(ToastService);
    private translate = inject(TranslateService);

    protected readonly barcode = signal('');
    protected readonly quantity = signal('');
    protected readonly saving = signal(false);

    /** Set when the last attempt needed a name; holds the code it applies to rather than a bare boolean, so editing the box after a refusal doesn't silently teach the wrong product a name typed for a different one. */
    protected readonly needsNameFor = signal<string | null>(null);
    protected readonly name = signal('');
    protected readonly unit = signal('');

    /** The codes this guild has learned, filtered as the user types. */
    protected readonly suggestions = signal<PantryBarcode[]>([]);

    protected readonly asksForName = computed(() =>
        !!this.needsNameFor() && this.needsNameFor() === this.barcode().trim());

    protected readonly canSubmit = computed(() => {
        if (this.saving() || !this.barcode().trim()) return false;
        return !this.asksForName() || !!this.name().trim();
    });

    /** What the house already knows this code is, if anything. Shown so the scan is confirmable. */
    protected readonly knownAs = computed(() => {
        const code = this.barcode().trim();
        return code ? this.suggestions().find(b => b.barcode === code) ?? null : null;
    });

    constructor() {
        // Warmed once per guild rather than per keystroke: the learned set is small (one house's shopping), and holding it locally is what makes a typed code complete instantly.
        effect(() => {
            const guildId = this.guildId();
            untracked(() => this.pantry.barcodes(guildId).subscribe({
                next: barcodes => this.suggestions.set(barcodes),
                error: () => undefined,
            }));
        });
    }

    protected pick(barcode: PantryBarcode): void {
        this.barcode.set(barcode.barcode);
        // Cleared, not filled: the house already knows what this code is called, and sending the name again would re-teach a label nobody is trying to change.
        this.needsNameFor.set(null);
        this.name.set('');
    }

    protected submit(): void {
        const code = this.barcode().trim();
        if (!this.canSubmit()) return;

        const quantity = Number(this.quantity().replace(',', '.'));
        const body: ScanPantryItemDto = {
            barcode: code,
            // Left off unless the user typed one, so the house's own learned default applies: the entire reason the quantity box is optional.
            ...(this.quantity().trim() && Number.isFinite(quantity) && quantity > 0 ? {quantity} : {}),
            ...(this.asksForName() ? {name: this.name().trim()} : {}),
            ...(this.asksForName() && this.unit().trim() ? {unit: this.unit().trim()} : {}),
        };

        this.saving.set(true);
        this.pantry.scan(this.guildId(), this.channelId(), body).subscribe({
            next: result => {
                this.saving.set(false);
                // `learned` is the one moment worth saying anything: a house that gets a toast per tin stops scanning.
                if (result.learned) {
                    this.toast.success(this.translate.instant('PANTRY.SCAN_LEARNED', {name: result.item.name}));
                }
                this.reset();
                this.scanned.emit();
            },
            error: err => {
                this.saving.set(false);
                // A 400 on a code with no name is not a failure to report, it is the prompt: the house has never seen this product and is being asked what it is called.
                if (err?.status === 400 && !this.asksForName()) {
                    this.needsNameFor.set(code);
                    return;
                }
                this.toast.httpError(this.translate.instant('PANTRY.SCAN_FAILED'), err);
            },
        });
    }

    private reset(): void {
        this.barcode.set('');
        this.quantity.set('');
        this.name.set('');
        this.unit.set('');
        this.needsNameFor.set(null);
    }
}
