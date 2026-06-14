#!/usr/bin/env bash
#
# Snapfile deploy script — installs PREBUILT, VERSIONED releases (no build here).
#
# The client is built off-host by the `Release` GitHub Action, which publishes
# snapfile-<version>.tar.gz (prebuilt static/ + backend server/) to the repo's
# Releases. This script downloads a given version, installs it into its own
# release directory, and atomically switches to it — so deploys are versioned
# and rolling back is instant.
#
# Layout it manages under $prefix:
#   releases/<version>/static     prebuilt Vue client (served by nginx)
#   releases/<version>/server     backend source (pip-installed)
#   current -> releases/<version> active release
#   static  -> current/static     nginx root (so a switch is one symlink flip)
#   files/ db/ logs/              persistent, shared across versions
#
# Usage (run as root):
#   bash install.sh <version>     deploy a version, e.g. v1.2.3 (or 'latest')
#   bash install.sh rollback      switch back to the previous release
#   bash install.sh list          list installed releases and the active one
#
# Overrides (env):
#   LOCAL_ARTIFACT=/path/snapfile-vX.tar.gz   use a local artifact instead of downloading
#   HEALTHCHECK_URL=https://...               public URL checked after a switch
set -euo pipefail

# ---- configuration ---------------------------------------------------------
user=yxr
prefix=/var/www/snapfile
pyversion=3.12.6
REPO=yanxurui/Snapfile
KEEP_RELEASES=5
HEALTHCHECK_URL="${HEALTHCHECK_URL:-https://snapfile.yanxurui.cc/login.html}"

PIP="/home/$user/.pyenv/versions/$pyversion/bin/pip"
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"

log()  { echo -e "\033[1;32m[deploy]\033[0m $*"; }
warn() { echo -e "\033[1;33m[deploy]\033[0m $*" >&2; }
die()  { echo -e "\033[1;31m[deploy]\033[0m $*" >&2; exit 1; }
need_root() { [ "$(id -u)" -eq 0 ] || die "please run as root (sudo)."; }

# ---- one-time / idempotent host setup --------------------------------------
ensure_host() {
    log "ensuring prerequisites and directories..."
    for p in nginx redis supervisor; do
        rpm --quiet --query "$p" || yum install -y "$p"
    done

    [ -x "$PIP" ] || die "python $pyversion not found for $user — install it with pyenv first."

    mkdir -p "$prefix"/{releases,files,db,logs}
    # chown structural dirs only (don't recurse into files/ — it can be large);
    # each release dir is chowned when it's unpacked.
    chown "$user" "$prefix" "$prefix"/{releases,files,logs}
    chown redis "$prefix/db" 2>/dev/null || true

    # redis: enable persistence and point it at our db dir (idempotent)
    if [ -f /etc/redis.conf ]; then
        grep -q "^appendonly yes" /etc/redis.conf || sed -i 's|^appendonly no|appendonly yes|' /etc/redis.conf
        grep -q "^dir ${prefix}/db" /etc/redis.conf || sed -i "s|^dir .*|dir ${prefix}/db|" /etc/redis.conf
    fi

    # nginx/supervisor configs: only create if absent, so local customizations
    # (e.g. a shared map in conf.d/common.conf, IPv6 listen) are preserved.
    if [ ! -e /etc/nginx/conf.d/snapfile.conf ]; then
        ln -s "$DEPLOY_DIR/snapfile.conf" /etc/nginx/conf.d/snapfile.conf
    fi
    if [ ! -e /etc/supervisord.d/snapfile.ini ]; then
        ln -s "$DEPLOY_DIR/supervisord.ini" /etc/supervisord.d/snapfile.ini
        systemctl restart supervisord || true
    fi
}

# ---- fetch a release into releases/<version> -------------------------------
fetch_release() {
    local version="$1" dir="$prefix/releases/$1"
    if [ -d "$dir/static" ] && [ -d "$dir/server" ]; then
        log "release $version already present, skipping download."
        return
    fi
    local tarball
    tarball="$(mktemp /tmp/snapfile-XXXXXX.tar.gz)"
    if [ -n "${LOCAL_ARTIFACT:-}" ]; then
        log "using local artifact $LOCAL_ARTIFACT"
        cp "$LOCAL_ARTIFACT" "$tarball"
    else
        local url="https://github.com/$REPO/releases/download/$version/snapfile-$version.tar.gz"
        log "downloading $url"
        curl -fL --retry 3 "$url" -o "$tarball" \
            || die "could not download release $version (does it exist on GitHub Releases?)"
    fi
    rm -rf "$dir"
    mkdir -p "$dir"
    tar -xzf "$tarball" -C "$dir"
    rm -f "$tarball"
    [ -f "$dir/static/index.html" ] && [ -f "$dir/server/setup.py" ] \
        || die "artifact for $version is missing static/ or server/"
    chown -R "$user" "$dir"
    log "unpacked release $version"
}

