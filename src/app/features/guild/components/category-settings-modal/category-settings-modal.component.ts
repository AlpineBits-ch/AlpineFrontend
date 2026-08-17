import {Component, inject, model, output, signal} from '@angular/core';
import {NgClass} from '@angular/common';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {CategoryDto, GuildDto} from '../../../../dtos/response/guild.dto';
import {CategoryOverviewComponent} from './pages/category-overview/category-overview.component';
import {CategoryPermissionsComponent} from './pages/category-permissions/category-permissions.component';
import {GuildService} from '../../../../services/guild.service';
import {PrimeTemplate} from 'primeng/api';
import {TranslateModule} from '@ngx-translate/core';

interface NavItem {
    id: string;
    label: string;
    icon: string;
}

@Component({
    selector: 'app-category-settings-modal',
    imports: [
        NgClass,
        Dialog,
        Button,
        CategoryOverviewComponent,
        CategoryPermissionsComponent,
        PrimeTemplate,
        TranslateModule,
    ],
    templateUrl: './category-settings-modal.component.html',
})
export class CategorySettingsModalComponent {
    readonly isVisible = model.required<boolean>();

    readonly category = signal<CategoryDto | null>(null);
    readonly guild = signal<GuildDto | null>(null);

    categoryUpdated = output<CategoryDto>();
    categoryDeleted = output<string>();
    readonly activePage = signal('overview');
    readonly deleting = signal(false);
    readonly confirmDelete = signal(false);
    navItems: NavItem[] = [
        {id: 'overview', label: 'Overview', icon: 'pi pi-folder'},
        {id: 'permissions', label: 'Permissions', icon: 'pi pi-lock'},
    ];
    private guildService = inject(GuildService);

    open(category: CategoryDto, guild: GuildDto): void {
        this.category.set(category);
        this.guild.set(guild);
        this.activePage.set('overview');
        this.isVisible.set(true);
    }

    navItemClasses(id: string): Record<string, boolean> {
        const active = this.activePage() === id;
        return {
            'bg-[color-mix(in_srgb,var(--color-brand)_15%,transparent)]': active,
            'text-[var(--color-brand-dim)]': active,
            'text-white/50': !active,
        };
    }

    currentLabel(): string {
        return this.navItems.find(i => i.id === this.activePage())?.label ?? '';
    }

    onCategoryUpdated(c: CategoryDto): void {
        this.category.set(c);
        this.categoryUpdated.emit(c);
    }

    deleteCategory(): void {
        const cat = this.category();
        if (!cat || this.deleting()) return;
        this.deleting.set(true);
        this.guildService.deleteCategory(cat.id).subscribe({
            next: () => {
                this.categoryDeleted.emit(cat.id);
                this.isVisible.set(false);
                this.confirmDelete.set(false);
                this.deleting.set(false);
            },
            error: () => this.deleting.set(false),
        });
    }
}
