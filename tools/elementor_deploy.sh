#!/usr/bin/env bash
# Deploy an f2h bundle to a Local (localwp.com) WordPress site running Elementor 4.x with Editor V4.
#
#   tools/elementor_deploy.sh <bundle-dir> <local-site-dir> [--slug name] [--validate-only]
#
#   <local-site-dir>  e.g. "~/Local Sites/vistara-elementor"
#
# What it does
#   1. re-emits the template with --public-base pointing at the site's uploads folder
#   2. copies out/elementor/{assets,fonts,elementor.css} to wp-content/uploads/f2h/<slug>/
#   3. validates the template against the installed Elementor prop schemas
#   4. imports it through the Elementor template library (images/SVGs are downloaded into the media library)
#   5. turns the imported template into a published page and points the companion stylesheet at it
#   6. prints the page URL
#
# Needs wp-cli. Uses Local's own PHP so wp-cli runs under the PHP version the site uses.
set -euo pipefail

BUNDLE=""; SITE=""; SLUG=""; VALIDATE_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --slug) SLUG="$2"; shift 2;;
    --validate-only) VALIDATE_ONLY=1; shift;;
    *) if [ -z "$BUNDLE" ]; then BUNDLE="$1"; elif [ -z "$SITE" ]; then SITE="$1"; else echo "unexpected arg $1" >&2; exit 2; fi; shift;;
  esac
done
[ -n "$BUNDLE" ] && [ -n "$SITE" ] || { echo "usage: $0 <bundle-dir> <local-site-dir> [--slug name] [--validate-only]" >&2; exit 2; }
BUNDLE="$(cd "$BUNDLE" && pwd)"; SITE="${SITE/#\~/$HOME}"; SITE="$(cd "$SITE" && pwd)"
SLUG="${SLUG:-$(basename "$BUNDLE" | tr 'A-Z' 'a-z' | sed 's/[^a-z0-9]\+/-/g')}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PUBLIC="$SITE/app/public"
[ -f "$PUBLIC/wp-config.php" ] || { echo "no wp-config.php under $PUBLIC" >&2; exit 1; }

# Run wp-cli with the site's own PHP and php.ini: Local sets mysqli.default_socket there, and the
# Homebrew PHP is usually newer than wp-cli likes. Site id comes from Local's sites.json.
LOCAL_APP="$HOME/Library/Application Support/Local"
SITE_ID="$(python3 - "$SITE" <<'PY'
import json, os, sys
want = os.path.realpath(sys.argv[1])
for k, v in json.load(open(os.path.expanduser("~/Library/Application Support/Local/sites.json"))).items():
    if os.path.realpath(os.path.expanduser(v.get("path", ""))) == want: print(k); break
PY
)"
[ -n "$SITE_ID" ] || { echo "site $SITE not found in Local's sites.json" >&2; exit 1; }
PHP_BIN="${WP_CLI_PHP:-}"
if [ -z "$PHP_BIN" ]; then
  PHP_VER="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]]["services"]["php"]["version"])' "$LOCAL_APP/sites.json" "$SITE_ID")"
  for p in "$LOCAL_APP/lightning-services/php-$PHP_VER"*/bin/darwin-*/bin/php; do [ -x "$p" ] && PHP_BIN="$p"; done
fi
PHP_INI="$LOCAL_APP/run/$SITE_ID/conf/php/php.ini"
[ -x "$PHP_BIN" ] && [ -f "$PHP_INI" ] || { echo "Local PHP for site $SITE_ID not found (is the site running in Local?)" >&2; exit 1; }
WP_PHAR="$(readlink -f "$(command -v wp)")"
wp() { "$PHP_BIN" -c "$PHP_INI" "$WP_PHAR" --path="$PUBLIC" --skip-themes "$@"; }
SITEURL="$(wp option get siteurl)"
# The library import checks edit_posts, so run as the first administrator.
ADMIN="$(wp user list --role=administrator --field=user_login | head -1)"
[ -n "$ADMIN" ] || { echo "no administrator user on $SITEURL" >&2; exit 1; }
BASE="$SITEURL/wp-content/uploads/f2h/$SLUG"
DEST="$PUBLIC/wp-content/uploads/f2h/$SLUG"
echo "[deploy] site $SITEURL, assets at $BASE"

