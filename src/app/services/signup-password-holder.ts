import {inject, Injectable} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {NavigationEnd, Router} from '@angular/router';
import {filter} from 'rxjs';

/**
 * Carries a brand-new account's sign-up password to first launch so master-key setup can run
 * without asking again. In memory for that one launch only: never a signal, never persisted.
 */
@Injectable({providedIn: 'root'})
export class SignupPasswordHolder {
    private readonly router = inject(Router);
    private password: string | null = null;

    constructor() {
        this.router.events
            .pipe(
                filter((e): e is NavigationEnd => e instanceof NavigationEnd),
                takeUntilDestroyed(),
            )
            .subscribe(e => {
                if (e.urlAfterRedirects.startsWith('/authentication')) this.password = null;
            });
    }

    set(password: string): void {
        this.password = password;
    }

    has(): boolean {
        return this.password !== null;
    }

    take(): string | null {
        const password = this.password;
        this.password = null;
        return password;
    }
}
