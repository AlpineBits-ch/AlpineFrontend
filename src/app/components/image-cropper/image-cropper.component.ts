import {AfterViewInit, Component, ElementRef, input, OnDestroy, output, ViewChild,} from '@angular/core';
import {Button} from 'primeng/button';

@Component({
    selector: 'app-image-cropper',
    imports: [Button],
    templateUrl: './image-cropper.component.html',
})
export class ImageCropperComponent implements AfterViewInit, OnDestroy {
    imageSrc = input.required<string>();
    circular = input(false);
    outputSize = input(400);

    confirmed = output<File>();
    cancelled = output<void>();

    @ViewChild('cropCanvas') private canvasRef!: ElementRef<HTMLCanvasElement>;

    private readonly SIZE = 320;
    private readonly CROP = 240;
    private readonly PAD = 40;

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
        const canvas = this.canvasRef.nativeElement;

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
                this.CROP / this.img.naturalWidth,
                this.CROP / this.img.naturalHeight,
            );
            this.offsetX = 0;
            this.offsetY = 0;
            this.draw();
        };
        this.img.src = this.imageSrc();
    }

    ngOnDestroy(): void {
        if (this.canvasRef) {
            const canvas = this.canvasRef.nativeElement;
            canvas.removeEventListener('wheel', this.boundWheel);
            canvas.removeEventListener('touchmove', this.boundTouchMove);
        }
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
        const size = this.outputSize();
        const out = document.createElement('canvas');
        out.width = size;
        out.height = size;
        const ctx = out.getContext('2d')!;

        const w = this.img.naturalWidth * this.scale;
        const h = this.img.naturalHeight * this.scale;
        const imgLeft = this.SIZE / 2 + this.offsetX - w / 2;
        const imgTop = this.SIZE / 2 + this.offsetY - h / 2;

        const srcX = (this.PAD - imgLeft) / this.scale;
        const srcY = (this.PAD - imgTop) / this.scale;
        const srcSize = this.CROP / this.scale;

        if (this.circular()) {
            ctx.beginPath();
            ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
            ctx.clip();
        }

        ctx.drawImage(this.img, srcX, srcY, srcSize, srcSize, 0, 0, size, size);

        out.toBlob(blob => {
            if (!blob) return;
            this.confirmed.emit(new File([blob], 'cropped.png', {type: 'image/png'}));
        }, 'image/png');
    }

    private draw(): void {
        const canvas = this.canvasRef.nativeElement;
        const ctx = canvas.getContext('2d')!;
        const S = this.SIZE;
        const C = this.CROP;
        const P = this.PAD;
        const w = this.img.naturalWidth * this.scale;
        const h = this.img.naturalHeight * this.scale;

        ctx.clearRect(0, 0, S, S);

        ctx.drawImage(this.img, S / 2 + this.offsetX - w / 2, S / 2 + this.offsetY - h / 2, w, h);

        // Dark overlay with crop hole via even-odd fill rule
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, S, S);
        if (this.circular()) {
            ctx.arc(S / 2, S / 2, C / 2, 0, Math.PI * 2, true);
        } else {
            ctx.rect(P, P, C, C);
        }
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        ctx.fill('evenodd');
        ctx.restore();

        // Crop border
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = 1.5;
        if (this.circular()) {
            ctx.beginPath();
            ctx.arc(S / 2, S / 2, C / 2, 0, Math.PI * 2);
            ctx.stroke();
        } else {
            ctx.strokeRect(P, P, C, C);
            // Rule-of-thirds guides
            ctx.strokeStyle = 'rgba(255,255,255,0.18)';
            ctx.lineWidth = 0.75;
            ctx.beginPath();
            for (let i = 1; i < 3; i++) {
                ctx.moveTo(P + (C / 3) * i, P);
                ctx.lineTo(P + (C / 3) * i, P + C);
                ctx.moveTo(P, P + (C / 3) * i);
                ctx.lineTo(P + C, P + (C / 3) * i);
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
        return Math.max(this.CROP / this.img.naturalWidth, this.CROP / this.img.naturalHeight);
    }

    private clamp(): void {
        const maxX = (this.img.naturalWidth * this.scale - this.CROP) / 2;
        const maxY = (this.img.naturalHeight * this.scale - this.CROP) / 2;
        this.offsetX = Math.max(-maxX, Math.min(maxX, this.offsetX));
        this.offsetY = Math.max(-maxY, Math.min(maxY, this.offsetY));
    }
}
