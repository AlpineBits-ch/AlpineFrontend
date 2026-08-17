import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    ElementRef,
    input,
    signal,
    viewChild,
} from '@angular/core';
import QRCode from 'qrcode';
import {
    buildSwissQrBillPayload,
    SPC_ERROR_CORRECTION,
    SwissQrBillError,
    SwissQrBillInput,
} from '../swiss-qr-bill';

/** A Swiss QR-bill, drawn with its mandatory Swiss cross. */
@Component({
    selector: 'app-swiss-qr-bill',
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        @if (error(); as message) {
            <!--
              Loud, and never a blank square. A QR that silently failed to build looks exactly like
              one that is still loading, and the payer would sit waiting to scan nothing.
            -->
            <div
                class="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2"
                data-testid="qr-error"
            >
                <p class="m-0 text-[0.8125rem] text-amber-200">{{ message }}</p>
            </div>
        } @else {
            <canvas #canvas class="rounded-lg bg-white p-2" [attr.aria-label]="ariaLabel()"></canvas>
        }
    `,
})
export class SwissQrBillComponent {
    readonly bill = input.required<SwissQrBillInput>();
    /** Rendered pixel width. The printed size is fixed at 46 mm; on screen it just has to scan. */
    readonly size = input(220);
    readonly ariaLabel = input('Swiss QR-bill');

    private readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('canvas');

    protected readonly error = signal<string | null>(null);

    /** The payload, or the reason there is not one. */
    private readonly built = computed<{payload: string} | {refusal: string}>(() => {
        try {
            return {payload: buildSwissQrBillPayload(this.bill())};
        } catch (err) {
            return {
                refusal: err instanceof SwissQrBillError ? err.message : 'The QR-bill could not be built.',
            };
        }
    });

    constructor() {
        effect(() => {
            const built = this.built();
            if ('refusal' in built) {
                this.error.set(built.refusal);
                return;
            }
            this.error.set(null);

            const element = this.canvas()?.nativeElement;
            if (!element) return;

            const payload = built.payload;

            const size = this.size();

            void QRCode.toCanvas(element, payload, {
                width: size,
                margin: 1,
                errorCorrectionLevel: SPC_ERROR_CORRECTION,
                color: {dark: '#000000', light: '#ffffff'},
            })
                .then(() => drawSwissCross(element, size))
                .catch(() => this.error.set('The QR-bill could not be drawn on this device.'));
        });
    }
}

/** Paints the mandatory Swiss cross over the centre of a rendered code. */
function drawSwissCross(canvas: HTMLCanvasElement, size: number): void {
    const context = canvas.getContext('2d');
    if (!context) return;

    // The rendered canvas is `size` wide including the quiet-zone margin the encoder added, so the
    // cross is centred on the canvas rather than on the module grid. That is what the guide
    // specifies - the cross sits in the middle of the code as printed.
    const centre = canvas.width / 2;
    const scale = canvas.width;

    const frame = scale * 0.174;
    const square = scale * 0.152;
    const armLength = scale * 0.085;
    const armWidth = scale * 0.0254;

    context.fillStyle = '#ffffff';
    context.fillRect(centre - frame / 2, centre - frame / 2, frame, frame);

    context.fillStyle = '#000000';
    context.fillRect(centre - square / 2, centre - square / 2, square, square);

    context.fillStyle = '#ffffff';
    context.fillRect(centre - armWidth / 2, centre - armLength / 2, armWidth, armLength);
    context.fillRect(centre - armLength / 2, centre - armWidth / 2, armLength, armWidth);
}
