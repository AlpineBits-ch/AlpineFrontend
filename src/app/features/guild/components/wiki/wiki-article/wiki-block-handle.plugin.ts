import {Editor, Extension} from '@tiptap/core';
import {NodeSelection, Plugin, PluginKey, TextSelection} from '@tiptap/pm/state';
import {EditorView} from '@tiptap/pm/view';
import {Fragment, Node as ProseMirrorNode, Slice} from '@tiptap/pm/model';
import {buildToc, Heading} from '../wiki-toc';
import {wikiHref} from '../wiki-links';
import {SlashItem} from './wiki-slash-menu.component';
import {anchorTo, WikiFloatingController} from './wiki-floating';

/**
 * The hover gutter beside every top-level block: a grip to drag it and a `+` to insert under it.
 *
 * One element for the whole document, moved to the hovered block, rather than a widget decoration
 * per block: decorations are rebuilt on every transaction, and a handle per block would make each
 * keystroke proportional to the length of the page.
 */

export interface WikiBlockHandleState {
    /** Document position of the top-level node under the pointer. */
    hoveredBlockPos: number | null;
}

export const wikiBlockHandleKey = new PluginKey<WikiBlockHandleState>('wikiBlockHandle');

export interface WikiBlockHandleLabels {
    drag: string;
    insertBelow: string;
    turnInto: string;
    duplicate: string;
    copyLink: string;
    remove: string;
    back: string;
}

export const DEFAULT_WIKI_BLOCK_HANDLE_LABELS: WikiBlockHandleLabels = {
    drag: 'Drag to move, click to open',
    insertBelow: 'Insert below',
    turnInto: 'Turn into',
    duplicate: 'Duplicate',
    copyLink: 'Copy link to block',
    remove: 'Delete',
    back: 'Back',
};

export interface WikiBlockHandleOptions {
    labels?: WikiBlockHandleLabels;
    /**
     * The "Turn into" rows. Hand it the slash menu's own item list so the two cannot drift; rows
     * without a `run` (the AI and host actions) are skipped, since a block conversion is all this
     * menu can apply.
     */
    turnInto?: () => readonly SlashItem[];
    /** Resolves a `labelKey` from a turn-into row. */
    translate?: (key: string) => string;
    /** The page being edited. Null hides "Copy link to block". */
    pageId?: () => string | null;
    /** Receives the `wiki:` href. Falls back to the system clipboard. */
    onCopyLink?: (href: string) => void;
}

const GUTTER_GAP = 8;
const MENU_SIZE = {width: 224, height: 260};

export function wikiBlockHandlePlugin(editor: Editor, options: WikiBlockHandleOptions = {}): Plugin {
    const labels = options.labels ?? DEFAULT_WIKI_BLOCK_HANDLE_LABELS;

    return new Plugin<WikiBlockHandleState>({
        key: wikiBlockHandleKey,

        state: {
            init: () => ({hoveredBlockPos: null}),
            apply: (tr, value) => {
                const meta = tr.getMeta(wikiBlockHandleKey) as WikiBlockHandleState | undefined;
                if (meta) return meta;
                if (!tr.docChanged) return value;
                if (value.hoveredBlockPos === null) return value;
                return {hoveredBlockPos: tr.mapping.map(value.hoveredBlockPos)};
            },
        },

        props: {
            handleDOMEvents: {
                mousemove: (view, event) => {
                    if (!view.editable) return false;
                    const found = topLevelAt(view, event.clientX, event.clientY);
                    setHovered(view, found?.pos ?? null);
                    return false;
                },
                mouseleave: view => {
                    setHovered(view, null);
                    return false;
                },
            },
        },

        view: view => new BlockHandleView(view, editor, labels, options),
    });
}

/** Registers the plugin in an extension list. */
export const WikiBlockHandle = Extension.create<WikiBlockHandleOptions>({
    name: 'wikiBlockHandle',
    addOptions: () => ({}),
    addProseMirrorPlugins() {
        return [wikiBlockHandlePlugin(this.editor, this.options)];
    },
});

