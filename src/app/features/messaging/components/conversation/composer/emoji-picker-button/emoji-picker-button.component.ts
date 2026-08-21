import {
    ChangeDetectionStrategy,
    Component,
    ElementRef,
    OnDestroy,
    output,
    signal,
    viewChild,
} from '@angular/core';
import {Button} from 'primeng/button';

@Component({
    selector: 'app-emoji-picker-button',
    imports: [Button],
    templateUrl: './emoji-picker-button.component.html',
    styleUrl: './emoji-picker-button.component.css',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EmojiPickerButtonComponent implements OnDestroy {
    emojiSelected = output<string>();

    readonly showPicker = signal(false);
    readonly pickerContainerRef = viewChild<ElementRef<HTMLDivElement>>('pickerContainer');

    private pickerInstance: HTMLElement | null = null;
    private outsideClickListener: ((e: MouseEvent) => void) | null = null;

    async toggle(): Promise<void> {
        if (this.showPicker()) {
            this.close();
            return;
        }

        if (!this.pickerInstance) {
            const [{Picker}, data] = await Promise.all([
                import('emoji-mart'),
                import('@emoji-mart/data/sets/15/twitter.json'),
            ]);

            this.pickerInstance = new Picker({
                data: data.default ?? data,
                set: 'twitter',
                getSpritesheetURL: () => '/emoji-sheets/twitter/64.png',
                theme: 'dark',
                previewPosition: 'none',
                skinTonePosition: 'none',
                onEmojiSelect: (emoji: {native: string}) => {
                    this.emojiSelected.emit(emoji.native);
                    this.close();
                },
            }) as unknown as HTMLElement;

            const container = this.pickerContainerRef()?.nativeElement;
            if (container) container.appendChild(this.pickerInstance);
        }

        this.showPicker.set(true);

        setTimeout(() => {
            this.outsideClickListener = (e: MouseEvent) => {
                const container = this.pickerContainerRef()?.nativeElement;
                if (container && !container.contains(e.target as Node)) {
                    this.close();
                }
            };
            document.addEventListener('mousedown', this.outsideClickListener);
        }, 0);
    }

    close(): void {
        this.showPicker.set(false);
        if (this.outsideClickListener) {
            document.removeEventListener('mousedown', this.outsideClickListener);
            this.outsideClickListener = null;
        }
    }

    ngOnDestroy(): void {
        this.close();
    }
}
