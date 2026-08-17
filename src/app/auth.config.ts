import {AuthConfig} from 'angular-oauth2-oidc';
import {environment} from '../environments/environment';

export const authConfig: AuthConfig = {
    issuer: 'https://api.venta.gg',
    tokenEndpoint: `${environment.apiUrl}/connect/token`,
    clientId: 'echo',
    scope: 'openid offline_access',
    dummyClientSecret: '',
    oidc: false,
    disablePKCE: true,
    useSilentRefresh: false,
};