/** Dispatched only on a change, so sweeping across one paragraph costs nothing. */
function setHovered(view: EditorView, pos: number | null): void {
    const current = wikiBlockHandleKey.getState(view.state)?.hoveredBlockPos ?? null;
    if (current === pos) return;
    view.dispatch(
        view.state.tr.setMeta(wikiBlockHandleKey, {hoveredBlockPos: pos}).setMeta('addToHistory', false),
    );
}

/** The top-level node under a viewport point, walking out to depth 1. */
function topLevelAt(
    view: EditorView,
    left: number,
    top: number,
): {pos: number; node: ProseMirrorNode} | null {
    const found = view.posAtCoords({left, top});
    if (!found) return null;
    const $pos = view.state.doc.resolve(found.inside >= 0 ? found.inside : found.pos);
    if ($pos.depth === 0) return null;
    const pos = $pos.before(1);
    const node = view.state.doc.nodeAt(pos);
    return node ? {pos, node} : null;
}

function prefersReducedMotion(): boolean {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/** Owns the single gutter element and the block menu it opens. */
class BlockHandleView {
    private readonly root: HTMLElement;
    private readonly menu: HTMLElement;
    private readonly floating: WikiFloatingController;
    private pos: number | null = null;
    private menuOpen = false;
    private overHandle = false;
    /** The grip the open menu is anchored to. */
    private anchorEl: HTMLElement | null = null;

    constructor(
        private readonly view: EditorView,
        private readonly editor: Editor,
        private readonly labels: WikiBlockHandleLabels,
        private readonly options: WikiBlockHandleOptions,
    ) {
        this.root = document.createElement('div');
        this.root.className = 'wiki-block-handle';
        this.root.setAttribute('contenteditable', 'false');
        style(this.root, {
            position: 'fixed',
            display: 'none',
            zIndex: '40',
            alignItems: 'center',
            gap: '2px',
            transition: prefersReducedMotion() ? 'none' : 'opacity var(--duration-fast, 100ms) linear',
        });
        this.root.addEventListener('mouseenter', () => (this.overHandle = true));
        this.root.addEventListener('mouseleave', () => {
            this.overHandle = false;
            if (!this.menuOpen) this.hide();
        });

        const plus = this.button('pi-plus', this.labels.insertBelow);
        plus.addEventListener('click', () => this.insertBelow());

        const grip = this.button('pi-bars', this.labels.drag);
        grip.draggable = true;
        grip.addEventListener('click', () => this.openMenu(grip));
        grip.addEventListener('dragstart', event => this.onDragStart(event));
        grip.addEventListener('dragend', () => {
            this.view.dragging = null;
        });

        this.root.append(plus, grip);
        document.body.appendChild(this.root);

        this.menu = document.createElement('div');
        style(this.menu, {
            position: 'fixed',
            display: 'none',
            zIndex: '50',
            width: `${MENU_SIZE.width}px`,
            padding: '4px 0',
            borderRadius: '12px',
            border: '1px solid var(--color-border)',
            background: 'var(--color-card)',
            boxShadow: '0 20px 25px -5px rgb(0 0 0 / 0.4)',
            overflow: 'hidden auto',
            maxHeight: `${MENU_SIZE.height}px`,
        });
        document.body.appendChild(this.menu);

        this.floating = new WikiFloatingController({
            reposition: () => this.place(),
            close: () => this.closeMenu(),
            contains: node => this.menu.contains(node) || this.root.contains(node),
        });
    }

    update(view: EditorView): void {
        const pos = wikiBlockHandleKey.getState(view.state)?.hoveredBlockPos ?? null;
        if (!view.editable) {
            this.closeMenu();
            this.hide();
            return;
        }
        this.pos = pos;
        if (pos === null && !this.menuOpen && !this.overHandle) {
            this.hide();
            return;
        }
        this.place();
    }

    destroy(): void {
        this.floating.detach();
        this.root.remove();
        this.menu.remove();
    }

    private place(): void {
        const pos = this.pos;
        if (pos === null) return;
        const dom = this.view.nodeDOM(pos);
        if (!(dom instanceof HTMLElement)) {
            this.hide();
            return;
        }
        const rect = dom.getBoundingClientRect();
        this.root.style.display = 'flex';
        this.root.style.top = `${rect.top}px`;
        this.root.style.left = `${rect.left - this.root.offsetWidth - GUTTER_GAP}px`;
        if (this.menuOpen) this.placeMenu();
    }

    private hide(): void {
        this.root.style.display = 'none';
    }

    private button(icon: string, title: string): HTMLButtonElement {
        const button = document.createElement('button');
        button.type = 'button';
        button.title = title;
        button.setAttribute('aria-label', title);
        style(button, {
            display: 'flex',
            width: '20px',
            height: '20px',
            alignItems: 'center',
            justifyContent: 'center',
            border: '0',
            borderRadius: '4px',
            background: 'transparent',
            color: 'var(--color-text-muted)',
            cursor: 'pointer',
        });
        button.addEventListener('mouseenter', () => (button.style.background = 'var(--color-hover)'));
        button.addEventListener('mouseleave', () => (button.style.background = 'transparent'));
        // Suppressed: pressing a button otherwise blurs the editor and collapses the selection the
        // command is defined against.
        button.addEventListener('mousedown', event => event.preventDefault());
        const glyph = document.createElement('i');
        glyph.className = `pi ${icon}`;
        glyph.style.fontSize = '0.625rem';
        button.appendChild(glyph);
        return button;
    }

    private currentNode(): {pos: number; node: ProseMirrorNode} | null {
        const pos = this.pos;
        if (pos === null) return null;
        const node = this.view.state.doc.nodeAt(pos);
        return node ? {pos, node} : null;
    }

    private onDragStart(event: DragEvent): void {
        const current = this.currentNode();
        if (!current || !event.dataTransfer) return;
        const {pos, node} = current;
        this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)));
        // ProseMirror's own drop handler reads view.dragging and does the move, which is what keeps
        // the whole thing to a single undo step.
        this.view.dragging = {slice: new Slice(Fragment.from(node), 0, 0), move: true};
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/html', '');
        const dom = this.view.nodeDOM(pos);
        if (dom instanceof HTMLElement) event.dataTransfer.setDragImage(dom, 0, 0);
    }

    private insertBelow(): void {
        const current = this.currentNode();
        if (!current) return;
        const {pos, node} = current;
        const type = this.view.state.schema.nodes['paragraph'];
        const paragraph = type?.createAndFill();
        if (!paragraph) return;
        const at = pos + node.nodeSize;
        const tr = this.view.state.tr.insert(at, paragraph);
        tr.setSelection(TextSelection.create(tr.doc, at + 1)).scrollIntoView();
        this.view.dispatch(tr);
        this.view.focus();
    }

    private openMenu(anchor: HTMLElement): void {
        const current = this.currentNode();
        if (!current) return;
        // A NodeSelection, so Backspace acts on the block rather than on a character inside it.
        this.view.dispatch(
            this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, current.pos)),
        );
        this.menuOpen = true;
        this.renderRoot();
        this.menu.style.display = 'block';
        this.anchorEl = anchor;
        this.placeMenu();
        this.floating.attach();
    }

    private placeMenu(): void {
        const anchor = this.anchorEl ?? this.root;
        const rect = anchor.getBoundingClientRect();
        const placed = anchorTo(rect, {
            width: MENU_SIZE.width,
            height: this.menu.offsetHeight || MENU_SIZE.height,
        });
        this.menu.style.top = `${placed.top}px`;
        this.menu.style.left = `${placed.left}px`;
    }

    private closeMenu(): void {
        if (!this.menuOpen) return;
        this.menuOpen = false;
        this.menu.style.display = 'none';
        this.floating.detach();
        if (!this.overHandle) this.hide();
    }

    private renderRoot(): void {
        this.menu.replaceChildren();
        const turnInto = (this.options.turnInto?.() ?? []).filter(item => !!item.run);
        if (turnInto.length) {
            this.menu.appendChild(
                this.row('pi-refresh', this.labels.turnInto, () => this.renderTurnInto(turnInto), true),
            );
        }
        this.menu.appendChild(this.row('pi-copy', this.labels.duplicate, () => this.duplicate()));
        if (this.options.pageId?.()) {
            this.menu.appendChild(this.row('pi-link', this.labels.copyLink, () => this.copyLink()));
        }
        this.menu.appendChild(this.row('pi-trash', this.labels.remove, () => this.remove(), false, true));
    }

    private renderTurnInto(items: readonly SlashItem[]): void {
        this.menu.replaceChildren();
        this.menu.appendChild(this.row('pi-angle-left', this.labels.back, () => this.renderRoot()));
        for (const item of items) {
            const label = this.options.translate?.(item.labelKey) ?? item.labelKey;
            this.menu.appendChild(this.row(item.icon, label, () => this.turnInto(item)));
        }
    }

    private row(
        icon: string,
        label: string,
        run: () => void,
        submenu = false,
        danger = false,
    ): HTMLButtonElement {
        const button = document.createElement('button');
        button.type = 'button';
        style(button, {
            display: 'flex',
            width: '100%',
            alignItems: 'center',
            gap: '10px',
            border: '0',
            background: 'transparent',
            padding: '6px 12px',
            textAlign: 'left',
            fontSize: '0.8125rem',
            color: danger ? 'var(--color-offline)' : 'var(--color-text-primary)',
            cursor: 'pointer',
        });
        button.addEventListener('mouseenter', () => (button.style.background = 'var(--color-hover)'));
        button.addEventListener('mouseleave', () => (button.style.background = 'transparent'));
        button.addEventListener('mousedown', event => event.preventDefault());
        button.addEventListener('click', () => run());

        const glyph = document.createElement('i');
        glyph.className = `pi ${icon}`;
        glyph.style.fontSize = '0.75rem';
        glyph.style.color = danger ? 'var(--color-offline)' : 'var(--color-text-muted)';
        const text = document.createElement('span');
        text.style.flex = '1';
        text.textContent = label;
        button.append(glyph, text);
        if (submenu) {
            const chevron = document.createElement('i');
            chevron.className = 'pi pi-angle-right';
            chevron.style.fontSize = '0.625rem';
            chevron.style.color = 'var(--color-text-muted)';
            button.appendChild(chevron);
        }
        return button;
    }

    private turnInto(item: SlashItem): void {
        const current = this.currentNode();
        if (!current || !item.run) return;
        // Inside the block, not on it: every conversion command is written against a text cursor.
        this.view.dispatch(
            this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, current.pos + 1)),
        );
        item.run(this.editor);
        this.closeMenu();
    }

    private duplicate(): void {
        const current = this.currentNode();
        if (!current) return;
        const {pos, node} = current;
        this.view.dispatch(this.view.state.tr.insert(pos + node.nodeSize, node));
        this.closeMenu();
    }

    private remove(): void {
        const current = this.currentNode();
        if (!current) return;
        const {pos, node} = current;
        this.view.dispatch(this.view.state.tr.delete(pos, pos + node.nodeSize));
        this.closeMenu();
    }

    private copyLink(): void {
        const pageId = this.options.pageId?.();
        const current = this.currentNode();
        if (!pageId || !current) return;
        const href = wikiHref(pageId, headingAnchorFor(this.view.state.doc, current.pos));
        if (this.options.onCopyLink) this.options.onCopyLink(href);
        else void navigator.clipboard?.writeText(href);
        this.closeMenu();
    }
}

/**
 * The anchor a link to this block should carry: the block's own heading, else the nearest heading
 * above it. Ids come from {@link buildToc} so they match what the table of contents stamped on the
 * rendered document.
 */
export function headingAnchorFor(doc: ProseMirrorNode, blockPos: number): string | null {
    const headings: Heading[] = [];
    const positions: number[] = [];
    doc.descendants((node, pos) => {
        if (node.type.name !== 'heading') return true;
        headings.push({level: node.attrs['level'] as number, text: node.textContent});
        positions.push(pos);
        return false;
    });
    const entries = buildToc(headings);
    let anchor: string | null = null;
    for (let i = 0; i < positions.length; i++) {
        if (positions[i] > blockPos) break;
        anchor = entries[i]?.id ?? null;
    }
    return anchor;
}

function style(element: HTMLElement, values: Record<string, string>): void {
    for (const [name, value] of Object.entries(values)) element.style.setProperty(kebab(name), value);
}

function kebab(name: string): string {
    return name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
}
