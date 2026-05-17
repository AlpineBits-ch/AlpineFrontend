import {AfterViewInit, Component, ElementRef, EventEmitter, OnDestroy, Output, signal, ViewChild,} from '@angular/core';
import {Button} from 'primeng/button';
import {TranslateModule} from '@ngx-translate/core';

interface GridCell {
    brightness: number;
    visited: boolean;
}

@Component({
    selector: 'app-entropy-modal',
    standalone: true,
    imports: [Button, TranslateModule],
    templateUrl: './entropy-modal.component.html',
    styleUrl: './entropy-modal.component.css',
})
export class EntropyModalComponent implements AfterViewInit, OnDestroy {
    @ViewChild('entropyCanvas', {static: true}) canvasRef!: ElementRef<HTMLCanvasElement>;
    @Output() done = new EventEmitter<number[]>();

    protected timeRemaining = signal(11);
    protected coveragePercent = signal(0);

    private readonly COLS = 26;
    private readonly ROWS = 14;
    private grid: GridCell[][] = [];
    private visitedCount = 0;

    private entropyBuf = new Uint8Array(64);
    private bytePos = 0;

    private ctx!: CanvasRenderingContext2D;
    private rafId = 0;
    private timerId: ReturnType<typeof setInterval> | null = null;
    private finished = false;

    ngAfterViewInit(): void {
        this.grid = Array.from({length: this.ROWS}, () =>
            Array.from({length: this.COLS}, () => ({brightness: 0, visited: false}))
        );

        const canvas = this.canvasRef.nativeElement;
        this.ctx = canvas.getContext('2d')!;
        // Defer resize so PrimeNG dialog has finished laying out
        setTimeout(() => {
            this.resize();
            this.renderLoop();
        }, 0);

        this.timerId = setInterval(() => {
            const t = this.timeRemaining() - 1;
            this.timeRemaining.set(t);
            if (t <= 0) this.finish();
        }, 1000);

        document.addEventListener('mousemove', this.onMouseMove);
    }

    ngOnDestroy(): void {
        if (this.timerId) clearInterval(this.timerId);
        cancelAnimationFrame(this.rafId);
        document.removeEventListener('mousemove', this.onMouseMove);
    }

    protected skip(): void {
        this.finish();
    }

    private readonly onMouseMove = (e: MouseEvent) => this.handleMouse(e);

    private resize(): void {
        const el = this.canvasRef.nativeElement;
        el.width = el.offsetWidth;
        el.height = el.offsetHeight;
    }

    private handleMouse(event: MouseEvent): void {
        if (this.finished) return;

        const canvas = this.canvasRef.nativeElement;
        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;

        // Always mix raw screen coords into entropy buffer
        this.entropyBuf[this.bytePos % 64] ^= (event.clientX * 7 + this.bytePos) & 0xff;
        this.entropyBuf[(this.bytePos + 1) % 64] ^= (event.clientY * 13 + this.bytePos) & 0xff;
        this.bytePos += 2;

        // Light up the grid cell only when cursor is inside the canvas
        const cw = canvas.width / this.COLS;
        const ch = canvas.height / this.ROWS;
        const col = Math.floor(x / cw);
        const row = Math.floor(y / ch);
        if (col >= 0 && col < this.COLS && row >= 0 && row < this.ROWS) {
            const cell = this.grid[row][col];
            cell.brightness = 1;
            if (!cell.visited) {
                cell.visited = true;
                this.visitedCount++;
                this.coveragePercent.set(
                    Math.round((this.visitedCount / (this.COLS * this.ROWS)) * 100)
                );
            }
        }
    }

    private renderLoop(): void {
        const canvas = this.canvasRef.nativeElement;
        const ctx = this.ctx;
        const cw = canvas.width / this.COLS;
        const ch = canvas.height / this.ROWS;
        const DECAY = 0.94;

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        for (let r = 0; r < this.ROWS; r++) {
            for (let c = 0; c < this.COLS; c++) {
                const cell = this.grid[r][c];
                const x = c * cw;
                const y = r * ch;

                if (cell.visited) {
                    ctx.fillStyle = 'rgba(99,102,241,0.12)';
                    ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2);
                }

                if (cell.brightness > 0.01) {
                    ctx.fillStyle = `rgba(99,102,241,${cell.brightness * 0.85})`;
                    ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2);

                    const m = cw * 0.28;
                    ctx.fillStyle = `rgba(165,180,252,${cell.brightness * 0.55})`;
                    ctx.fillRect(x + m, y + m, cw - m * 2, ch - m * 2);

                    cell.brightness *= DECAY;
                }
            }
        }

        this.rafId = requestAnimationFrame(() => this.renderLoop());
    }

    private finish(): void {
        if (this.finished) return;
        this.finished = true;
        if (this.timerId) {
            clearInterval(this.timerId);
            this.timerId = null;
        }
        cancelAnimationFrame(this.rafId);
        document.removeEventListener('mousemove', this.onMouseMove);
        this.done.emit(Array.from(this.entropyBuf));
    }
}
