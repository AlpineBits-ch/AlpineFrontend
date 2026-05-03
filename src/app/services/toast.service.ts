import { inject, Injectable } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { MessageService } from 'primeng/api';

export interface ToastOptions {
  detail?: string;
  life?: number;
  sticky?: boolean;
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  private messageService = inject(MessageService);

  // When i18n is added, translate `summary` and `detail` here before passing to MessageService
  success(summary: string, options: ToastOptions = {}): void {
    this.messageService.add({ severity: 'success', summary, ...options });
  }

  error(summary: string, options: ToastOptions = {}): void {
    this.messageService.add({ severity: 'error', summary, ...options });
  }

  info(summary: string, options: ToastOptions = {}): void {
    this.messageService.add({ severity: 'info', summary, ...options });
  }

  warn(summary: string, options: ToastOptions = {}): void {
    this.messageService.add({ severity: 'warn', summary, ...options });
  }

  httpError(summary: string, err?: unknown, options: ToastOptions = {}): void {
    const status = err instanceof HttpErrorResponse && err.status ? ` [${err.status}]` : '';
    this.messageService.add({ severity: 'error', summary: summary + status, ...options });
  }
}
