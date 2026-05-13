import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class GuildUiActionsService {
  private _openCreateChannel  = new Subject<void>();
  private _openCreateCategory = new Subject<void>();

  readonly openCreateChannel$  = this._openCreateChannel.asObservable();
  readonly openCreateCategory$ = this._openCreateCategory.asObservable();

  requestCreateChannel(): void  { this._openCreateChannel.next();  }
  requestCreateCategory(): void { this._openCreateCategory.next(); }
}
