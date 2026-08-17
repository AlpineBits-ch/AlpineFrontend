# The public web client: the Angular app and the wasm crypto engine, served by nginx.
#
# Same shape as docker/e2e/Dockerfile and for the same reason. There is no build stage here: the
# Angular compile and the `wasm-pack build` both happen in the workflow
# (.github/workflows/web-client-image.yml), and the build context handed to docker is a staging
# directory containing nothing but `browser/` and this file's two siblings. A multi-stage
# Dockerfile would need the repository as its context, which would put every .ts file in this
# private repo into the daemon's context tarball for an image that is published to a registry.
# Keeping source out of the *context* rather than merely out of the final layer is the difference
# between a guarantee and a convention.
#
# Build it by hand with:
#   bun run build:wasm
#   bun x ng build --configuration production --source-map=false
#   mkdir -p .web-context
#   cp -R dist/alpine/browser .web-context/browser
#   cp docker/web/nginx.conf docker/web/security-headers.conf.template \
#      docker/web/40-render-csp.sh .web-context/
#   docker build -f docker/web/Dockerfile -t venta-client-web .web-context
# noting that the index.html rewrite the CSP depends on lives in the workflow, so a hand-built
# image will refuse to build until you apply it - see the inline-handler check below.

FROM nginx:alpine

# The API origin(s) the client is permitted to talk to, as an allowlist for the CSP's connect-src.
# See docker/web/README.md for the deployer story and 40-render-csp.sh for the validation.
#
# Two ways in, one code path:
#
#   * this build ARG bakes the default into the image, for whoever has the source and wants a
#     pre-pointed build;
#   * the ENV below is what 40-render-csp.sh actually reads at container start, so
#     `docker run -e VENTA_API_HOSTS=https://chat.example.org` overrides it without a rebuild.
#
# The runtime path is the important one: this repository is private, so a self-hoster cannot build
# this image, only pull it. A build-arg-only design would be configurable in principle and
# unconfigurable in practice for precisely the people who need it.
#
# The default is exactly the production origin and nothing else, so the official image is as locked
# down as it would be with the value hard-coded. Nobody gets a looser policy by accident: an
# override replaces this list rather than adding to it, and an empty or malformed value stops the
# container instead of widening anything.
ARG VENTA_API_HOSTS=https://api.venta.gg
ENV VENTA_API_HOSTS=${VENTA_API_HOSTS}

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.conf.template /etc/nginx/security-headers.conf.template
COPY 40-render-csp.sh /docker-entrypoint.d/40-render-csp.sh
COPY browser/ /usr/share/nginx/html/

RUN chmod +x /docker-entrypoint.d/40-render-csp.sh

