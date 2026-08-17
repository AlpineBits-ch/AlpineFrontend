import {ChangeDetectionStrategy, Component, inject, OnDestroy, signal} from '@angular/core';
import {NgClass} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {Select} from 'primeng/select';
import {TranslateModule} from '@ngx-translate/core';
import {KeybindsService} from '../../../../../services/keybinds.service';
import {
    findKeybindAction,
    KEYBIND_ACTIONS,
    KeybindActionDef,
    KeybindActionId,
} from '../../../../../models/keybind-action.model';
import {PlatformCapabilities} from '../../../../../platform/capabilities';

interface KeybindGroup {
    category: string;
    actions: readonly KeybindActionDef[];
}

/**
 * Discord-style keybinds page: each category lists its already-assigned
 * bindings (action left, key right), plus an "Add a Keybind" row that opens
 * an action dropdown + key capture + save/cancel. Purely a view over
 * {@link KeybindsService} - every action it can offer comes from
 * `keybind-action.model.ts`, so a new bindable action anywhere in the app
 * shows up here for free.
 */
@Component({
    selector: 'app-keybinds-settings',
    imports: [NgClass, FormsModule, Select, TranslateModule],
    templateUrl: './keybinds-settings.component.html',
    styleUrl: './keybinds-settings.component.css',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class KeybindsSettingsComponent implements OnDestroy {
    protected readonly keybinds = inject(KeybindsService);

    /** Read for `globalHotkeys`, which decides whether a binding on this page means what it says. */
    protected readonly capabilities = inject(PlatformCapabilities);

    protected readonly groups: KeybindGroup[] = groupByCategory(KEYBIND_ACTIONS);

    /** Which existing row is being re-bound, if any. */
    protected readonly editingId = signal<KeybindActionId | null>(null);
    /** Which category's "add a keybind" row is open, if any. */
    protected readonly addingCategory = signal<string | null>(null);
    /** Action selected in the open add-row's dropdown. */
    protected readonly draftActionId = signal<KeybindActionId | null>(null);

    /** Resolved display labels per action, refreshed whenever a binding changes. */
    private readonly labels = signal<Partial<Record<KeybindActionId, string>>>({});
    /** Binding a row had when edit mode opened, restored if the user cancels. */
    private editOriginalToken: string | null = null;

    constructor() {
        void this.refreshLabels();
        this.keybinds.rebind$.subscribe(() => void this.refreshLabels());
    }

    // ── Read state ────────────────────────────────────────────────────────────

    protected labelFor(id: KeybindActionId): string {
        return this.labels()[id] ?? '…';
    }

    protected isCapturing(id: KeybindActionId): boolean {
        return this.keybinds.capturingAction() === id;
    }

    protected isBound(id: KeybindActionId): boolean {
        return this.keybinds.getBinding(id) !== null;
    }

    /** Already-assigned actions in a category, excluding one mid-way through the add flow. */
    protected assignedIn(category: string): KeybindActionDef[] {
        const excludeId = this.addingCategory() === category ? this.draftActionId() : null;
        return KEYBIND_ACTIONS.filter(
            a => a.category === category && this.isBound(a.id) && a.id !== excludeId,
        );
    }

    protected unassignedIn(category: string): KeybindActionDef[] {
        return KEYBIND_ACTIONS.filter(a => a.category === category && !this.isBound(a.id));
    }

    /** Add-row dropdown options: unassigned actions, plus the current draft even once it gets bound. */
    protected addOptionsFor(category: string): KeybindActionDef[] {
        const unassigned = this.unassignedIn(category);
        const draft = this.draftActionId();
        if (draft && !unassigned.some(a => a.id === draft)) {
            return [findKeybindAction(draft), ...unassigned];
        }
        return unassigned;
    }

    // ── Capture ───────────────────────────────────────────────────────────────

    protected capture(id: KeybindActionId): void {
        this.keybinds.startCapture(id);
    }

    // ── Add flow ──────────────────────────────────────────────────────────────

    protected startAdd(category: string): void {
        this.addingCategory.set(category);
        this.draftActionId.set(this.unassignedIn(category)[0]?.id ?? null);
    }

    protected onDraftActionChange(newId: KeybindActionId): void {
        const prev = this.draftActionId();
        if (prev && prev !== newId && this.isBound(prev)) {
            this.keybinds.clearBinding(prev); // abandon whatever was captured for the old choice
        }
        this.draftActionId.set(newId);
    }

    protected confirmAdd(): void {
        this.addingCategory.set(null);
        this.draftActionId.set(null);
    }

    protected cancelAdd(): void {
        this.keybinds.cancelCapture();
        const id = this.draftActionId();
        if (id && this.isBound(id)) this.keybinds.clearBinding(id);
        this.addingCategory.set(null);
        this.draftActionId.set(null);
    }

    // ── Edit flow ─────────────────────────────────────────────────────────────

    protected startEdit(id: KeybindActionId): void {
        this.editOriginalToken = this.keybinds.getBinding(id);
        this.editingId.set(id);
    }

    protected confirmEdit(): void {
        this.editingId.set(null);
    }

    protected cancelEdit(): void {
        const id = this.editingId();
        this.keybinds.cancelCapture();
        if (id) this.keybinds.setBinding(id, this.editOriginalToken);
        this.editingId.set(null);
    }

    protected remove(id: KeybindActionId, event: MouseEvent): void {
        event.stopPropagation();
        this.keybinds.clearBinding(id);
    }

    ngOnDestroy(): void {
        this.keybinds.cancelCapture();
    }

    private async refreshLabels(): Promise<void> {
        const entries = await Promise.all(
            KEYBIND_ACTIONS.map(async a => [a.id, await this.keybinds.labelFor(a.id)] as const),
        );
        this.labels.set(Object.fromEntries(entries));
    }
}

function groupByCategory(actions: readonly KeybindActionDef[]): KeybindGroup[] {
    const groups: KeybindGroup[] = [];
    for (const action of actions) {
        let group = groups.find(g => g.category === action.category);
        if (!group) {
            group = {category: action.category, actions: []};
            groups.push(group);
        }
        (group.actions as KeybindActionDef[]).push(action);
    }
    return groups;
}
