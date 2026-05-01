import { Component, inject } from '@angular/core';
import { Dialog } from 'primeng/dialog';
import { Button } from 'primeng/button';
import { UpdateService } from '../../services/update.service';

@Component({
  selector: 'app-update-dialog',
  imports: [Dialog, Button],
  templateUrl: './update-dialog.component.html',
})
export class UpdateDialogComponent {
  protected readonly updateService = inject(UpdateService);

  protected formatBytes(bytes: number): string {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
