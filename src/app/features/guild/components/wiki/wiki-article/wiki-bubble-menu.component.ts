import {Component, input, signal} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {Editor} from '@tiptap/core';

interface BubbleAction {
    label: string;
    titleKey: string;
    mark: string;
    attrs?: Record<string, unknown>;
    run: (editor: Editor) => void;
    className?: string;
}

/**
 * Inline formatting, shown only while text is selected.
 *
 * Replaces the always-visible half of the old 20-button toolbar: these actions are meaningless
 * without a selection, so a permanent bar spent screen space advertising controls that were
 * inert most of the time.
 */
@Component({
    selector: 'app-wiki-bubble-menu',
    imports: [TranslateModule],
    template: `
        @if (visible()) {
            <div [style.left.px]="position().left" [style.top.px]="position().top"
                 class="fixed z-50 flex -translate-x-1/2 -translate-y-full items-center gap-0.5
                        rounded-lg border border-border bg-card px-1 py-1 shadow-xl">
                @for (action of actions; track action.titleKey) {
                    <button (click)="apply(action)"
                            [class.text-brand-dim]="isActive(action)"
                            [class]="action.className"
                            [title]="action.titleKey | translate"
                            class="flex h-7 min-w-7 cursor-pointer items-center justify-center
                                   rounded-md border-0 bg-transparent px-1.5 text-white/55
                                   transition-colors hover:bg-hover hover:text-white/90">
                        {{ action.label }}
                    </button>
                }
            </div>
        }
    `,
})
export class WikiBubbleMenuComponent {
    readonly editor = input<Editor | undefined>(undefined);

    protected readonly visible = signal(false);
    protected readonly position = signal({top: 0, left: 0});

    protected readonly actions: BubbleAction[] = [
        {label: 'B', titleKey: 'WIKI.FORMAT.BOLD', mark: 'bold', className: 'font-bold', run: e => e.chain().focus().toggleBold().run()},
        {label: 'I', titleKey: 'WIKI.FORMAT.ITALIC', mark: 'italic', className: 'italic', run: e => e.chain().focus().toggleItalic().run()},
        {label: 'U', titleKey: 'WIKI.FORMAT.UNDERLINE', mark: 'underline', className: 'underline', run: e => e.chain().focus().toggleUnderline().run()},
        {label: 'S', titleKey: 'WIKI.FORMAT.STRIKETHROUGH', mark: 'strike', className: 'line-through', run: e => e.chain().focus().toggleStrike().run()},
        {label: '<>', titleKey: 'WIKI.FORMAT.INLINE_CODE', mark: 'code', className: 'font-mono text-[0.6875rem]', run: e => e.chain().focus().toggleCode().run()},
        {label: 'H1', titleKey: 'WIKI.BLOCK.HEADING_1', mark: 'heading', attrs: {level: 1}, className: 'text-[0.6875rem] font-bold', run: e => e.chain().focus().toggleHeading({level: 1}).run()},
        {label: 'H2', titleKey: 'WIKI.BLOCK.HEADING_2', mark: 'heading', attrs: {level: 2}, className: 'text-[0.6875rem] font-bold', run: e => e.chain().focus().toggleHeading({level: 2}).run()},
        {label: 'H3', titleKey: 'WIKI.BLOCK.HEADING_3', mark: 'heading', attrs: {level: 3}, className: 'text-[0.6875rem] font-bold', run: e => e.chain().focus().toggleHeading({level: 3}).run()},
        {label: '❝', titleKey: 'WIKI.BLOCK.QUOTE', mark: 'blockquote', run: e => e.chain().focus().toggleBlockquote().run()},
    ];

    /** Called by the article on every selection change. */
    sync(): void {
        const editor = this.editor();
        if (!editor || !editor.isEditable) {
            this.visible.set(false);
            return;
        }
        const {from, to, empty} = editor.state.selection;
        if (empty || from === to) {
            this.visible.set(false);
            return;
        }
        const start = editor.view.coordsAtPos(from);
        const end = editor.view.coordsAtPos(to);
        this.position.set({
            top: Math.min(start.top, end.top) - 8,
            left: (start.left + end.left) / 2,
        });
        this.visible.set(true);
    }

    protected isActive(action: BubbleAction): boolean {
        return this.editor()?.isActive(action.mark, action.attrs) ?? false;
    }

    protected apply(action: BubbleAction): void {
        const editor = this.editor();
        if (editor) action.run(editor);
    }
}
