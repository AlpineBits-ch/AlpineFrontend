import {Component, inject, signal} from '@angular/core';
import {InputText} from "primeng/inputtext";
import {PasswordDirective} from "primeng/password";
import {Button} from "primeng/button";
import {AuthService} from "../../services/auth.service";
import {catchError, EMPTY, tap} from "rxjs";
import {form, FormField} from "@angular/forms/signals";
import {Router} from "@angular/router";
import {NgClass} from "@angular/common";
import {UserSettingsService} from "../../services/user-settings.service";
import {ToastService} from "../../services/toast.service";
import { TranslateModule } from '@ngx-translate/core';
import { EmailVerificationService } from '../../services/email-verification.service';


interface LoginModel {
  email: string;
  password: string;
}

interface RegisterModel {
  email: string;
  password: string;
  confirmPassword: string;
  birthdate: string;
  username: string;
}
@Component({
  selector: 'app-login',
    imports: [
        InputText,
        PasswordDirective,
        Button,
        FormField,
        NgClass,
        TranslateModule
    ],
  templateUrl: './login.component.html',
  styleUrl: './login.component.css',
})
export class Login {
  protected isLoginMode = signal(true);
  protected authService = inject(AuthService);
  protected router = inject(Router);
  private userSettings = inject(UserSettingsService);
  private toast = inject(ToastService);
  private emailVerification = inject(EmailVerificationService);

  protected loginModel = signal<LoginModel>({email: '', password: ''});
  protected registerModel = signal<RegisterModel>({username: '', email: '', password: '', confirmPassword: '', birthdate: ''});
  protected passwordMismatch = signal(false);

  protected loginForm = form(this.loginModel);
  protected registerForm = form(this.registerModel);

  constructor() {
    this.authService.isLoggedIn().then(r => {
      if(r){
        this.router.navigate(['/overview']);
      }
    });
  }

  protected switchToMode(loginMode: boolean): void {
    this.isLoginMode.set(loginMode);
    void this.resizeForMode(loginMode);
  }

  private async resizeForMode(isLogin: boolean): Promise<void> {
    try {
      if (!('__TAURI_INTERNALS__' in window)) return;
      const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      const { LogicalSize } = await import('@tauri-apps/api/dpi');
      await getCurrentWebviewWindow().setSize(new LogicalSize(460, isLogin ? 540 : 700));
    } catch {}
  }

  protected login(): void {
    this.authService.login(
        this.loginModel().email,
        this.loginModel().password
    ).pipe(
        tap(async () => {
          this.userSettings.load();
          await this.openMainApp();
        }),
        catchError((err) => {
          const status = err?.status ?? err?.reason?.status;
          if (status === 403) {
            const { email, password } = this.loginModel();
            this.emailVerification.show(email, 'none', { email, password });
            return EMPTY;
          }
          this.toast.httpError('Sign in failed', err, { detail: 'Invalid username or password.' });
          return EMPTY;
        })
    ).subscribe();
  }

  private async openMainApp(): Promise<void> {
    if (!('__TAURI_INTERNALS__' in window)) {
      this.router.navigate(['/overview']);
      return;
    }
    try {
      const { getCurrentWebviewWindow, WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      const loginWin = getCurrentWebviewWindow();

      // If we're somehow running in the main window already, just navigate
      if (loginWin.label !== 'login') {
        this.router.navigate(['/overview']);
        return;
      }

      // Create the full-size main app window (main.ts will show it after Angular bootstraps)
      new WebviewWindow('echo', {
        title: 'Echo',
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        decorations: false,
        shadow: true,
        visible: false,
        center: true,
        resizable: true,
        maximizable: true,
        minimizable: true,
      });

      // Close login window once the main window signals it's ready
      const { once } = await import('@tauri-apps/api/event');
      await once('main-window-ready', async () => {
        try { await loginWin.close(); } catch {}
      });

      // Safety net: close after 10s regardless
      setTimeout(async () => {
        try { await loginWin.close(); } catch {}
      }, 10000);
    } catch {
      this.router.navigate(['/overview']);
    }
  }

  private parseBirthdate(dateStr: string): Date {
    const [day, month, year] = dateStr.split('.').map(Number);
    return new Date(year, month - 1, day);
  }

  protected register(): void {
    const model = this.registerModel();
    if (model.password !== model.confirmPassword) {
      this.passwordMismatch.set(true);
      return;
    }
    this.passwordMismatch.set(false);
    this.authService.register(
        this.registerModel().email,
        this.registerModel().username,
        this.registerModel().password,
        this.parseBirthdate(this.registerModel().birthdate)
    ).pipe(
        tap(() => {
          this.toast.success('Account created!', { detail: 'Welcome to Alpine. You can now sign in.' });
          this.switchToMode(true);
        }),
        catchError((err) => {
          this.toast.httpError('Registration failed', err, { detail: 'Please check your details and try again.' });
          return EMPTY;
        })
    ).subscribe();
  }

}
