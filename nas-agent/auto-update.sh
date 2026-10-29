#!/bin/sh
set -eu

ROOT="/volume1/docker/sungwoo-kasa-agent"
BASE="https://raw.githubusercontent.com/kieanu13245-a11y/SUNGWOO-KASA-Mobile/main/nas-agent"
STATE="$ROOT/data/.github-auto-update-version"
LOCK="$ROOT/data/.github-auto-update-lock"
FORCE="${1:-}"

log(){ echo "[SUNGWOO-AUTO] $(date '+%Y-%m-%d %H:%M:%S') $*"; }

if ! command -v curl >/dev/null 2>&1; then
  log "오류: curl 없음"
  exit 1
fi

if ! mkdir "$LOCK" 2>/dev/null; then
  log "이미 업데이트 확인 중"
  exit 0
fi
trap 'rm -rf "$LOCK" "$TMP" 2>/dev/null || true' EXIT INT TERM

TMP="$(mktemp -d /tmp/sungwoo-kasa-update.XXXXXX)"
MANIFEST="$TMP/version.json"

# updater 자체도 최신본으로 동기화. 현재 실행은 계속하고 다음 실행부터 새 스크립트를 사용한다.
if curl -fsSL --connect-timeout 10 --max-time 30 "$BASE/auto-update.sh?ts=$(date +%s)" -o "$TMP/auto-update.sh.remote"; then
  if [ ! -f "$ROOT/auto-update.sh" ] || ! cmp -s "$TMP/auto-update.sh.remote" "$ROOT/auto-update.sh"; then
    cp "$TMP/auto-update.sh.remote" "$ROOT/auto-update.sh"
    chmod 755 "$ROOT/auto-update.sh"
    log "업데이터 스크립트 최신화"
  fi
fi

curl -fsSL --connect-timeout 10 --max-time 30 "$BASE/version.json?ts=$(date +%s)" -o "$MANIFEST"

REMOTE_VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$MANIFEST" | head -1)"
PAYLOAD="$(sed -n 's/.*"payload"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$MANIFEST" | head -1)"
EXPECTED_SHA="$(sed -n 's/.*"sha256"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$MANIFEST" | head -1)"
LOCAL_VERSION="$(cat "$STATE" 2>/dev/null || true)"

if [ -z "$REMOTE_VERSION" ] || [ -z "$PAYLOAD" ]; then
  log "오류: GitHub 버전정보 파싱 실패"
  exit 1
fi

if [ "$FORCE" != "--force" ] && [ "$LOCAL_VERSION" = "$REMOTE_VERSION" ]; then
  log "최신 버전 유지: v$REMOTE_VERSION"
  exit 0
fi

log "업데이트 발견: ${LOCAL_VERSION:-미기록} -> $REMOTE_VERSION"
curl -fsSL --connect-timeout 10 --max-time 60 "$BASE/$PAYLOAD?ts=$(date +%s)" -o "$TMP/payload.b64"
base64 -d "$TMP/payload.b64" > "$TMP/payload.tar.gz"

if [ -n "$EXPECTED_SHA" ] && command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_SHA="$(sha256sum "$TMP/payload.tar.gz" | awk '{print $1}')"
  if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
    log "오류: SHA256 불일치"
    exit 1
  fi
fi

mkdir -p "$TMP/extract"
tar -xzf "$TMP/payload.tar.gz" -C "$TMP/extract"

for f in agent.js price_rules.json; do
  if [ ! -s "$TMP/extract/$f" ]; then
    log "오류: 배포파일 누락 - $f"
    exit 1
  fi
done

BACKUP="$ROOT/data/update-backups/$(date '+%Y%m%d_%H%M%S')"
mkdir -p "$BACKUP"
cp "$ROOT/agent.js" "$BACKUP/agent.js" 2>/dev/null || true
cp "$ROOT/price_rules.json" "$BACKUP/price_rules.json" 2>/dev/null || true

cp "$TMP/extract/agent.js" "$ROOT/agent.js"
cp "$TMP/extract/price_rules.json" "$ROOT/price_rules.json"

cd "$ROOT"
if docker compose version >/dev/null 2>&1; then
  docker compose up -d --force-recreate
elif command -v docker-compose >/dev/null 2>&1; then
  docker-compose up -d --force-recreate
else
  log "오류: docker compose 없음 - 기존 파일은 $BACKUP 에 백업됨"
  exit 1
fi

echo "$REMOTE_VERSION" > "$STATE"
log "업데이트 완료: v$REMOTE_VERSION"
