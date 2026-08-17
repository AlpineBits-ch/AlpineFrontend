# `ghcr.io/alpinebits-ch/venta-client-web`

The Venta web client: the Angular app and the WebAssembly crypto engine, served by nginx. Built and
published by [`.github/workflows/web-client-image.yml`](../../.github/workflows/web-client-image.yml).

```
docker run -p 8080:80 ghcr.io/alpinebits-ch/venta-client-web:latest
```

That serves the official client, pointed at `https://api.venta.gg`. Read on only if you are running
your own Venta server.

## Pointing the client at your own server

```
docker run -p 8080:80 \
  -e VENTA_API_HOSTS=https://chat.example.org \
  ghcr.io/alpinebits-ch/venta-client-web:latest
```

`VENTA_API_HOSTS` is one or more **origins**, comma- or space-separated:

```
VENTA_API_HOSTS=https://chat.example.org
VENTA_API_HOSTS='https://chat.example.org,https://api.example.net:8443'
```

An origin and nothing more — scheme, host, optional port. No path, no trailing slash, no
credentials, no wildcard, and `https` only (the client only ever constructs https origins, and key
material may not travel in the clear). Case does not matter; host names are lowercased for you.

**You do not list the WebSocket origin.** Each `https://host` you give also permits
`wss://host`, derived for you. The realtime layer builds `${baseUrl}/api/v1/ws/hub` and upgrades it
to `wss:`, so an allowlist with only the https form produces a client that logs in and then never
receives a message, a presence update or a typing indicator — which looks exactly like a broken
server. Deriving it removes the chance to get that wrong.

**Your value replaces the default, it does not extend it.** `VENTA_API_HOSTS=https://chat.example.org`
means api.venta.gg is no longer reachable from your deployment, which is what you want.

### A bad value stops the container

Empty, misspelled, `http`, or carrying a path — the container refuses to start and says why:

```
40-render-csp.sh: FATAL: 'https://chat.example.org/api' is not a bare https origin. Got host part 'chat.example.org/api'
40-render-csp.sh: refusing to start. $VENTA_API_HOSTS must be one or more https origins, ...
```

This is deliberate and it is the point of the whole mechanism. The alternative — accepting the value
and rendering whatever it produces — gives you a policy that is silently wrong: either narrower than
you asked for, so the app cannot reach your server, or broad enough to be worthless. A container
that will not start is the only failure mode you cannot miss.

You can also bake a default in at build time with `--build-arg VENTA_API_HOSTS=...` if you have the
source; a bad build arg fails the build. The env var is the supported route, because this repository
is private and you cannot build the image.

## Why this is an allowlist rather than a wildcard

**The web client holds the account master key and the MLS signing keys in IndexedDB.**

On desktop those live in an OS keychain. In a browser there is no equivalent — `SecureStore.hardwareBacked`
is `false` on web and the key-backup UI says so — which means any script that executes on this origin
can read them. So the Content-Security-Policy this image serves is not hardening; it is the primary
defence for private key material, and `connect-src` is the directive that decides where a script
could send what it read.

`connect-src https:` would satisfy every self-hoster and also hand any successful injection a
one-line exfiltration channel to an attacker's own server. Naming the origins costs you one
environment variable and removes that channel: even with script execution, there is nowhere to send
the keys.

The rest of the policy is fixed and documented directive by directive in
[`security-headers.conf.template`](security-headers.conf.template) — `script-src 'self'
'wasm-unsafe-eval' https://js.stripe.com` with no `unsafe-inline`, a per-response nonce for inline styles,
`frame-ancestors 'none'`. `Cross-Origin-Embedder-Policy` is deliberately absent: the wasm engine is
single-threaded, so it buys nothing, and it would break the third-party image and GIF embeds in
messages.

## Serving it behind TLS

The container listens on plain HTTP port 80 and expects a reverse proxy or ingress in front of it
terminating TLS. It sets no `Strict-Transport-Security` header for that reason — HSTS belongs to
whatever owns the certificate and the hostname, and a container emitting it over a plain-HTTP hop is
either ignored or wrong. Add it at your edge.

`/healthz` answers `200 ok` for orchestrator health checks. Do not use `/health`: in a combined
deployment that path belongs to the API, and confusing the two makes a misrouted gateway look
healthy.

## Caching

Hashed build output (`main-XXXXXXXX.js`, `media/*.woff2`) is served `immutable` for a year.
Everything under `/assets/` — the wasm engine, the i18n JSON, the branding — carries no content hash,
so it is served `max-age=0, must-revalidate`: a conditional request per navigation, answered `304`.
`index.html` is `no-store`, which is required rather than cautious, because each response embeds a
fresh CSP nonce that its markup must match.

## Files

| File | What it is |
|---|---|
| `Dockerfile` | Packages the prebuilt output. No build stage: the Angular and wasm compiles happen in the workflow, so no source enters the docker context. Also the payload assertions — no sourcemaps, no TypeScript, wasm engine present, no inline script in `index.html`. |
| `nginx.conf` | The server block: SPA fallback, cache policy, `application/wasm`, and the `sub_filter`s that inject the CSP nonce and the API-host meta tag. |
| `security-headers.conf.template` | Every security header, with `__CONNECT_SRC__` as the one substitution point. |
| `40-render-csp.sh` | Runs from `/docker-entrypoint.d/` at container start: validates `VENTA_API_HOSTS`, derives the `wss://` forms, renders the template. |

## For client developers

The rendered host list is published to the app as a meta tag in `index.html`:

```html
<meta name="venta-api-hosts" content="https://chat.example.org">
```

Space-separated origins, injected by nginx from the same string `connect-src` was built from. Read
it rather than maintaining a second list — a federation server picker that offers an origin the CSP
refuses produces a login that fails with nothing in the UI to explain it.