# 1. emit
node "$HERE/src/cli.ts" elementor "$BUNDLE" --public-base "$BASE"
OUT="$BUNDLE/out/elementor"

# 2. copy
mkdir -p "$DEST"
rsync -a --delete "$OUT/assets/" "$DEST/assets/"
[ -d "$BUNDLE/out/fonts" ] && rsync -a "$BUNDLE/out/fonts/" "$DEST/fonts/" || true
cp "$OUT/elementor.css" "$DEST/elementor.css"

# 3. validate (needs Editor V4: same option set the editor's own "opt in to V4" button writes — Opt_In::OPT_IN_FEATURES)
for f in e_opt_in_v4 container nested-elements e_atomic_elements e_classes e_variables e_components; do
  if [ "$(wp option get "elementor_experiment-$f" 2>/dev/null || true)" != "active" ]; then wp option update "elementor_experiment-$f" active >/dev/null && echo "[deploy] enabled experiment $f"; fi
done
wp option update elementor_unfiltered_files_upload 1 >/dev/null   # SVG import
if ! wp eval-file "$HERE/tools/elementor_validate.php" "$OUT/template.json"; then
  echo "[deploy] template has validation errors (see above)"
  if [ "$VALIDATE_ONLY" = 1 ]; then exit 1; fi
fi
if [ "$VALIDATE_ONLY" = 1 ]; then exit 0; fi

# 4. import through the library (runs the atomic import transformers: images -> media library).
#    A previous deploy of the same bundle is replaced, not duplicated — but only after the new import,
#    and with its attachments detached first: Elementor reuses an already-imported image by URL hash,
#    and deleting a post with --force deletes the attachments parented to it (that 404'd 9 images once).
OLD_IDS="$(wp post list --post_type=page --name="f2h-$SLUG" --post_status=any --field=ID | tr '\n' ' ')"
IMPORT_LOG="$(mktemp)"
if ! wp --user="$ADMIN" elementor library import "$OUT/template.json" --returnType=ids >"$IMPORT_LOG" 2>&1; then
  grep -v "Deprecated" "$IMPORT_LOG" >&2; echo "[deploy] import failed" >&2; exit 1
fi
IDS="$(grep -vE "Deprecated|^\s*$" "$IMPORT_LOG" | tail -1 | tr -d '[:space:]')"
ID="${IDS##*,}"; ID="${ID//[!0-9]/}"
[ -n "$ID" ] || { cat "$IMPORT_LOG" >&2; echo "[deploy] import returned no template id" >&2; exit 1; }
echo "[deploy] imported template post $ID"
for old in $OLD_IDS; do
  for att in $(wp post list --post_type=attachment --post_parent="$old" --field=ID); do wp post update "$att" --post_parent="$ID" >/dev/null; done
  wp post delete "$old" --force >/dev/null && echo "[deploy] replaced previous page $old (its media re-parented to $ID)"
done

# 5. make it a page; hook the companion stylesheet
TITLE="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).title||"f2h")' "$OUT/template.json")"
wp post update "$ID" --post_type=page --post_status=publish --post_title="$TITLE" --post_name="f2h-$SLUG" >/dev/null
wp post meta update "$ID" _elementor_template_type wp-page >/dev/null
wp post meta update "$ID" _elementor_edit_mode builder >/dev/null
wp post meta update "$ID" _wp_page_template elementor_canvas >/dev/null
wp post meta update "$ID" _f2h_css "$BASE/elementor.css?v=$(date +%s)" >/dev/null
MU="$PUBLIC/wp-content/mu-plugins"; mkdir -p "$MU"
cat > "$MU/f2h-companion-css.php" <<'PHP'
<?php
/** Plugin Name: f2h companion CSS — loads the stylesheet an f2h Elementor import points at via _f2h_css. */
add_action( 'wp_enqueue_scripts', function () {
	if ( ! is_singular() ) { return; }
	$url = get_post_meta( get_queried_object_id(), '_f2h_css', true );
	if ( $url ) { wp_enqueue_style( 'f2h-companion', $url, [], null ); }
}, 100 );
PHP
wp elementor flush-css >/dev/null 2>&1 || true

URL="$(wp post url "$ID")"
echo "[deploy] page: $URL"
echo "[deploy] edit: $SITEURL/wp-admin/post.php?post=$ID&action=elementor"
