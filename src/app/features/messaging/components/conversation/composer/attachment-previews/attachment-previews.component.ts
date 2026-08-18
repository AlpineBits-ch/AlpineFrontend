import {ChangeDetectionStrategy, Component, input, output} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {AttachedFile} from '../composer-attachments.service';

@Component({
    selector: 'app-attachment-previews',
    imports: [TranslateModule],
    templateUrl: './attachment-previews.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AttachmentPreviewsComponent {
    readonly files = input.required<AttachedFile[]>();
    /** Ids already placed in the body, so those tiles offer taking it out instead of putting it in. */
    readonly inlineIds = input<string[]>([]);
    remove = output<number>();
    placeInline = output<number>();
    removeInline = output<string>();
}
