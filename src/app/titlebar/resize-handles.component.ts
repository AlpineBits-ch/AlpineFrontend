import { Component, OnInit, signal } from '@angular/core';
type ResizeDirection = 'East' | 'North' | 'NorthEast' | 'NorthWest' | 'South' | 'SouthEast' | 'SouthWest' | 'West';

// The titlebar (32px) occupies the full top edge and its corners,
// so top/nw/ne handles are omitted — they would block drag and window controls.
@Component({
  selector: 'app-resize-handles',
  template: `
    @if (isTauri()) {
      <div class="s"  (mousedown)="resize('South')"></div>
      <div class="e"  (mousedown)="resize('East')"></div>
      <div class="w"  (mousedown)="resize('West')"></div>
      <div class="sw" (mousedown)="resize('SouthWest')"></div>
      <div class="se" (mousedown)="resize('SouthEast')"></div>
    }
  `,
  styles: [`
    :host { pointer-events: none; }
    div {
      position: fixed;
      z-index: 9999;
      pointer-events: all;
    }
    /* Sides start below the 32px titlebar */
    .e  { right: 0;  top: 36px; bottom: 12px; width:  5px; cursor: e-resize; }
    .w  { left: 0;   top: 36px; bottom: 12px; width:  5px; cursor: w-resize; }
    /* Bottom edge and corners are free of titlebar */
    .s  { bottom: 0; left: 12px; right: 12px; height: 5px; cursor: s-resize; }
    .sw { bottom: 0; left: 0;   width: 12px; height: 12px; cursor: sw-resize; }
    .se { bottom: 0; right: 0;  width: 12px; height: 12px; cursor: se-resize; }
  `]
})
export class ResizeHandlesComponent implements OnInit {
  protected isTauri = signal(false);

  ngOnInit(): void {
    this.isTauri.set('__TAURI_INTERNALS__' in window);
  }

  protected async resize(direction: ResizeDirection): Promise<void> {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().startResizeDragging(direction);
  }
}
