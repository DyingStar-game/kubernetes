#!/bin/bash
#
# verify-service-auth.sh — Vérifie l'identité machine Keycloak du realm
#                          `dyingstar` et le non-contournement de /api/internal/*.
#
# Deux volets :
#   1. Toujours : décodage des JWT `client_credentials` obtenus auprès de
#      Keycloak (azp, aud, sub, preferred_username, rôles, exp-iat=300).
#   2. Si ECONOMIE_BASE_URL / SOCIAL_BASE_URL / MISSION_BASE_URL sont fournis :
#      les tests HTTP des APIs (200/201/403/401). Le test mutatif (credit) n'est
#      exécuté qu'avec MUTATING=1.
#
# Aucune valeur de secret n'est écrite sur disque ni affichée : les secrets sont
# lus depuis Kubernetes (ou passés via SVC_GAME_SECRET / SVC_MARKET_SECRET /
# SVC_MISSION_SECRET).
#
# Usage :
#   ./scripts_linux/verify-service-auth.sh
#   ISSUER=https://auth-preprod.dyingstar-game.com \
#     ECONOMIE_BASE_URL=http://economie.dyingstar.local \
#     SOCIAL_BASE_URL=http://social.dyingstar.local \
#     MISSION_BASE_URL=http://mission.dyingstar.local \
#     PLAYER_TOKEN="$PLAYER_JWT" \
#     ./scripts_linux/verify-service-auth.sh
#
# Variables :
#   ISSUER                 défaut http://auth.dyingstar.local
#   REALM                  défaut dyingstar
#   K8S_NAMESPACE          défaut keycloak
#   K8S_CONTEXT            contexte kubectl optionnel
#   SVC_GAME_SECRET        sinon lu depuis le Secret svc-game-client-secret
#   SVC_MARKET_SECRET      sinon lu depuis le Secret svc-market-client-secret
#   SVC_MISSION_SECRET     sinon lu depuis le Secret svc-mission-client-secret
#   ECONOMIE_BASE_URL      ex http://economie.dyingstar.local (sinon volet 2 sauté)
#   SOCIAL_BASE_URL        ex http://social.dyingstar.local
#   MISSION_BASE_URL       ex http://mission.dyingstar.local
#   PLAYER_UUID            défaut uuid v4 ; à remplacer par un vrai joueur
#   CORPORATION_UUID       défaut uuid v4
#   SOCIAL_PROBE_PATH      défaut /api/internal/health
#   MISSION_PROBE_PATH     défaut /api/internal/missions
#   PLAYER_TOKEN           JWT du launcher, pour le test de non-contournement
#   MUTATING=1             exécute POST wallet/credit (écrit au ledger)

set -uo pipefail

cd "$(dirname "$0")/.."

ISSUER="${ISSUER:-http://auth.dyingstar.local}"
REALM="${REALM:-dyingstar}"
K8S_NAMESPACE="${K8S_NAMESPACE:-keycloak}"
# UUID v4 valides : les APIs rejettent en 400 un UUID dont le nibble de version
# n'est pas 1-5 (l'ancien `...-0000-...` provoquait « playerId: Invalid UUID »).
PLAYER_UUID="${PLAYER_UUID:-00000000-0000-4000-8000-0000000000ff}"
CORPORATION_UUID="${CORPORATION_UUID:-00000000-0000-4000-8000-0000000000aa}"
SOCIAL_PROBE_PATH="${SOCIAL_PROBE_PATH:-/api/internal/health}"
MISSION_PROBE_PATH="${MISSION_PROBE_PATH:-/api/internal/missions}"
TOKEN_ENDPOINT="${ISSUER}/realms/${REALM}/protocol/openid-connect/token"
ECONOMIE_BASE_URL="${ECONOMIE_BASE_URL:-http://economie.dyingstar.local}"
SOCIAL_BASE_URL="${SOCIAL_BASE_URL:-http://social.dyingstar.local}"
MISSION_BASE_URL="${MISSION_BASE_URL:-http://mission.dyingstar.local}"
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
PASS=0; FAIL=0
ok()   { echo -e "  ${GREEN}[OK]${NC}    $1"; PASS=$((PASS+1)); }
ko()   { echo -e "  ${RED}[FAIL]${NC}  $1"; FAIL=$((FAIL+1)); }
info() { echo -e "  ${CYAN}[INFO]${NC}  $1"; }
sect() { echo -e "\n${CYAN}▶ $1${NC}"; }

need() { command -v "$1" >/dev/null 2>&1 || { echo "❌ outil requis manquant : $1"; exit 2; }; }
need curl
need jq
need base64

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

