#!/bin/sh
#
# Renders the Content-Security-Policy's `connect-src` from $VENTA_API_HOSTS, and publishes the same
# list to the app as a <meta> tag so the client and the policy can never disagree.
#
# Runs from /docker-entrypoint.d/, which the nginx image's entrypoint executes before starting
# nginx. That placement is the whole reliability argument: docker-entrypoint.sh runs under `set -e`,
# so a non-zero exit here aborts startup and the container dies with this script's message on
# stderr. Verified, not assumed - a script in that directory exiting 1 produces container exit code
# 1 and nginx never starts. There is therefore no path by which a rejected value ends up serving a
# policy with a hole in it.
#
# ---------------------------------------------------------------------------------------------
# Why this is configurable at all, and why only this
# ---------------------------------------------------------------------------------------------
#
# api-config.service.ts lets a user point the client at a self-hosted server: `setServer(domain)`
# resolves to `https://<domain>` and every API call and the SignalR hub follow it. A CSP that only
# permits api.venta.gg breaks that outright, and the fix cannot be `connect-src https:` - this
# build holds the account master key and the MLS signing keys in IndexedDB, so a wildcard
# connect-src is a ready-made exfiltration channel for any injected script. So the host is
# configuration: narrow by default, widened deliberately by whoever deploys it, never wildcard.
#
# Only the API host is configurable. The other entries in connect-src (Klipy, Sentry, the three AI
# providers) are properties of the client's code rather than of a deployment, and making them
# adjustable would just be more surface with no caller.
#
# ---------------------------------------------------------------------------------------------
# Runtime env var rather than only a build arg, and the reason is not convenience
# ---------------------------------------------------------------------------------------------
#
# This repository is private, so a self-hoster cannot build this image - they can only pull it.
# A build-arg-only design would therefore be configurable in principle and unconfigurable in
# practice for exactly the people who need it. $VENTA_API_HOSTS is read here, at container start,
# so `docker run -e VENTA_API_HOSTS=https://chat.example.org` is the whole procedure.
#
# The build arg still exists and sets the baked-in default (see the Dockerfile), so an organisation
# that does have the source can ship a pre-pointed image; both routes end up in this one code path.
set -eu

TEMPLATE=/etc/nginx/security-headers.conf.template
OUT=/etc/nginx/security-headers.conf
RUNTIME=/etc/nginx/venta-runtime.conf

me="40-render-csp.sh"

die() {
    echo "$me: FATAL: $1" >&2
    echo "$me: refusing to start. \$VENTA_API_HOSTS must be one or more https origins," >&2
    echo "$me: comma- or space-separated, each an origin and nothing more - no path, no" >&2
    echo "$me: trailing slash, no credentials, no wildcard. For example:" >&2
    echo "$me:     VENTA_API_HOSTS=https://api.venta.gg" >&2
    echo "$me:     VENTA_API_HOSTS='https://chat.example.org,https://api.example.net:8443'" >&2
    echo "$me: See docker/web/README.md." >&2
    exit 1
}

test -r "$TEMPLATE" || die "$TEMPLATE is missing from the image"

# Unset and empty are both rejected. An empty value is the dangerous one: left to a naive
# substitution it renders `connect-src 'self' blob:;` - a syntactically valid directive that
# forbids every API call, so the app loads and then fails to talk to anything, which reads as a
# server outage rather than as a misconfiguration.
hosts="${VENTA_API_HOSTS:-}"
[ -n "$hosts" ] || die "\$VENTA_API_HOSTS is empty or unset"

connect_src="'self' blob:"
meta_hosts=""

# Commas to spaces so both separators work; `for` then splits on IFS.
for entry in $(printf '%s' "$hosts" | tr ',' ' '); do
    case "$entry" in
        https://*) ;;
        http://*) die "'$entry' is http. The client only ever builds https origins
                  (api-config.service.ts), and key material may not travel in the clear" ;;
        *) die "'$entry' does not start with https://" ;;
    esac

    # Lowercased rather than rejected. Host names are case-insensitive and CSP matches them that
    # way, so `https://Chat.Example.org` is a correct value typed in a slightly unusual style -
    # failing the container over it would be a support question with no security content. The
    # regex below is then free to be strict about case, which keeps it simple.
    hostport=$(printf '%s' "${entry#https://}" | tr '[:upper:]' '[:lower:]')

    # One regex, deliberately strict: lowercase host, dots and hyphens, an optional numeric port,
    # and nothing else. It is what rejects a path, a trailing slash, a query, a fragment,
    # `user:pass@`, a `*` wildcard, whitespace and an empty host - each of which is either a CSP
    # source expression that browsers ignore (leaving a directive narrower than intended) or, in
    # the wildcard case, exactly the hole this whole mechanism exists to prevent.
    #
    # A CSP host-source has no path component at all, so accepting one and silently dropping it
    # would be the worst option: the deployer would see their URL echoed back and get a policy
    # that did not match it.
    printf '%s' "$hostport" \
        | grep -qE '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$' \
        || die "'$entry' is not a bare https origin. Got host part '$hostport'"

    # Both schemes, derived rather than declared. SignalR builds \`\${baseUrl}/api/v1/ws/hub\` and
    # upgrades it to wss://, so a deployment that lists only the https origin gets an app that
    # loads, authenticates, and then never receives a realtime event - no messages arriving, no
    # presence, no typing indicators. That failure looks precisely like a broken backend, which is
    # why the deployer is not asked to remember the second scheme.
    connect_src="$connect_src https://$hostport wss://$hostport"
    meta_hosts="${meta_hosts:+$meta_hosts }https://$hostport"
done

# The fixed, code-derived entries. Kept here rather than in the template so the whole directive is
# assembled in one place and its order is stable.
#
#   Klipy       gif.service.ts, GIF search
#   Sentry      the ingest host from the DSN in main.ts
#   AI          the three providers the assistant calls directly from the browser with
#               `dangerouslyAllowBrowser: true`
connect_src="$connect_src https://api.klipy.com"
connect_src="$connect_src https://o4511596550946816.ingest.de.sentry.io"
connect_src="$connect_src https://api.anthropic.com https://api.openai.com"
connect_src="$connect_src https://generativelanguage.googleapis.com"

# `|` as the sed delimiter: the value contains slashes and no pipes, and the validation above is
# what guarantees the second half of that.
sed "s|__CONNECT_SRC__|$connect_src|" "$TEMPLATE" > "$OUT"

# A template that no longer contains the placeholder would render a policy missing its whole
# connect-src, which falls back to default-src. Here that fallback happens to be 'none' and would
# fail loudly - but relying on the value of another directive to catch a substitution failure is
# not a check, so this is.
if grep -q '__CONNECT_SRC__' "$OUT"; then
    die "the placeholder survived substitution; $TEMPLATE is not what this script expects"
fi
# -F: a fixed string, not a pattern. The value contains dots, which as a regex would match any
# character and make this check weaker than it looks.
grep -qF "connect-src $connect_src;" "$OUT" \
    || die "the rendered policy does not contain the connect-src that was built"

# The same list, for the client. A <meta> tag rather than a /config.json: it is injected by the
# sub_filter that already runs over index.html, so it costs no extra request and is present before
# Angular bootstraps - and, more importantly, it is generated from this same $connect_src loop, so
# the hosts the UI offers and the hosts the CSP permits cannot drift apart. The client half (gating
# the federation server picker to this list) is a separate change; see docker/web/README.md.
printf 'set $venta_api_hosts "%s";\n' "$meta_hosts" > "$RUNTIME"

echo "$me: connect-src rendered for: $meta_hosts"
