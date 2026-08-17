import {Component, input, output} from '@angular/core';
import {AttachedFile} from '../composer-attachments.service';

@Component({
    selector: 'app-attachment-previews',
    templateUrl: './attachment-previews.component.html',
})
export class AttachmentPreviewsComponent {
    readonly files = input.required<AttachedFile[]>();
    remove = output<number>();
}