# Décode la payload d'un JWT (base64url, padding réajouté).
jwt_payload() {
  local jwt="$1" payload
  payload="$(printf '%s' "$jwt" | cut -d. -f2)"
  case $((${#payload} % 4)) in
    2) payload="${payload}==" ;;
    3) payload="${payload}=" ;;
  esac
  printf '%s' "$payload" | tr '_-' '/+' | base64 -d 2>/dev/null
}

fetch_secret() {
  local name="$1" override="$2" out
  if [ -n "$override" ]; then
    printf '%s' "$override"; return 0
  fi
  [ -n "${K8S_CONTEXT:-}" ] && out="$(kubectl --context "$K8S_CONTEXT" -n "$K8S_NAMESPACE" get secret "$name" -o jsonpath='{.data.secret}' 2>/dev/null)" \
                             || out="$(kubectl -n "$K8S_NAMESPACE" get secret "$name" -o jsonpath='{.data.secret}' 2>/dev/null)"
  if [ -z "$out" ]; then
    echo "❌ Secret $name introuvable dans le namespace $K8S_NAMESPACE (kubectl ?)." >&2
    return 1
  fi
  printf '%s' "$out" | base64 -d
}

# Client credentials -> access_token (echo). Échoue si jq ne trouve pas le token.
get_token() {
  local client_id="$1" secret="$2" resp
  resp="$(curl -s -X POST "$TOKEN_ENDPOINT" \
    -d grant_type=client_credentials \
    -d client_id="$client_id" \
    -d client_secret="$secret")"
  local tok
  tok="$(printf '%s' "$resp" | jq -r '.access_token // empty')"
  if [ -z "$tok" ]; then
    echo "    réponse du token endpoint : $(printf '%s' "$resp" | jq -c '{error,error_description}' 2>/dev/null)" >&2
    return 1
  fi
  printf '%s' "$tok"
}

check_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then ok "$label = $actual"; else ko "$label : attendu [$expected], obtenu [$actual]"; fi
}

check_contains() {
  local label="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then ok "$label contient $needle"; else ko "$label ne contient pas $needle (obtenu: $haystack)"; fi
}

check_absent() {
  local label="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then ko "$label ne doit PAS contenir $needle (obtenu: $haystack)"; else ok "$label ne contient pas $needle"; fi
}

aud_list() { jq -r 'if (.aud|type)=="array" then .aud[] else .aud end' 2>/dev/null; }

uuid_re='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

# Volet 1 : assertions JWT pour un client donné.
verify_token() {
  local client_id="$1" secret="$2" expected_username="service-account-$1"
  shift 2
  local expected_roles=("$@")

  sect "Token client_credentials — $client_id"
  local token payload
  token="$(get_token "$client_id" "$secret")" || { ko "obtention du token $client_id"; return; }
  payload="$(jwt_payload "$token")" || { ko "décodage du JWT $client_id"; return; }

  check_eq "azp" "$client_id" "$(printf '%s' "$payload" | jq -r '.azp')"
  check_eq "preferred_username" "$expected_username" "$(printf '%s' "$payload" | jq -r '.preferred_username // empty')"

  local sub; sub="$(printf '%s' "$payload" | jq -r '.sub')"
  if printf '%s' "$sub" | grep -qE "$uuid_re"; then ok "sub est un UUID ($sub)"; else ko "sub n'est pas un UUID ($sub)"; fi

  local lifespans; lifespans="$(printf '%s' "$payload" | jq -r '.exp - .iat')"
  check_eq "exp - iat" "300" "$lifespans"

  local auds; auds="$(printf '%s' "$payload" | aud_list | tr '\n' ' ')"
  info "aud = $auds"
  # Audiences attendues passées via AUD_EXPECT / AUD_ABSENT (voir appelants).
  for a in ${AUD_EXPECT:-}; do check_contains "aud" "$a" "$(printf '%s' "$payload" | aud_list)"; done
  for a in ${AUD_ABSENT:-}; do check_absent "aud" "$a" "$(printf '%s' "$payload" | aud_list)"; done

  # Le mapper de rôles du realm importé émet le claim plat `roles`
  # (04-realm-import.yaml, scope `roles`), pas `realm_access.roles`.
  local roles; roles="$(printf '%s' "$payload" | jq -r '(.realm_access.roles // .roles // [])[]' 2>/dev/null)"
  for r in "${expected_roles[@]}"; do
    if printf '%s\n' "$roles" | grep -qxF -- "$r"; then ok "rôle présent : $r"; else ko "rôle manquant : $r"; fi
  done
}

# Volet 2 : tests HTTP. Retourne "<code> <fichier-body>".
# $4 = corps JSON optionnel (envoyé avec Content-Type: application/json).
http_code() {
  local method="$1" url="$2" token="${3:-}" data="${4:-}" body_file
  body_file="$(mktemp)"
  local code args=(-s -o "$body_file" -w '%{http_code}' -X "$method")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  if [ -n "$data" ]; then
    args+=(-H "Content-Type: application/json" -d "$data")
  fi
  code="$(curl "${args[@]}" "$url")"
  printf '%s %s' "$code" "$body_file"
}

