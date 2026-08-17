import {Editor} from '@tiptap/core';
import Image, {ImageOptions} from '@tiptap/extension-image';
import {Plugin, PluginKey} from '@tiptap/pm/state';
import {NodeView, ViewMutationRecord} from '@tiptap/pm/view';
import {Node as ProseMirrorNode} from '@tiptap/pm/model';
import {DEFAULT_WIKI_BLOCK_LABELS, WikiBlockLabels} from './wiki-block-labels';

/**
 * Images with a caption, a drag handle and a lightbox.
 *
 * A sized image serialises as raw HTML (`<img src="…" alt="…" width="640">`); an unsized one stays
 * `![alt](src)`. The caption is the alt text: one field is both the accessible name and the printed
 * caption. Upload and the blob-URL swap stay in the article component; this node never learns about
 * files.
 *
 * For an authenticated source, `sources` fetches the bytes and the view shows an object URL; the
 * node's own `src` attribute (what gets saved) is never touched, so a page still round trips
 * through markdown as the URL it really is.
 */

const MIN_WIDTH = 64;

/** Fetches image sources the browser cannot fetch for itself; deliberately narrower than "the HTTP client": all this node needs is whether a source must be asked about, and how to get its bytes. */
export interface WikiImageSources {
    /** Whether `src` is one this resolver must fetch, rather than one the browser can load. */
    needsAuth(src: string): boolean;

    fetch(src: string): Promise<Blob>;
}

export interface WikiImageOptions extends ImageOptions {
    labels: WikiBlockLabels;
    /** Omitted outside the app: tests and tooling render plain URLs and need no resolver. */
    sources: WikiImageSources | null;
}

interface WikiImageStorage {
    views: Set<WikiImageView>;
}

