import {Component, inject, signal} from '@angular/core';
import {DatePicker} from "primeng/datepicker";
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


interface LoginModel {
  username: string;
  password: string;
}

interface RegisterModel {
  email: string;
  password: string;
  birthdate: Date;
  username: string;
}
@Component({
  selector: 'app-login',
    imports: [
        DatePicker,
        InputText,
        PasswordDirective,
        Button,
        FormField,
        NgClass
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

  protected loginModel = signal<LoginModel>({username: '', password: ''});
  protected registerModel = signal<RegisterModel>({username: '',email: '', password: '', birthdate: new Date()});

  protected loginForm = form(this.loginModel);
  protected registerForm = form(this.registerModel);

  constructor() {
    this.authService.isLoggedIn().then(r => {
      if(r){
        this.router.navigate(['/overview']);

      }

    });

  }


  protected login(): void {
    this.authService.login(
        this.loginModel().username,
        this.loginModel().password
    ).pipe(
        tap(() => {
          this.userSettings.load();
          this.router.navigate(['/overview']);
        }),
        catchError(() => {
          this.toast.error('Sign in failed', { detail: 'Invalid username or password.' });
          return EMPTY;
        })
    ).subscribe();
  }

  protected register(): void {
    this.authService.register(
        this.registerModel().email,
        this.registerModel().username,
        this.registerModel().password,
        this.registerModel().birthdate
    ).pipe(
        tap(() => {
          this.toast.success('Account created!', { detail: 'Welcome to Alpine. You can now sign in.' });
          this.isLoginMode.set(true);
        }),
        catchError(() => {
          this.toast.error('Registration failed', { detail: 'Please check your details and try again.' });
          return EMPTY;
        })
    ).subscribe();
  }

}