expect_code() {
  local label="$1" expected="$2" method="$3" url="$4" token="${5:-}" data="${6:-}"
  local out code file
  out="$(http_code "$method" "$url" "$token" "$data")"; code="${out%% *}"; file="${out#* }"
  if [ "$code" = "$expected" ]; then
    ok "$label : HTTP $code"
  else
    ko "$label : attendu HTTP $expected, obtenu $code — $(head -c 300 "$file" 2>/dev/null)"
  fi
  rm -f "$file"
}

# Comme expect_code, mais accepte plusieurs codes (ex. un service qui répond 401
# plutôt que 403 sur une audience absente). `expected_codes` est une liste
# séparée par des espaces : "401 403".
expect_code_any() {
  local label="$1" expected_codes="$2" method="$3" url="$4" token="${5:-}" data="${6:-}"
  local out code file
  out="$(http_code "$method" "$url" "$token" "$data")"; code="${out%% *}"; file="${out#* }"
  case " $expected_codes " in
    *" $code "*) ok "$label : HTTP $code" ;;
    *) ko "$label : attendu l'un de [$expected_codes], obtenu $code — $(head -c 300 "$file" 2>/dev/null)" ;;
  esac
  rm -f "$file"
}

# --------------------------------------------------------------------------

echo ""
echo "======================================================"
echo "  Vérification identité machine Keycloak — $REALM"
echo "======================================================"
info "issuer  : $ISSUER"
info "endpoint: $TOKEN_ENDPOINT"

# Rôles (source unique : contrat API)
ECON_ROLES=(economie:wallet:read economie:wallet:ensure economie:wallet:credit economie:wallet:debit economie:corporation:read economie:corporation:manage)
SOCIAL_ROLES=(social:profile:write social:player:write social:corporation:read social:corporation:write social:sanctions:read social:reputation:write)
# L'API mission exige `mission:read` / `mission:write` / `mission:complete`
# (noms exacts renvoyés dans ses erreurs 403), plus `mission:manage`.
MISSION_ROLES=(mission:read mission:write mission:complete mission:manage)
ALL_ROLES=("${ECON_ROLES[@]}" "${SOCIAL_ROLES[@]}" "${MISSION_ROLES[@]}")
MARKET_ROLES=(economie:wallet:read economie:wallet:credit economie:wallet:debit)
# svc-mission est un caller (economie + social), pas un appelé : il ne porte
# jamais d'audience mission-api ni de rôle mission:*.
MISSION_SVC_ROLES=(economie:wallet:read economie:wallet:credit economie:wallet:debit social:corporation:read)

SVC_GAME_SECRET="$(fetch_secret svc-game-client-secret "${SVC_GAME_SECRET:-}")" || exit 1
SVC_MARKET_SECRET="$(fetch_secret svc-market-client-secret "${SVC_MARKET_SECRET:-}")" || exit 1
SVC_MISSION_SECRET="$(fetch_secret svc-mission-client-secret "${SVC_MISSION_SECRET:-}")" || exit 1

AUD_EXPECT="economie-api social-api mission-api" AUD_ABSENT="" verify_token svc-game "$SVC_GAME_SECRET" "${ALL_ROLES[@]}"
GAME_TOKEN="$(get_token svc-game "$SVC_GAME_SECRET" 2>/dev/null || true)"

AUD_EXPECT="economie-api" AUD_ABSENT="social-api" verify_token svc-market "$SVC_MARKET_SECRET" "${MARKET_ROLES[@]}"
MARKET_TOKEN="$(get_token svc-market "$SVC_MARKET_SECRET" 2>/dev/null || true)"

AUD_EXPECT="economie-api social-api" AUD_ABSENT="mission-api" verify_token svc-mission "$SVC_MISSION_SECRET" "${MISSION_SVC_ROLES[@]}"
MISSION_TOKEN="$(get_token svc-mission "$SVC_MISSION_SECRET" 2>/dev/null || true)"

