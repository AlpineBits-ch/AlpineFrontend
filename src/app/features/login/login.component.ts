import {Component, inject, signal} from '@angular/core';
import {DatePicker} from "primeng/datepicker";
import {InputText} from "primeng/inputtext";
import {PasswordDirective} from "primeng/password";
import {Button} from "primeng/button";
import {AuthService} from "../../services/auth.service";
import {catchError, Observable, tap, throwError} from "rxjs";
import {form, FormField} from "@angular/forms/signals";
import {TokenResponse} from "angular-oauth2-oidc";
import {Router} from "@angular/router";
import {NgClass} from "@angular/common";
import {UserSettingsService} from "../../services/user-settings.service";


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


  protected login(): Observable<TokenResponse> {
    // 1. Call the service (which now returns an Observable)
    return this.authService.login(
        this.loginModel().username,
        this.loginModel().password
    ).pipe(
        tap((data) => {
          console.log('Login successful:', data);
          this.userSettings.load();
          this.router.navigate(['/overview']);
        }),
        catchError((err) => {
          console.error('Login error in component:', err);
          return throwError(() => err);
        })
    );
  }
  protected register(){
    this.authService.register(this.registerModel().email, this.registerModel().username, this.registerModel().password, this.registerModel().birthdate).pipe(tap(d => {
      console.log(d);
    })).subscribe();
  }

}