# ── The checks that make the guarantees true rather than intended ─────────────────────────────
#
# The workflow runs equivalents against dist/ before it gets here; these repeat them against what
# actually landed in the image, so a hand-built image or a future change to the staging step
# cannot quietly ship a payload the CSP is wrong about. Every comment lives out here rather than
# between the continuation lines below, because a `#` line inside a continued RUN is a parser
# question this file has no reason to ask.
#
# All of it is busybox grep and busybox find: no -I, no -P.
#
#   1. No sourcemaps and no TypeScript. Angular's maps carry `sourcesContent` - the complete
#      original source, not merely its paths - and this image is published to a registry and
#      served publicly from a private repository.
#
#   2. The wasm crypto engine is present. Without it the web client has no MLS engine, no
#      master-key wrapping and no device certificates, and it fails at *runtime* on the login
#      path rather than at build time: angular.json copies src/assets with a `**/*` glob, and a
#      glob that matches nothing is not an error. This is the only place that notices.
#
#   3. Nothing in index.html needs 'unsafe-inline' in script-src. Two separate hazards - an
#      inline event handler, of which the production build emits exactly one (Beasties' onload on
#      the deferred stylesheet link, which the workflow rewrites away), and an inline <script>
#      body. Either would make the CSP silently wrong: the offending code is refused, so the
#      symptom is unstyled UI or one dead feature rather than an obvious failure.
#
#   4. The two strings nginx's nonce sub_filter matches on. A sub_filter that matches nothing
#      does not error - it serves the document unchanged - so if Angular's output shape moves,
#      the app ships with every <style> block refused by its own CSP and renders unstyled. This
#      turns that into a build failure.
RUN set -eu; \
    html=/usr/share/nginx/html; \
    if find "$html" -name '*.map' | grep -q .; then \
        echo "REFUSING TO BUILD: sourcemaps present in the image payload:" >&2; \
        find "$html" -name '*.map' >&2; \
        exit 1; \
    fi; \
    if grep -rl 'sourceMappingURL' "$html" >/dev/null 2>&1; then \
        echo "REFUSING TO BUILD: a bundle still references a sourcemap." >&2; \
        exit 1; \
    fi; \
    if find "$html" -name '*.ts' | grep -q .; then \
        echo "REFUSING TO BUILD: TypeScript source present in the image payload:" >&2; \
        find "$html" -name '*.ts' >&2; \
        exit 1; \
    fi; \
    test -s "$html/assets/wasm/venta_crypto_bg.wasm" || { \
        echo "REFUSING TO BUILD: assets/wasm/venta_crypto_bg.wasm is missing or empty." >&2; \
        echo "Run 'bun run build:wasm' before 'ng build' - ng build will not tell you." >&2; \
        exit 1; \
    }; \
    test -s "$html/assets/wasm/venta_crypto.js" || { \
        echo "REFUSING TO BUILD: assets/wasm/venta_crypto.js is missing or empty." >&2; \
        exit 1; \
    }; \
    if grep -o ' on[a-z]*="' "$html/index.html" | grep -q .; then \
        echo "REFUSING TO BUILD: index.html has an inline event handler, which script-src in" >&2; \
        echo "security-headers.conf does not permit. Offending attributes:" >&2; \
        grep -o ' on[a-z]*="' "$html/index.html" >&2; \
        exit 1; \
    fi; \
    if grep -o '<script[^>]*>' "$html/index.html" | grep -v 'src=' | grep -q .; then \
        echo "REFUSING TO BUILD: index.html has an inline <script>, which script-src does not" >&2; \
        echo "permit:" >&2; \
        grep -o '<script[^>]*>' "$html/index.html" | grep -v 'src=' >&2; \
        exit 1; \
    fi; \
    grep -q '<style>' "$html/index.html" || { \
        echo "REFUSING TO BUILD: no bare '<style>' in index.html for nginx's nonce sub_filter to" >&2; \
        echo "match. The CSP would refuse the inlined critical CSS and the loading spinner." >&2; \
        exit 1; \
    }; \
    grep -q '<app-root></app-root>' "$html/index.html" || { \
        echo "REFUSING TO BUILD: no literal '<app-root></app-root>' in index.html, so nginx" >&2; \
        echo "cannot inject ngCspNonce and Angular's runtime component styles would all be" >&2; \
        echo "refused by the CSP. Check what the Angular build now emits." >&2; \
        exit 1; \
    }; \
    echo "payload ok: no source, no maps, wasm engine present, no inline script, nonce hooks intact"

# Render the CSP once at build time and parse-check the result, so that:
#
#   1. a bad `--build-arg VENTA_API_HOSTS=...` fails the BUILD rather than the first container
#      start. The same script runs again at every start and rejects a bad env var there too, but a
#      build arg is a build-time input and deserves a build-time verdict;
#   2. `nginx -t` has the generated /etc/nginx/security-headers.conf and
#      /etc/nginx/venta-runtime.conf to include. Without this step it would fail on a missing
#      include and prove nothing about the config;
#   3. the config itself is parse-checked at build time rather than on the first request. The
#      `include`s, the regex location nested inside the /assets/ prefix location and the three
#      sub_filter directives are each a typo away from a container that exits on start.
#
# The rendered files are left in the image and then overwritten on every start by the identical
# script, so nothing here can go stale relative to the env var actually in force.
RUN /docker-entrypoint.d/40-render-csp.sh && nginx -t

EXPOSE 80

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
    CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
