#!/usr/bin/env bash
set -euo pipefail

if [ -z "${GITHUB_TOKEN:-}" ]; then
  git push "$@"
  exit 0
fi

askpass="$(mktemp)"
cleanup() {
  rm -f "$askpass"
}
trap cleanup EXIT

cat >"$askpass" <<'EOF'
#!/usr/bin/env sh
case "$1" in
  *Username*) printf '%s\n' 'x-access-token' ;;
  *Password*) printf '%s\n' "${GITHUB_TOKEN:?}" ;;
  *) printf '%s\n' "${GITHUB_TOKEN:?}" ;;
esac
EOF
chmod 700 "$askpass"

GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0 git push "$@"
