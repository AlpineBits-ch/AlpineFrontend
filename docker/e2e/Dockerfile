# Source-free static image of the Angular client, for the public AlpineBits-ch/venta-e2e suite.
#
# There is no build stage here on purpose. The Angular compile happens in the workflow
# (.github/workflows/e2e-client-image.yml) and this image only packages its output, because the
# build context handed to docker is a staging directory containing nothing but `browser/` and this
# file's sibling nginx.conf. A multi-stage Dockerfile would need the repository as its context,
# which would put every .ts file in this repo into the daemon's context tarball for an image whose
# entire reason to exist is that it carries no source. Keeping source out of the *context* rather
# than merely out of the final layer is the difference between a guarantee and a convention.
#
# Build it by hand with:
#   mkdir -p .image-context
#   cp -R dist/alpine/browser .image-context/browser
#   cp docker/e2e/nginx.conf .image-context/nginx.conf
#   docker build -f docker/e2e/Dockerfile -t venta-client-e2e .image-context
# after `bun x ng build --configuration production --source-map=false`.

FROM nginx:alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY browser/ /usr/share/nginx/html/

# The check that makes the guarantee true rather than intended. The workflow runs the same
# assertions against dist/ before it gets here, and this repeats them against what actually landed
# in the image, so a hand-built image or a future change to the staging step cannot quietly ship
# sourcemaps. They matter because Angular's maps carry `sourcesContent` - the complete original
# TypeScript, not just file names - and a Playwright trace in a public repository would archive
# them verbatim.
#
# busybox grep, so no -I; a false positive on a font or a sprite sheet containing the literal
# bytes "sourceMappingURL" is not a real risk, and failing closed is the correct direction anyway.
RUN set -eu; \
    if find /usr/share/nginx/html -name '*.map' | grep -q .; then \
        echo "REFUSING TO BUILD: sourcemaps present in the image payload:" >&2; \
        find /usr/share/nginx/html -name '*.map' >&2; \
        exit 1; \
    fi; \
    if grep -rl 'sourceMappingURL' /usr/share/nginx/html >/dev/null 2>&1; then \
        echo "REFUSING TO BUILD: a bundle still references a sourcemap:" >&2; \
        grep -rl 'sourceMappingURL' /usr/share/nginx/html >&2; \
        exit 1; \
    fi; \
    if find /usr/share/nginx/html -name '*.ts' | grep -q .; then \
        echo "REFUSING TO BUILD: TypeScript source present in the image payload:" >&2; \
        find /usr/share/nginx/html -name '*.ts' >&2; \
        exit 1; \
    fi

EXPOSE 80

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
    CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
