import {Component, computed, inject, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {NgClass} from '@angular/common';
import {Button} from 'primeng/button';
import {ThemeService} from '../../../../../services/theme.service';
import {COLOR_GROUPS, COLOR_LABELS, ThemeColors} from '../../../../../models/theme.model';

@Component({
    selector: 'app-appearance-settings',
    imports: [FormsModule, NgClass, Button],
    templateUrl: './appearance-settings.component.html',
    styleUrl: './appearance-settings.component.css',
})
export class AppearanceSettingsComponent {
    readonly themeService = inject(ThemeService);

    readonly colorGroups = COLOR_GROUPS;
    readonly colorLabels = COLOR_LABELS as Record<string, string>;

    readonly isBuiltIn = computed(() => this.themeService.activeThemeId() === 'alpine-dark');

    // New-theme creation form
    readonly showNewForm = signal(false);
    readonly newThemeName = signal('');

    // Confirm-delete state
    readonly confirmDeleteId = signal<string | null>(null);

    // Import file input ref handled via template ref + click()
    readonly importError = signal<string | null>(null);

    get fontSizeValue(): number {
        return this.themeService.activeTheme().baseFontSize;
    }

    onFontSizeChange(value: string | number): void {
        this.themeService.updateActiveFontSize(+value);
    }

    onColorChange(key: keyof ThemeColors, value: string): void {
        this.themeService.updateActiveColors({[key]: value});
    }

    createTheme(): void {
        const name = this.newThemeName().trim();
        if (!name) return;
        this.themeService.createTheme(name);
        this.newThemeName.set('');
        this.showNewForm.set(false);
    }

    cancelNew(): void {
        this.newThemeName.set('');
        this.showNewForm.set(false);
    }

    requestDelete(id: string): void {
        this.confirmDeleteId.set(id);
    }

    confirmDelete(): void {
        const id = this.confirmDeleteId();
        if (id) this.themeService.deleteTheme(id);
        this.confirmDeleteId.set(null);
    }

    cancelDelete(): void {
        this.confirmDeleteId.set(null);
    }

    onImportFile(event: Event): void {
        this.importError.set(null);
        const file = (event.target as HTMLInputElement).files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = e => {
            try {
                this.themeService.importTheme(e.target!.result as string);
            } catch {
                this.importError.set('Invalid theme file. Please export a theme from Alpine first.');
            }
        };
        reader.readAsText(file);
        // Reset so the same file can be re-imported after deletion
        (event.target as HTMLInputElement).value = '';
    }
}
