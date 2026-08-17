import {ChangeDetectionStrategy, Component, effect, ElementRef, input, viewChild} from '@angular/core';
import QRCode from 'qrcode';

/** Renders arbitrary text as a QR code onto a canvas. Colors must stay fixed light-on-dark, never themed. */
@Component({
    selector: 'app-qr-code',
    template: ` <canvas #canvas class="rounded-lg bg-white p-2" [attr.aria-label]="ariaLabel()"></canvas>`,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QrCodeComponent {
    readonly data = input.required<string>();
    readonly size = input(192);
    readonly ariaLabel = input('QR code');

    private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

    constructor() {
        effect(() => {
            const data = this.data();
            const el = this.canvas().nativeElement;
            if (!data) return;
            void QRCode.toCanvas(el, data, {
                width: this.size(),
                margin: 1,
                color: {dark: '#000000', light: '#ffffff'},
            }).catch(() => {
                // A failed render leaves the canvas blank; the secret is shown as text too.
            });
        });
    }
}
