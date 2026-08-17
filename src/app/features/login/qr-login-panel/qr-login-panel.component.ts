import {
    ChangeDetectionStrategy,
    Component,
    computed,
    DestroyRef,
    effect,
    inject,
    input,
    output,
    signal,
    untracked,
} from '@angular/core';
import {Button} from 'primeng/button';
import {TranslateModule} from '@ngx-translate/core';
import {interval, Subscription, switchMap} from 'rxjs';
import {QrCodeComponent} from '../../../components/qr-code/qr-code.component';
import {QR_POLL_INTERVAL_MS, QrLoginService, QrPollResult} from '../../../services/qr-login.service';

/**
 * `starting` and `exchanging` are the two moments the panel is waiting on our own request
 * rather than on the phone, and both must block a retry click: restarting mid-exchange
 * would burn a code the server has already spent.
 */
type PanelState = 'starting' | 'pending' | 'scanned' | 'exchanging' | 'denied' | 'expired' | 'error';

@Component({
    selector: 'app-qr-login-panel',
    imports: [Button, TranslateModule, QrCodeComponent],
    templateUrl: './qr-login-panel.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QrLoginPanelComponent {
    /**
     * The API base URL the pairing is created against. Declared as an input rather than read
     * from ApiConfigService so that picking a different server visibly restarts the pairing -
     * a code minted by venta.gg is meaningless to a phone signed in to a self-hosted server.
     */
    readonly serverUrl = input.required<string>();

    /** Fires once tokens are in storage; the parent owns where to navigate next. */
    authenticated = output<void>();
    /** User asked to go back to the password form. */
    cancelled = output<void>();

    protected readonly state = signal<PanelState>('starting');
    protected readonly code = signal('');
    protected readonly secondsLeft = signal(0);

    /** `m:ss` left before the code ages out, for the caption under the QR. */
    protected readonly countdown = computed(() => {
        const total = Math.max(0, this.secondsLeft());
        return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
    });

    /**
     * Dim the code once scanning it would achieve nothing. That covers the failed states
     * and also `scanned`, where the phone has already taken the code and the user's
     * attention belongs on their phone rather than back on this screen.
     */
    protected readonly isLive = computed(() => this.state() === 'pending');

    private qr = inject(QrLoginService);
    private destroyRef = inject(DestroyRef);
    private starting: Subscription | null = null;
    private polling: Subscription | null = null;
    private ticking: Subscription | null = null;

    constructor() {
        effect(() => {
            this.serverUrl(); // the one dependency: restart when the target server changes
            // start() reads `state` to guard against restarting mid-exchange, and writes it
            // on every transition. Tracked, that read would make each write re-run this
            // effect and mint a fresh pairing code: a request loop against /qr-login/start.
            untracked(() => this.start());
        });
        this.destroyRef.onDestroy(() => this.stopWork());
    }

    protected start(): void {
        if (this.state() === 'exchanging') return;
        this.stopWork();
        this.state.set('starting');
        this.code.set('');

        // Held so a second start (a fast server change, or a retry click) drops the earlier
        // request instead of letting two pairings race to own `code`.
        this.starting = this.qr.start().subscribe({
            next: res => {
                this.code.set(res.code);
                this.secondsLeft.set(res.expiresInSeconds);
                this.state.set('pending');
                this.beginPolling(res.code);
            },
            error: () => this.state.set('error'),
        });
    }

    protected cancel(): void {
        this.stopWork();
        this.cancelled.emit();
    }

    private beginPolling(code: string): void {
        this.polling = interval(QR_POLL_INTERVAL_MS).pipe(
            switchMap(() => this.qr.status(code)),
        ).subscribe({
            next: status => this.onStatus(status),
            error: () => {
                // A transient network blip should not strand the user on a code that may
                // still be perfectly valid, so surface it as retryable rather than expired.
                this.stopWork();
                this.state.set('error');
            },
        });

        this.ticking = interval(1000).subscribe(() => {
            const left = this.secondsLeft() - 1;
            this.secondsLeft.set(left);
            // Stop on the client's own clock too: once the window closes the server only
            // ever answers 404, and polling a dead code is pure noise.
            if (left <= 0) {
                this.stopWork();
                this.state.set('expired');
            }
        });
    }

    private onStatus(status: QrPollResult): void {
        switch (status) {
            case 'pending':
                return;
            case 'scanned':
                this.state.set('scanned');
                return;
            case 'approved':
                this.stopWork();
                this.redeem();
                return;
            case 'denied':
                this.stopWork();
                this.state.set('denied');
                return;
            case 'expired':
                this.stopWork();
                this.state.set('expired');
                return;
        }
    }

    private redeem(): void {
        this.state.set('exchanging');
        this.qr.exchange(this.code()).subscribe({
            next: () => this.authenticated.emit(),
            // The code is spent whether or not we managed to store the result, so the only
            // safe recovery is a brand new pairing, never a retry of this exchange.
            error: () => this.state.set('error'),
        });
    }

    private stopWork(): void {
        this.starting?.unsubscribe();
        this.polling?.unsubscribe();
        this.ticking?.unsubscribe();
        this.starting = null;
        this.polling = null;
        this.ticking = null;
    }
}