# ---- install the backend for a given release -------------------------------
install_backend() {
    local dir="$prefix/releases/$1/server"
    log "installing backend $1 into python $pyversion ..."
    # --no-deps + force refreshes the package code; a plain install ensures deps.
    sudo -u "$user" "$PIP" install "$dir"
    sudo -u "$user" "$PIP" install --no-deps --force-reinstall "$dir"
}

# ---- atomically switch the active release ----------------------------------
activate() {
    local version="$1" new="$prefix/releases/$1"
    [ -d "$new" ] || die "release $version is not installed."

    # remember the release we're leaving, for rollback
    if [ -L "$prefix/current" ]; then
        ln -sfn "$(readlink "$prefix/current")" "$prefix/previous.tmp"
        mv -Tf "$prefix/previous.tmp" "$prefix/previous"
    fi

    # flip current -> releases/<version> atomically
    ln -sfn "$new" "$prefix/current.tmp"
    mv -Tf "$prefix/current.tmp" "$prefix/current"

    # nginx root ($prefix/static) -> current/static (migrate a real dir once)
    if [ ! -L "$prefix/static" ]; then
        [ -e "$prefix/static" ] && mv "$prefix/static" "$prefix/static.realdir.bak.$(date +%s)"
    fi
    ln -sfn current/static "$prefix/static.tmp"
    mv -Tf "$prefix/static.tmp" "$prefix/static"
    chown -h "$user" "$prefix/current" "$prefix/static" 2>/dev/null || true
    log "active release is now $version"
}

restart_app() {
    log "restarting service..."
    supervisorctl restart snapfile >/dev/null 2>&1 || supervisorctl start snapfile
}

health_check() {
    log "health check..."
    local backend
    backend="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:8080/auth || echo 000)"
    [ "$backend" = "401" ] || [ "$backend" = "200" ] \
        || die "backend not healthy (got HTTP $backend from :8080/auth)"
    local site
    site="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 "$HEALTHCHECK_URL" || echo 000)"
    [ "$site" = "200" ] || warn "site check returned HTTP $site for $HEALTHCHECK_URL"
    log "backend OK ($backend), site $site"
}

prune_releases() {
    local active previous v count=0
    active="$(basename "$(readlink "$prefix/current")")"
    previous="$( [ -L "$prefix/previous" ] && basename "$(readlink "$prefix/previous")" || true)"
    local dirs=()
    mapfile -t dirs < <(ls -1dt "$prefix"/releases/*/ 2>/dev/null | sed 's:/*$::') || true
    # keep active + previous always, plus the newest KEEP_RELEASES of the rest
    for d in "${dirs[@]:-}"; do
        [ -d "$d" ] || continue
        v="$(basename "$d")"
        if [ "$v" = "$active" ] || [ "$v" = "$previous" ]; then continue; fi
        count=$((count + 1))
        if [ "$count" -gt "$KEEP_RELEASES" ]; then
            log "pruning old release $v"
            rm -rf "$d"
        fi
    done
}

deploy() {
    need_root
    local version="$1"
    [ "$version" = "latest" ] && version="$(resolve_latest)"
    ensure_host
    fetch_release "$version"
    install_backend "$version"
    activate "$version"
    restart_app
    health_check
    prune_releases
    log "deployed $version  🎉"
}

rollback() {
    need_root
    [ -L "$prefix/previous" ] || die "no previous release recorded to roll back to."
    local version; version="$(basename "$(readlink "$prefix/previous")")"
    log "rolling back to $version ..."
    install_backend "$version"
    activate "$version"
    restart_app
    health_check
    log "rolled back to $version"
}

list_releases() {
    local active; active="$( [ -L "$prefix/current" ] && basename "$(readlink "$prefix/current")" || echo none)"
    echo "active: $active"
    for d in "$prefix"/releases/*/; do
        [ -d "$d" ] || continue
        local v; v="$(basename "$d")"
        [ "$v" = "$active" ] && echo "  * $v (active)" || echo "    $v"
    done
}

resolve_latest() {
    curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
        | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/' \
        || die "could not resolve latest release"
}

# ---- dispatch --------------------------------------------------------------
cmd="${1:-}"
case "$cmd" in
    ""|-h|--help) grep '^#' "$0" | grep -v '^#!' | sed 's/^# \{0,1\}//' | head -n 30 ;;
    rollback)     rollback ;;
    list)         list_releases ;;
    *)            deploy "$cmd" ;;
esac
