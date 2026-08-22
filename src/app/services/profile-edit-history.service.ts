import {computed, Injectable, signal} from '@angular/core';
import {CanvasWidgetDto} from '../dtos/response/profile-canvas.dto';
import {ProfileFont} from '../dtos/response/profile.dto';

export type TextHistoryKind = 'bio' | 'accentColor' | 'font';
export type CanvasHistoryKind = 'add' | 'remove' | 'move' | 'resize' | 'visibility' | 'card' | 'config';

export interface TextHistoryEntry {
    domain: 'text';
    kind: TextHistoryKind;
    before: string | ProfileFont;
    after: string | ProfileFont;
}

export interface CanvasHistoryEntry {
    domain: 'canvas';
    kind: CanvasHistoryKind;
    widgetType: string;
    before: CanvasWidgetDto[];
    after: CanvasWidgetDto[];
}

export type ProfileHistoryEntry = TextHistoryEntry | CanvasHistoryEntry;

/** A canvas entry carries two widget-array snapshots, so this stays generous rather than tight;
 * 50 steps back covers any realistic run of mistakes without an unbounded stack on a long session. */
export const PROFILE_HISTORY_DEPTH = 50;

interface TextFieldValues {
    bio: string;
    accentColor: string;
    font: ProfileFont;
}

const TEXT_KINDS: readonly TextHistoryKind[] = ['bio', 'accentColor', 'font'];

/**
 * One undo/redo stack for the whole editable profile: canvas arrangement, widget config, bio,
 * accent and font. `CanvasEditorService` pushes a canvas entry as it mutates; `ProfilePageComponent`
 * pushes a text entry once a pause commits it. Applying an entry back onto the drafts is the
 * caller's job; this only tracks what happened.
 */
@Injectable({providedIn: 'root'})
export class ProfileEditHistoryService {
    private readonly undoStack = signal<ProfileHistoryEntry[]>([]);
    private readonly redoStack = signal<ProfileHistoryEntry[]>([]);
    private readonly pendingText = new Map<TextHistoryKind, string | ProfileFont>();

    readonly canUndo = computed(() => this.undoStack().length > 0);
    readonly canRedo = computed(() => this.redoStack().length > 0);
    readonly nextUndo = computed<ProfileHistoryEntry | null>(() => this.undoStack().at(-1) ?? null);
    readonly nextRedo = computed<ProfileHistoryEntry | null>(() => this.redoStack().at(-1) ?? null);

    /** Undo does not survive leaving the page or switching to a different profile. */
    reset(): void {
        this.undoStack.set([]);
        this.redoStack.set([]);
        this.pendingText.clear();
    }

    /** Captures the value a field held before the first edit in the current pause. A later call
     * for the same field before the pause commits is a no-op: the burst's start is what matters. */
    noteTextField(kind: TextHistoryKind, before: string | ProfileFont): void {
        if (!this.pendingText.has(kind)) this.pendingText.set(kind, before);
    }

    /** Closes the current pause: one entry per field that actually changed since its `noteTextField`. */
    commitText(current: TextFieldValues): void {
        for (const kind of TEXT_KINDS) {
            const before = this.pendingText.get(kind);
            if (before !== undefined) this.pushText(kind, before, current[kind]);
        }
        this.pendingText.clear();
    }

    pushCanvas(
        kind: CanvasHistoryKind,
        widgetType: string,
        before: CanvasWidgetDto[],
        after: CanvasWidgetDto[],
    ): void {
        this.push({domain: 'canvas', kind, widgetType, before, after});
    }

    /** Pops the top undo entry onto the redo stack and hands it back for the caller to apply. */
    undo(): ProfileHistoryEntry | null {
        const stack = this.undoStack();
        const entry = stack.at(-1);
        if (!entry) return null;
        this.undoStack.set(stack.slice(0, -1));
        this.redoStack.update(r => [...r, entry].slice(-PROFILE_HISTORY_DEPTH));
        return entry;
    }

    redo(): ProfileHistoryEntry | null {
        const stack = this.redoStack();
        const entry = stack.at(-1);
        if (!entry) return null;
        this.redoStack.set(stack.slice(0, -1));
        this.undoStack.update(u => [...u, entry].slice(-PROFILE_HISTORY_DEPTH));
        return entry;
    }

    private pushText(kind: TextHistoryKind, before: string | ProfileFont, after: string | ProfileFont): void {
        if (before === after) return;
        this.push({domain: 'text', kind, before, after});
    }

    private push(entry: ProfileHistoryEntry): void {
        this.undoStack.update(stack => [...stack, entry].slice(-PROFILE_HISTORY_DEPTH));
        this.redoStack.set([]);
    }
}