function escapeAttribute(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function widthOf(value: unknown): number | null {
    const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed >= MIN_WIDTH ? Math.round(parsed) : null;
}

class WikiImageView implements NodeView {
    readonly dom: HTMLElement;

    private readonly frame: HTMLElement;
    private readonly image: HTMLImageElement;
    private readonly handle: HTMLElement;
    private readonly captionInput: HTMLInputElement;
    private readonly caption: HTMLElement;

    private node: ProseMirrorNode;
    private editable: boolean;
    private captionTimer?: ReturnType<typeof setTimeout>;
    private lightbox?: HTMLElement;
    private escapeHandler?: (event: KeyboardEvent) => void;
    /** The node's own src, as last painted; not necessarily what the element is showing. */
    private paintedSrc: string | null = null;
    private objectUrl: string | null = null;
    /** Bumped per resolve, so a source replaced mid-flight discards the response still coming. */
    private srcToken = 0;

    constructor(
        node: ProseMirrorNode,
        private readonly getPos: () => number | undefined,
        private readonly editor: Editor,
        private readonly labels: WikiBlockLabels,
        private readonly registry: Set<WikiImageView>,
        private readonly sources: WikiImageSources | null,
    ) {
        this.node = node;
        this.editable = editor.isEditable;

        this.dom = document.createElement('figure');
        this.dom.className = 'wiki-image';
        this.dom.contentEditable = 'false';

        this.frame = document.createElement('div');
        this.frame.className = 'wiki-image-frame';

        this.image = document.createElement('img');
        this.image.addEventListener('click', () => {
            if (!this.editor.isEditable) this.openLightbox();
        });

        this.handle = document.createElement('span');
        this.handle.className = 'wiki-image-handle';
        this.handle.addEventListener('pointerdown', event => this.beginResize(event));

        this.frame.append(this.image, this.handle);

        this.captionInput = document.createElement('input');
        this.captionInput.className = 'wiki-image-caption-input';
        this.captionInput.placeholder = labels.imageCaption;
        this.captionInput.addEventListener('input', () => this.scheduleCaption());
        // Enter in the caption should not split the figure out from under itself.
        this.captionInput.addEventListener('keydown', event => {
            if (event.key === 'Enter') event.preventDefault();
        });

        this.caption = document.createElement('figcaption');
        this.caption.className = 'wiki-image-caption';

        this.dom.append(this.frame, this.captionInput, this.caption);

        this.paint();
        this.registry.add(this);
    }

    update(node: ProseMirrorNode): boolean {
        if (node.type.name !== this.node.type.name) return false;
        this.node = node;
        this.paint();
        return true;
    }

    syncEditable(): void {
        if (this.editor.isEditable === this.editable) return;
        this.editable = this.editor.isEditable;
        if (this.editable) this.closeLightbox();
        this.paint();
    }

    stopEvent(event: Event): boolean {
        const target = event.target as globalThis.Node | null;
        if (!target) return false;
        return this.captionInput.contains(target)
            || this.handle.contains(target)
            || !!this.lightbox?.contains(target);
    }

    ignoreMutation(_mutation: ViewMutationRecord): boolean {
        // A leaf node: everything under here is ours, and none of it is document content.
        return true;
    }

    destroy(): void {
        clearTimeout(this.captionTimer);
        this.closeLightbox();
        this.releaseObjectUrl();
        this.registry.delete(this);
    }

    private paint(): void {
        const attrs = this.node.attrs;
        const src = typeof attrs['src'] === 'string' ? attrs['src'] : '';
        const alt = typeof attrs['alt'] === 'string' ? attrs['alt'] : '';
        const title = typeof attrs['title'] === 'string' ? attrs['title'] : '';
        const width = widthOf(attrs['width']);

        this.applySrc(src);
        this.image.alt = alt;
        if (title) this.image.title = title;
        else this.image.removeAttribute('title');
        this.image.style.width = width ? `${width}px` : '';

        this.dom.setAttribute('data-mode', this.editable ? 'edit' : 'read');
        this.caption.textContent = alt;
        this.dom.setAttribute('data-captioned', String(Boolean(alt)));
        // Never while the field has focus: rewriting the value mid-word would move the caret to the end on every keystroke.
        if (document.activeElement !== this.captionInput && this.captionInput.value !== alt) {
            this.captionInput.value = alt;
        }
    }

    /** Puts src on the element, fetching it first when the browser could not. Compared against the node's own source, not the element's: for a resolved image those are never equal (the element shows an object URL), and comparing them would re-fetch on every repaint, of which a caption keystroke alone produces several. */
    private applySrc(src: string): void {
        if (this.paintedSrc === src) return;
        this.paintedSrc = src;

        const token = ++this.srcToken;
        this.releaseObjectUrl();

        if (!src || !this.sources?.needsAuth(src)) {
            if (this.image.getAttribute('src') !== src) this.image.setAttribute('src', src);
            return;
        }

        // Cleared while the bytes are in flight: leaving the previous picture up would caption the new image with the old one, and an empty string would load the page itself as an image.
        this.image.removeAttribute('src');
        this.sources.fetch(src).then(blob => {
            if (token !== this.srcToken) return;
            this.objectUrl = URL.createObjectURL(blob);
            this.image.setAttribute('src', this.objectUrl);
        }).catch(() => {
            // Left blank rather than broken. Nothing here can retry it usefully.
        });
    }

    private releaseObjectUrl(): void {
        if (!this.objectUrl) return;
        URL.revokeObjectURL(this.objectUrl);
        this.objectUrl = null;
    }

    private scheduleCaption(): void {
        clearTimeout(this.captionTimer);
        // Debounced so a typed caption is one undo step per pause, not one per character.
        this.captionTimer = setTimeout(() => {
            const pos = this.getPos();
            if (pos === undefined) return;
            this.editor.view.dispatch(
                this.editor.state.tr.setNodeAttribute(pos, 'alt', this.captionInput.value),
            );
        }, 400);
    }

    private beginResize(event: PointerEvent): void {
        if (!this.editor.isEditable) return;
        event.preventDefault();
        event.stopPropagation();

        const startX = event.clientX;
        const startWidth = this.image.getBoundingClientRect().width;
        const maxWidth = this.dom.getBoundingClientRect().width || startWidth;
        this.handle.setPointerCapture(event.pointerId);
        this.dom.setAttribute('data-resizing', 'true');

        let width = startWidth;
        const move = (moveEvent: PointerEvent) => {
            width = Math.min(Math.max(startWidth + (moveEvent.clientX - startX), MIN_WIDTH), maxWidth);
            this.image.style.width = `${Math.round(width)}px`;
        };
        const finish = () => {
            this.handle.removeEventListener('pointermove', move);
            this.handle.removeEventListener('pointerup', finish);
            this.handle.removeEventListener('pointercancel', finish);
            this.dom.removeAttribute('data-resizing');
            const pos = this.getPos();
            if (pos === undefined) return;
            // Committed once, at the end: a transaction per mouse move would bury the undo stack.
            this.editor.view.dispatch(
                this.editor.state.tr.setNodeAttribute(pos, 'width', Math.round(width)),
            );
        };
        this.handle.addEventListener('pointermove', move);
        this.handle.addEventListener('pointerup', finish);
        this.handle.addEventListener('pointercancel', finish);
    }

    /** Mounted inside the node view rather than on document.body, so the component stylesheet (which can only reach into the editor subtree) still applies to it. */
    private openLightbox(): void {
        if (this.lightbox) return;
        const overlay = document.createElement('div');
        overlay.className = 'wiki-image-lightbox';
        overlay.setAttribute('role', 'dialog');

        const large = document.createElement('img');
        large.src = this.image.currentSrc || this.image.src;
        large.alt = this.image.alt;

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'wiki-image-lightbox-close';
        close.title = this.labels.imageClose;
        close.setAttribute('aria-label', this.labels.imageClose);
        const icon = document.createElement('i');
        icon.className = 'pi pi-times';
        close.appendChild(icon);

        overlay.append(large, close);
        overlay.addEventListener('click', () => this.closeLightbox());

        this.escapeHandler = (event: KeyboardEvent) => {
            if (event.key === 'Escape') this.closeLightbox();
        };
        document.addEventListener('keydown', this.escapeHandler);

        this.lightbox = overlay;
        this.dom.appendChild(overlay);
    }

    private closeLightbox(): void {
        if (this.escapeHandler) document.removeEventListener('keydown', this.escapeHandler);
        this.escapeHandler = undefined;
        this.lightbox?.remove();
        this.lightbox = undefined;
    }
}

const WikiImageExtension = Image.extend<WikiImageOptions, WikiImageStorage>({
    addOptions() {
        return {
            ...this.parent?.(),
            labels: DEFAULT_WIKI_BLOCK_LABELS,
            sources: null,
        } as WikiImageOptions;
    },

    addStorage() {
        return {views: new Set<WikiImageView>()};
    },

    addAttributes() {
        return {
            ...this.parent?.(),
            width: {
                default: null,
                parseHTML: element => widthOf(element.getAttribute('width')),
                renderHTML: attributes => {
                    const width = widthOf(attributes['width']);
                    return width ? {width: String(width)} : {};
                },
            },
        };
    },

    addNodeView() {
        const labels = this.options.labels;
        const sources = this.options.sources;
        const registry = this.storage.views;
        const editor = this.editor;
        return ({node, getPos}) =>
            new WikiImageView(node, getPos, editor, labels, registry, sources);
    },

    addProseMirrorPlugins() {
        const registry = this.storage.views;
        return [
            ...(this.parent?.() ?? []),
            new Plugin({
                key: new PluginKey('wikiImageEditable'),
                // The one hook that fires when `setEditable` flips read and edit apart.
                view: () => ({update: () => registry.forEach(view => view.syncEditable())}),
            }),
        ];
    },

    renderMarkdown: node => {
        const src = typeof node.attrs?.['src'] === 'string' ? node.attrs['src'] : '';
        const alt = typeof node.attrs?.['alt'] === 'string' ? node.attrs['alt'] : '';
        const title = typeof node.attrs?.['title'] === 'string' ? node.attrs['title'] : '';
        const width = widthOf(node.attrs?.['width']);

        if (width) {
            const titleAttribute = title ? ` title="${escapeAttribute(title)}"` : '';
            return `<img src="${escapeAttribute(src)}" alt="${escapeAttribute(alt)}"${titleAttribute} width="${width}">`;
        }
        return title ? `![${alt}](${src} "${title}")` : `![${alt}](${src})`;
    },
});

/** Configured once, at editor construction, because the labels are resolved translations. */
export function wikiImage(labels: WikiBlockLabels, sources: WikiImageSources | null = null) {
    return WikiImageExtension.configure({inline: false, allowBase64: false, labels, sources});
}
