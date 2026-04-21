import {inject, Injectable} from '@angular/core';
import {HttpClient} from "@angular/common/http";
import {Observable} from "rxjs";
import {environment} from "../../environments/environment";

@Injectable({
  providedIn: 'root',
})
export class AuthService {
  private http = inject(HttpClient);

  public register(email:string, password:string, birthdate: Date): Observable<unknown>{
    return this.http.post(`${environment.apiUrl}/api/v1/authentication/register`, {email, password, birthdate});
  }
  public login(email:string, password:string): Observable<unknown>{
    return this.http.post(`${environment.apiUrl}/api/v1/authentication/login`, {email, password});
  }
}
