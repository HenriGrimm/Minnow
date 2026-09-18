#!/usr/bin/env bash
# Upload macOS signing + notarization credentials to GitHub Actions secrets for
# the beta nightly workflow. Exports only the Developer ID Application identity
# from the login keychain, repackages it as a fresh .p12 with a random password,
# and reads Apple notarization values from .env.signing. Nothing is printed.
#
# Usage: npm run signing:upload-secrets [-- --repo owner/name]
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$repo_root/.env.signing"
repo_args=()
if [[ "${1:-}" == "--repo" && -n "${2:-}" ]]; then repo_args=(--repo "$2"); fi

# LibreSSL writes .p12 files that `security import` on CI runners accepts.
ssl=/usr/bin/openssl

die() { echo "✗ $*" >&2; exit 1; }

[[ "$(uname)" == "Darwin" ]] || die "macOS only."
command -v gh >/dev/null || die "GitHub CLI (gh) not found."
gh auth status >/dev/null 2>&1 || die "Run: gh auth login"
[[ -f "$env_file" ]] || die "Missing .env.signing (copy .env.signing.example)."

read_env() {
  local line
  line="$(grep -E "^[[:space:]]*$1=" "$env_file" | tail -n 1 || true)"
  line="${line#*=}"
  line="${line#\"}"; line="${line%\"}"
  line="${line#\'}"; line="${line%\'}"
  printf '%s' "$line"
}

for key in APPLE_ID APPLE_TEAM_ID APPLE_APP_SPECIFIC_PASSWORD; do
  [[ -n "$(read_env "$key")" ]] || die "$key is empty in .env.signing."
done
team_id="$(read_env APPLE_TEAM_ID)"

umask 077
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

export_pass="$($ssl rand -hex 24)"
p12_pass="$($ssl rand -hex 24)"

echo "→ Exporting identities from the login keychain."
echo "  macOS will ask to allow the export — click Allow (it may ask for your login password)."
security export -k login.keychain-db -t identities -f pkcs12 \
  -P "$export_pass" -o "$work/all.p12" >/dev/null

$ssl pkcs12 -in "$work/all.p12" -passin "pass:$export_pass" -nokeys -clcerts \
  -out "$work/certs.pem" 2>/dev/null
$ssl pkcs12 -in "$work/all.p12" -passin "pass:$export_pass" -nocerts -nodes \
  -out "$work/keys.pem" 2>/dev/null

awk -v dir="$work" '/-----BEGIN CERTIFICATE-----/{n++} n{print > (dir "/cert" n ".pem")}' "$work/certs.pem"
awk -v dir="$work" '/-----BEGIN .*PRIVATE KEY-----/{n++} n{print > (dir "/key" n ".pem")}' "$work/keys.pem"

cert=""
for c in "$work"/cert*.pem; do
  [[ -f "$c" ]] || continue
  subject="$($ssl x509 -in "$c" -noout -subject 2>/dev/null || true)"
  if [[ "$subject" == *"Developer ID Application"* && "$subject" == *"$team_id"* ]] \
    && $ssl x509 -in "$c" -noout -checkend 0 >/dev/null 2>&1; then
    cert="$c"
    break
  fi
done
[[ -n "$cert" ]] || die "No valid Developer ID Application certificate for team $team_id in the keychain."

cert_pub="$($ssl x509 -in "$cert" -noout -pubkey | $ssl sha256)"
key=""
for k in "$work"/key*.pem; do
  [[ -f "$k" ]] || continue
  if [[ "$($ssl pkey -in "$k" -pubout 2>/dev/null | $ssl sha256)" == "$cert_pub" ]]; then
    key="$k"
    break
  fi
done
[[ -n "$key" ]] || die "Private key for the Developer ID certificate was not exported."

$ssl pkcs12 -export -in "$cert" -inkey "$key" -name "Developer ID Application" \
  -passout "pass:$p12_pass" -out "$work/devid.p12" 2>/dev/null
$ssl pkcs12 -in "$work/devid.p12" -passin "pass:$p12_pass" -noout 2>/dev/null \
  || die "Repackaged .p12 failed verification."
echo "✓ Packaged $($ssl x509 -in "$cert" -noout -subject | sed -E 's/.*CN=([^/]+).*/\1/') (expires $($ssl x509 -in "$cert" -noout -enddate | cut -d= -f2))"

set_secret() {
  gh secret set "$1" ${repo_args[@]+"${repo_args[@]}"} >/dev/null
  echo "✓ $1"
}

echo "→ Uploading GitHub Actions secrets."
base64 -i "$work/devid.p12" | tr -d '\n' | set_secret MACOS_CERTIFICATE_P12_BASE64
printf '%s' "$p12_pass" | set_secret MACOS_CERTIFICATE_PASSWORD
read_env APPLE_ID | set_secret APPLE_ID
read_env APPLE_APP_SPECIFIC_PASSWORD | set_secret APPLE_APP_SPECIFIC_PASSWORD
read_env APPLE_TEAM_ID | set_secret APPLE_TEAM_ID

echo ""
echo "Done. Trigger a nightly to verify: gh workflow run beta-nightly-release.yml"
