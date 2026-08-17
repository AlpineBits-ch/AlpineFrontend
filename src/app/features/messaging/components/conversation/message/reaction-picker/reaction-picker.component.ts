import {Component, computed, effect, input, OnDestroy, output, signal, untracked} from '@angular/core';
import {inject} from '@angular/core';
import {GuildEmojiStore} from '../../../../../../stores/guild-emoji.store';

export interface EmojiSelection {
    native?: string;
    customEmojiId?: string;
    customEmojiName?: string;
}

@Component({
    selector: 'app-reaction-picker',
    imports: [],
    templateUrl: './reaction-picker.component.html',
})
export class ReactionPickerComponent implements OnDestroy {
    emojiSelected = output<EmojiSelection>();
    /** toolbar = opens downward; bar = opens upward */
    readonly mode = input<'toolbar' | 'bar'>('toolbar');
    /** Set only in guild channels - custom emoji never render in DMs. */
    readonly guildId = input<string | undefined>();

    readonly isOpen = signal(false);

    private guildEmojiStore = inject(GuildEmojiStore);
    private readonly customEmojis = computed(() => {
        const guildId = this.guildId();
        return guildId ? this.guildEmojiStore.getEmojis(guildId) : [];
    });
    private builtCustomEmojiKey = '';
    private bodyContainer: HTMLDivElement | null = null;
    private pickerInstance: HTMLElement | null = null;
    private outsideClickListener: ((e: MouseEvent) => void) | null = null;
    private triggerRef: HTMLElement | null = null;

    constructor() {
        effect(() => {
            const guildId = this.guildId();
            // untracked: ensureLoaded() both reads and writes the store's state, so calling
            // it inside the reactive context would make the effect depend on the very state
            // it mutates and re-run in a loop.
            if (guildId) untracked(() => this.guildEmojiStore.ensureLoaded(guildId));
        });
    }

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

        const customEmojis = this.customEmojis();
        // imageUrl is part of the key: presigned URLs expire ~1h, so a revalidation can
        // change only the URLs while the id set stays identical - a cached picker would
        // otherwise keep serving expired (broken) images.
        const customEmojiKey = customEmojis.map(e => `${e.id}|${e.imageUrl}`).join(',');
        if (this.pickerInstance && customEmojiKey !== this.builtCustomEmojiKey) {
            this.bodyContainer.removeChild(this.pickerInstance);
            this.pickerInstance = null;
        }

        if (!this.pickerInstance) {
            const [{Picker}, data] = await Promise.all([
                import('emoji-mart'),
                import('@emoji-mart/data/sets/15/twitter.json'),
            ]);
            this.builtCustomEmojiKey = customEmojiKey;
            this.pickerInstance = new Picker({
                data: data.default ?? data,
                set: 'twitter',
                getSpritesheetURL: () => '/emoji-sheets/twitter/64.png',
                theme: 'dark',
                previewPosition: 'none',
                skinTonePosition: 'none',
                custom: customEmojis.length
                    ? [
                          {
                              id: 'guild',
                              name: 'This Server',
                              emojis: customEmojis.map(e => ({
                                  id: e.id,
                                  name: e.name,
                                  keywords: [e.name],
                                  skins: [{src: e.imageUrl}],
                              })),
                          },
                      ]
                    : [],
                onEmojiSelect: (emoji: {native?: string; id: string; name: string; src?: string}) => {
                    if (emoji.src) {
                        this.emojiSelected.emit({customEmojiId: emoji.id, customEmojiName: emoji.name});
                    } else {
                        this.emojiSelected.emit({native: emoji.native});
                    }
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
}
