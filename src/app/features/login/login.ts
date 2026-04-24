import {Component, inject, signal} from '@angular/core';
import { createClient } from '@workos-inc/authkit-js';
import {Card} from "primeng/card";
import {DatePicker} from "primeng/datepicker";
import {InputText} from "primeng/inputtext";
import {PasswordDirective} from "primeng/password";
import {Button} from "primeng/button";
import {AuthService} from "../../services/auth.service";
import {emit} from "@tauri-apps/api/event";
import {catchError, Observable, tap, throwError} from "rxjs";
import {form, FormField} from "@angular/forms/signals";
import {TokenResponse} from "angular-oauth2-oidc";
import {Router} from "@angular/router";


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
    Card,
    DatePicker,
    InputText,
    PasswordDirective,
    Button,
    FormField
  ],
  templateUrl: './login.html',
  styleUrl: './login.css',
})
export class Login {
  protected isLoginMode = signal(false);
  protected authService = inject(AuthService);
  protected router = inject(Router);

  protected loginModel = signal<LoginModel>({username: '', password: ''});
  protected registerModel = signal<RegisterModel>({username: '',email: '', password: '', birthdate: new Date()});

  protected loginForm = form(this.loginModel);
  protected registerForm = form(this.registerModel);

  constructor() {
    if(this.authService.isLoggedIn()){
      this.router.navigate(['/overview']);
    }
  }


  protected login(): Observable<TokenResponse> {
    // 1. Call the service (which now returns an Observable)
    return this.authService.login(
        this.loginModel().username,
        this.loginModel().password
    ).pipe(
        // 2. Use tap for side effects like logging
        tap((data) => {
          console.log('Login successful:', data);
          this.router.navigate(['/overview']);
        }),
        // 3. Optional: handle specific local errors
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
