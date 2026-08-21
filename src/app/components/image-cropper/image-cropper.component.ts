import {
    AfterViewInit,
    ChangeDetectionStrategy,
    Component,
    ElementRef,
    input,
    OnDestroy,
    output,
    signal,
    viewChild,
} from '@angular/core';
import {Button} from 'primeng/button';

@Component({
    selector: 'app-image-cropper',
    imports: [Button],
    templateUrl: './image-cropper.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ImageCropperComponent implements AfterViewInit, OnDestroy {
    readonly imageSrc = input.required<string>();
    readonly circular = input(false);
    readonly outputWidth = input(400);
    readonly outputHeight = input(400);

    confirmed = output<File>();
    cancelled = output<void>();

    private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('cropCanvas');

    private readonly SIZE = 320;
    private readonly MAX_CROP = 240;
    private readonly PAD = 40;

    private get cropWidth(): number {
        const ratio = this.outputWidth() / this.outputHeight();
        return ratio >= 1 ? this.MAX_CROP : this.MAX_CROP * ratio;
    }

    private get cropHeight(): number {
        const ratio = this.outputWidth() / this.outputHeight();
        return ratio >= 1 ? this.MAX_CROP / ratio : this.MAX_CROP;
    }

    protected readonly confirming = signal(false);

    private img!: HTMLImageElement;
    private scale = 1;
    private offsetX = 0;
    private offsetY = 0;
    private isDragging = false;
    private lastX = 0;
    private lastY = 0;
    private lastTouchDist = 0;
    private scaleAtPinch = 1;

    private boundWheel!: (e: WheelEvent) => void;
    private boundTouchMove!: (e: TouchEvent) => void;

    ngAfterViewInit(): void {
        const canvas = this.canvasRef().nativeElement;

        this.boundWheel = (e: WheelEvent) => {
            e.preventDefault();
            const factor = e.deltaY < 0 ? 1.08 : 0.93;
            this.scale = Math.max(this.minScale(), this.scale * factor);
            this.clamp();
            this.draw();
        };

        this.boundTouchMove = (e: TouchEvent) => {
            e.preventDefault();
            if (e.touches.length === 1 && this.isDragging) {
                this.offsetX += e.touches[0].clientX - this.lastX;
                this.offsetY += e.touches[0].clientY - this.lastY;
                this.lastX = e.touches[0].clientX;
                this.lastY = e.touches[0].clientY;
                this.clamp();
                this.draw();
            } else if (e.touches.length === 2) {
                const d = this.touchDist(e);
                this.scale = Math.max(this.minScale(), this.scaleAtPinch * (d / this.lastTouchDist));
                this.clamp();
                this.draw();
            }
        };

        canvas.addEventListener('wheel', this.boundWheel, {passive: false});
        canvas.addEventListener('touchmove', this.boundTouchMove, {passive: false});

        this.img = new Image();
        this.img.onerror = () => this.cancelled.emit();
        this.img.onload = () => {
            this.scale = Math.max(
                this.cropWidth / this.img.naturalWidth,
                this.cropHeight / this.img.naturalHeight,
            );
            this.offsetX = 0;
            this.offsetY = 0;
            this.draw();
        };
        this.img.src = this.imageSrc();
    }

    ngOnDestroy(): void {
        const canvas = this.canvasRef().nativeElement;
        canvas.removeEventListener('wheel', this.boundWheel);
        canvas.removeEventListener('touchmove', this.boundTouchMove);
    }

    protected onMouseDown(e: MouseEvent): void {
        this.isDragging = true;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
    }

    protected onMouseMove(e: MouseEvent): void {
        if (!this.isDragging) return;
        this.offsetX += e.clientX - this.lastX;
        this.offsetY += e.clientY - this.lastY;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        this.clamp();
        this.draw();
    }

    protected onMouseUp(): void {
        this.isDragging = false;
    }

    protected onTouchStart(e: TouchEvent): void {
        if (e.touches.length === 1) {
            this.isDragging = true;
            this.lastX = e.touches[0].clientX;
            this.lastY = e.touches[0].clientY;
        } else if (e.touches.length === 2) {
            this.isDragging = false;
            this.lastTouchDist = this.touchDist(e);
            this.scaleAtPinch = this.scale;
        }
    }

    protected onTouchEnd(): void {
        this.isDragging = false;
    }

    protected confirmCrop(): void {
        if (this.confirming()) return;
        this.confirming.set(true);

        const outW = this.outputWidth();
        const outH = this.outputHeight();
        const out = document.createElement('canvas');
        out.width = outW;
        out.height = outH;
        const ctx = out.getContext('2d')!;

        const w = this.img.naturalWidth * this.scale;
        const h = this.img.naturalHeight * this.scale;
        const imgLeft = this.SIZE / 2 + this.offsetX - w / 2;
        const imgTop = this.SIZE / 2 + this.offsetY - h / 2;

        const left = (this.SIZE - this.cropWidth) / 2;
        const top = (this.SIZE - this.cropHeight) / 2;
        const srcX = (left - imgLeft) / this.scale;
        const srcY = (top - imgTop) / this.scale;
        const srcW = this.cropWidth / this.scale;
        const srcH = this.cropHeight / this.scale;

        if (this.circular()) {
            ctx.beginPath();
            ctx.ellipse(outW / 2, outH / 2, outW / 2, outH / 2, 0, 0, Math.PI * 2);
            ctx.clip();
        }

        ctx.drawImage(this.img, srcX, srcY, srcW, srcH, 0, 0, outW, outH);

        out.toBlob(blob => {
            if (!blob) {
                this.confirming.set(false);
                return;
            }
            this.confirmed.emit(new File([blob], 'cropped.png', {type: 'image/png'}));
        }, 'image/png');
    }

    private draw(): void {
        const canvas = this.canvasRef().nativeElement;
        const ctx = canvas.getContext('2d')!;
        const S = this.SIZE;
        const w = this.img.naturalWidth * this.scale;
        const h = this.img.naturalHeight * this.scale;

        ctx.clearRect(0, 0, S, S);

        ctx.drawImage(this.img, S / 2 + this.offsetX - w / 2, S / 2 + this.offsetY - h / 2, w, h);

        const cw = this.cropWidth;
        const ch = this.cropHeight;
        const left = (S - cw) / 2;
        const top = (S - ch) / 2;

        // Dark overlay with crop hole via even-odd fill rule
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, S, S);
        if (this.circular()) {
            ctx.arc(S / 2, S / 2, cw / 2, 0, Math.PI * 2, true);
        } else {
            ctx.rect(left, top, cw, ch);
        }
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        ctx.fill('evenodd');
        ctx.restore();

        // Crop border
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = 1.5;
        if (this.circular()) {
            ctx.beginPath();
            ctx.arc(S / 2, S / 2, cw / 2, 0, Math.PI * 2);
            ctx.stroke();
        } else {
            ctx.strokeRect(left, top, cw, ch);
            // Rule-of-thirds guides
            ctx.strokeStyle = 'rgba(255,255,255,0.18)';
            ctx.lineWidth = 0.75;
            ctx.beginPath();
            for (let i = 1; i < 3; i++) {
                ctx.moveTo(left + (cw / 3) * i, top);
                ctx.lineTo(left + (cw / 3) * i, top + ch);
                ctx.moveTo(left, top + (ch / 3) * i);
                ctx.lineTo(left + cw, top + (ch / 3) * i);
            }
            ctx.stroke();
        }
    }

    private touchDist(e: TouchEvent): number {
        return Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY,
        );
    }

    private minScale(): number {
        return Math.max(this.cropWidth / this.img.naturalWidth, this.cropHeight / this.img.naturalHeight);
    }

    private clamp(): void {
        const maxX = (this.img.naturalWidth * this.scale - this.cropWidth) / 2;
        const maxY = (this.img.naturalHeight * this.scale - this.cropHeight) / 2;
        this.offsetX = Math.max(-maxX, Math.min(maxX, this.offsetX));
        this.offsetY = Math.max(-maxY, Math.min(maxY, this.offsetY));
    }
}
