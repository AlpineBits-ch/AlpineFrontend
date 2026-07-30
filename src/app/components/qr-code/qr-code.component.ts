import {ChangeDetectionStrategy, Component, effect, ElementRef, input, viewChild} from '@angular/core';
import QRCode from 'qrcode';

/**
 * Renders arbitrary text as a QR code onto a canvas. Colors are fixed light-on-dark
 * rather than themed: scanners need a high, predictable contrast ratio, and a brand-tinted
 * code risks failing to scan on some phones.
 */
@Component({
    selector: 'app-qr-code',
    template: `
        <canvas #canvas class="rounded-lg bg-white p-2" [attr.aria-label]="ariaLabel()"></canvas>`,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QrCodeComponent {
    data = input.required<string>();
    size = input(192);
    ariaLabel = input('QR code');

    private canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

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
                // A failed render leaves the canvas blank; the enrollment screen always
                // shows the secret as selectable text too, so manual entry still works.
            });
        });
    }
}