# --------------------------------------------------------------------------
# Volet 2 : APIs (si URLs fournies)
# --------------------------------------------------------------------------
if [ -n "${ECONOMIE_BASE_URL:-}" ] || [ -n "${SOCIAL_BASE_URL:-}" ] || [ -n "${MISSION_BASE_URL:-}" ]; then
  : "${ECONOMIE_BASE_URL:=}"
  : "${SOCIAL_BASE_URL:=}"
  : "${MISSION_BASE_URL:=}"

  if [ -n "$ECONOMIE_BASE_URL" ]; then
    sect "API economie ($ECONOMIE_BASE_URL)"
    expect_code "svc-game GET wallet"                200 GET  "$ECONOMIE_BASE_URL/api/internal/players/$PLAYER_UUID/wallet" "$GAME_TOKEN"
    if [ "${MUTATING:-0}" = "1" ]; then
      # L'API economie exige un corps {amount: <nombre>} (entier, unités mineures).
      expect_code "svc-game POST wallet/credit"     201 POST "$ECONOMIE_BASE_URL/api/internal/players/$PLAYER_UUID/wallet/credit" "$GAME_TOKEN" '{"amount":1}'
      info "vérifier en base que la ligne du ledger porte caller = svc-game"
    else
      info "MUTATING=1 non positionné : POST wallet/credit sauté (aucune écriture)"
    fi
    expect_code "svc-market PUT corp settings"      403 PUT  "$ECONOMIE_BASE_URL/api/internal/corporations/$CORPORATION_UUID/settings" "$MARKET_TOKEN"
  fi

  if [ -n "$SOCIAL_BASE_URL" ]; then
    sect "API social ($SOCIAL_BASE_URL)"
    # svc-market n'a pas l'audience social-api : le social rejette le token,
    # en 401 (audience invalide) ou 403 selon l'implémentation du service.
    expect_code_any "svc-market sur endpoint social" "401 403" GET "$SOCIAL_BASE_URL$SOCIAL_PROBE_PATH" "$MARKET_TOKEN"
    # svc-game a l'audience social-api : on ne teste que si le chemin sonde
    # existe réellement, sinon 404 est un résultat acceptable.
    if [ -n "$GAME_TOKEN" ]; then
      info "sonde svc-game social sur $SOCIAL_PROBE_PATH (200/404 attendu)"
    fi
  fi

  if [ -n "$MISSION_BASE_URL" ]; then
    sect "API mission ($MISSION_BASE_URL)"
    # Health public (aucun token) : prouve que le service répond.
    expect_code "mission /api/health (public)" 200 GET "$MISSION_BASE_URL/api/health"
    # svc-game est le seul caller autorisé et porte l'audience mission-api +
    # le rôle mission:read : l'endpoint interne répond 200.
    expect_code "svc-game GET $MISSION_PROBE_PATH" 200 GET "$MISSION_BASE_URL$MISSION_PROBE_PATH" "$GAME_TOKEN"
    # Sans token : jamais 200 (non-contournement).
    expect_code "mission sans token" 401 GET "$MISSION_BASE_URL$MISSION_PROBE_PATH"
    # svc-market n'a ni l'audience mission-api ni de rôle mission:* : rejeté.
    expect_code_any "svc-market sur endpoint mission" "401 403" GET "$MISSION_BASE_URL$MISSION_PROBE_PATH" "$MARKET_TOKEN"
    # svc-mission n'appelle pas l'API mission (il n'est ni caller ni audiencé).
    expect_code_any "svc-mission sur endpoint mission" "401 403" GET "$MISSION_BASE_URL$MISSION_PROBE_PATH" "$MISSION_TOKEN"
  fi
else
  info "ECONOMIE_BASE_URL / SOCIAL_BASE_URL / MISSION_BASE_URL absents : volet HTTP sauté (volet JWT seul)."
fi

# --------------------------------------------------------------------------
# Non-contournement (si une API economie est joignable)
# --------------------------------------------------------------------------
if [ -n "${ECONOMIE_BASE_URL:-}" ]; then
  sect "Non-contournement"
  # Token joueur (launcher) sur /api/internal/* : jamais 200.
  if [ -n "${PLAYER_TOKEN:-}" ]; then
    out="$(http_code GET "$ECONOMIE_BASE_URL/api/internal/players/$PLAYER_UUID/wallet" "$PLAYER_TOKEN")"
    code="${out%% *}"; rm -f "${out#* }"
    if [ "$code" = "401" ] || [ "$code" = "403" ]; then ok "token joueur rejeté (HTTP $code)"; else ko "token joueur a obtenu HTTP $code (attendu 401/403)"; fi
  else
    info "PLAYER_TOKEN non fourni : test token joueur sauté"
  fi
  # Sans token.
  expect_code "sans token"      401 GET "$ECONOMIE_BASE_URL/api/internal/players/$PLAYER_UUID/wallet"
  # Token falsifié (signature corrompue).
  expect_code "token falsifié"  401 GET "$ECONOMIE_BASE_URL/api/internal/players/$PLAYER_UUID/wallet" "${GAME_TOKEN}x"
  # clientId hors allowlist : simulé par le token joueur (azp=dyingstar-game) déjà couvert.
fi

echo ""
echo "======================================================"
if [ "$FAIL" -eq 0 ]; then
  echo -e "${GREEN}  $PASS assertions OK — aucune régression.${NC}"
  echo "======================================================"
  exit 0
else
  echo -e "${RED}  $FAIL assertion(s) en échec / $PASS OK.${NC}"
  echo "======================================================"
  exit 1
fi
