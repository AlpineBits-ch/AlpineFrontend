import { Component, input, OnDestroy, output, signal } from '@angular/core';

@Component({
  selector: 'app-reaction-picker',
  imports: [],
  templateUrl: './reaction-picker.component.html',
})
export class ReactionPickerComponent implements OnDestroy {
  emojiSelected = output<string>();
  /** toolbar = opens downward; bar = opens upward */
  mode = input<'toolbar' | 'bar'>('toolbar');

  isOpen = signal(false);

  private bodyContainer: HTMLDivElement | null = null;
  private pickerInstance: HTMLElement | null = null;
  private outsideClickListener: ((e: MouseEvent) => void) | null = null;
  private triggerRef: HTMLElement | null = null;

  async toggle(event: MouseEvent): Promise<void> {
    this.triggerRef = event.currentTarget as HTMLElement;

    if (this.isOpen()) {
      this.close();
      return;
    }

    if (!this.bodyContainer) {
      this.bodyContainer = document.createElement('div');
      this.bodyContainer.style.cssText = 'position:fixed;z-index:9999;display:none';
      document.body.appendChild(this.bodyContainer);
    }

    if (!this.pickerInstance) {
      const [{ Picker }, data] = await Promise.all([
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
        onEmojiSelect: (emoji: { native: string }) => {
          this.emojiSelected.emit(emoji.native);
          this.close();
        },
      }) as unknown as HTMLElement;
      this.bodyContainer.appendChild(this.pickerInstance);
    }

    this.position(this.triggerRef);
    this.bodyContainer.style.display = 'block';
    this.isOpen.set(true);

    setTimeout(() => {
      this.outsideClickListener = (e: MouseEvent) => {
        const target = e.target as Node;
        if (!this.bodyContainer?.contains(target) && !this.triggerRef?.contains(target)) {
          this.close();
        }
      };
      document.addEventListener('mousedown', this.outsideClickListener);
    }, 0);
  }

  private position(trigger: HTMLElement): void {
    if (!this.bodyContainer) return;
    const rect = trigger.getBoundingClientRect();
    const pickerW = 352;
    const pickerH = 450;
    const margin = 6;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const left = Math.max(8, Math.min(rect.right - pickerW, vw - pickerW - 8));

    let top: number;
    if (this.mode() === 'bar') {
      top = rect.top - pickerH - margin;
      if (top < 8) top = rect.bottom + margin;
    } else {
      top = rect.bottom + margin;
      if (top + pickerH > vh - 8) top = rect.top - pickerH - margin;
    }

    this.bodyContainer.style.left = `${left}px`;
    this.bodyContainer.style.top = `${top}px`;
  }

  close(): void {
    this.isOpen.set(false);
    if (this.bodyContainer) this.bodyContainer.style.display = 'none';
    if (this.outsideClickListener) {
      document.removeEventListener('mousedown', this.outsideClickListener);
      this.outsideClickListener = null;
    }
  }

  ngOnDestroy(): void {
    this.close();
    if (this.bodyContainer) {
      document.body.removeChild(this.bodyContainer);
      this.bodyContainer = null;
    }
  }
}
