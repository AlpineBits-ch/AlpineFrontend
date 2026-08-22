import {ChangeDetectionStrategy, Component, computed, input, output} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {TranslateModule} from '@ngx-translate/core';
import {Select} from 'primeng/select';
import {FONT_OPTIONS, FONT_STACKS, safeAccentColor} from '../../../models/profile-font.model';
import {ProfileFont} from '../../../dtos/response/profile.dto';

/** Accent colour and font, moved wholesale from the masthead. Purely controlled. */
@Component({
    selector: 'app-profile-appearance-bar',
    imports: [FormsModule, Select, TranslateModule],
    templateUrl: './profile-appearance-bar.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProfileAppearanceBarComponent {
    readonly accentColor = input.required<string>();
    readonly font = input.required<ProfileFont>();

    readonly accentColorChanged = output<string>();
    readonly fontChanged = output<ProfileFont>();

    protected readonly accentSwatchColor = computed(() => safeAccentColor(this.accentColor()) || 'transparent');

    protected readonly fontPreviewStack = computed(() => {
        const font = this.font();
        return font !== ProfileFont.Default ? FONT_STACKS[font] : null;
    });

    protected get fontOptions(): {value: ProfileFont; label: string}[] {
        return FONT_OPTIONS;
    }

    protected get fontStacks(): Record<ProfileFont, string> {
        return FONT_STACKS;
    }
}
