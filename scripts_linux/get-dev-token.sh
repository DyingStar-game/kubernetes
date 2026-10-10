#!/bin/bash
#
# get-dev-token.sh — Obtient un access token Joueur (password grant) dans le
#                    realm dev-local `dyingstar`.
#
# Deux modes :
#   * par défaut        : on CRÉE un joueur au hasard (pseudo + mot de passe
#                         aléatoires, realm role `player`), puis on en obtient
#                         le token. Chaque appel donne un pseudo différent.
#   * --existing / -e   : on s'authentifie sur un compte EXISTANT
#                         (USERNAME/PASSWORD, défaut devplayer/devplayer).
#                         Demander aussi en posant USERNAME=xxx.
#
# Pièges du realm que ce script contourne (les trois sont faciles à rater) :
#
#   1. `admin-cli` ne doit JAMAIS servir de client joueur. Il accepte aussi le
#      password grant, mais sans default client scope : Keycloak 26.7 émet un
#      "lightweight access token" dont la payload ne contient que
#      exp/iat/jti/iss/typ/azp/sid/scope — ni `sub`, ni `preferred_username`,
#      ni `realm_access`. JWT valide mais vide, donc inutilisable.
#      Le client de dev `dyingstar-dev` ("DyingStar dev CLI tokens (DEV ONLY)",
#      public, directAccessGrants) porte bien openid/roles/profile/email.
#
#   2. Le *user profile* du realm exige `email` + `firstName` + `lastName`
#      (GET /admin/realms/dyingstar/users/profile : `required.roles=[user]`).
#      Un utilisateur créé SANS email semble créé (201) mais le password grant
#      échoue en 400 `invalid_grant` / "Account is not fully set up", avec un
#      event `resolve_required_actions` et un `requiredActions` vide côté API —
#      le diagnostic est trompeur. Ce script remplit donc toujours les trois.
#
#   3. L'assignation de realm role exige `{id, name}` (pas `name` seul, qui
#      renvoie 404 "Role not found"). On résout l'id via
#      GET /admin/realms/<realm>/roles/<role> avant le POST role-mappings.
#
# Le compte de dev `devplayer` / `devplayer` n'existe que dans le dev-local,
# jamais ailleurs. `registrationAllowed=false` : l'auto-inscription est
# désactivée, d'où le recours à l'API admin pour créer un joueur.
#
# Usage :
#   ./scripts_linux/get-dev-token.sh                    # joueur aléatoire
#   ./scripts_linux/get-dev-token.sh --raw              # token brut
#   ./scripts_linux/get-dev-token.sh --random           # idem (explicite)
#
#   ./scripts_linux/get-dev-token.sh --existing         # compte devplayer
#   USERNAME=autre-joueur PASSWORD=... ./scripts_linux/get-dev-token.sh
#
# Par défaut c'est un joueur NEUF à chaque appel : aucun compte partagé n'est
# pollué, et chaque exécution donne un pseudo différent.
#
# Variables :
#   ISSUER          défaut http://auth.dyingstar.local (Traefik, hosts_config.txt)
#   REALM           défaut dyingstar
#   CLIENT_ID       défaut dyingstar-dev
#   USERNAME        compte existant ; si définie, désigne un compte précis
#   PASSWORD        mot de passe du compte existant (DEV ONLY)
#   SCOPE           défaut vide = scopes par défaut du client
#   PREFIX          défaut dev-            (pseudo aléatoire)
#   PLAYER_ROLE     défaut player          (realm role assigné au compte créé)
#   ADMIN_USER      défaut admin           (API admin, création uniquement)
#   ADMIN_PASSWORD  défaut devpass         (DEV ONLY)
#
# Sortie (mode défaut) : résumé des claims utiles + garde-fous, puis une ligne
# export prête à copier : export PLAYER_TOKEN='eyJ...'.
# Sortie (--raw) : uniquement la chaîne access_token (pour un $(...)).

set -uo pipefail

cd "$(dirname "$0")/.."

# L'appelant désigne-t-il un compte existant (via USERNAME/PASSWORD) plutôt que
# d'en créer un neuf ? À capturer AVANT d'appliquer les valeurs par défaut :
# ${VAR+set} n'est non vide que si la variable est définie, sinon on obtiendrait
# toujours "devplayer" et le joueur aléatoire ne serait jamais demandé.
USER_EXPLICIT=0
[ -n "${USERNAME+set}" ] && USER_EXPLICIT=1

ISSUER="${ISSUER:-http://auth.dyingstar.local}"
REALM="${REALM:-dyingstar}"
CLIENT_ID="${CLIENT_ID:-dyingstar-dev}"
USERNAME="${USERNAME:-devplayer}"
PASSWORD="${PASSWORD:-devplayer}"
SCOPE="${SCOPE:-}"
PREFIX="${PREFIX:-dev-}"
PLAYER_ROLE="${PLAYER_ROLE:-player}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-devpass}"

TOKEN_ENDPOINT="${ISSUER}/realms/${REALM}/protocol/openid-connect/token"
MASTER_TOKEN_ENDPOINT="${ISSUER}/realms/master/protocol/openid-connect/token"
ADMIN_BASE="${ISSUER}/admin/realms/${REALM}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}[OK]${NC}    $1"; }
ko()   { echo -e "  ${RED}[FAIL]${NC}  $1"; }
info() { echo -e "  ${CYAN}[INFO]${NC}  $1"; }
warn() { echo -e "  ${YELLOW}[WARN]${NC}  $1"; }
sect() { echo -e "\n${CYAN}▶ $1${NC}"; }

need() { command -v "$1" >/dev/null 2>&1 || { echo "❌ outil requis manquant : $1"; exit 2; }; }
need curl
need jq
need base64

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Décode la payload d'un JWT (base64url, padding réajouté). Même implémentation
# que verify-service-auth.sh#jwt_payload : chaque script reste autonome seul.
jwt_payload() {
  local jwt="$1" payload
  payload="$(printf '%s' "$jwt" | cut -d. -f2)"
  case $((${#payload} % 4)) in
    2) payload="${payload}==" ;;
    3) payload="${payload}=" ;;
  esac
  printf '%s' "$payload" | tr '_-' '/+' | base64 -d 2>/dev/null
}

# Rend une erreur Keycloak lisible à partir d'une réponse JSON (ou vide).
kc_error() {
  local body="$1"
  if [ -n "$body" ] && printf '%s' "$body" | jq -e . >/dev/null 2>&1; then
    printf '%s' "$body" | jq -r 'if .error_description then "\(.error) — \(.error_description)" elif .error then .error else empty end' 2>/dev/null
  else
    printf '%s' "$body"
  fi
}

# Aléatoire : $1 = longueur, $2 = alphabet (défaut a-z0-9). Utilise $RANDOM,
# présent dans tout bash ; pas de dépendance à openssl/head -c.
rand_from() {
  local len="$1" alphabet="${2:-abcdefghijklmnopqrstuvwxyz0123456789}" out="" i
  for ((i = 0; i < len; i++)); do
    out+="${alphabet:$((${#alphabet} > 0 ? RANDOM % ${#alphabet} : 0)):1}"
  done
  printf '%s' "$out"
}

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
RAW=0
RANDOM_USER=0
EXISTING=0
for arg in "$@"; do
  case "$arg" in
    --raw|-r)            RAW=1 ;;
    --random|-n|--new|--fresh) RANDOM_USER=1 ;;
    --existing|-e|--player)    EXISTING=1 ;;
    --help|-h)
      sed -n '2,/^set -uo/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "❌ argument inconnu : $arg (voir --help)"
      exit 2 ;;
  esac
done

# Comportement par défaut : un joueur NEUF à chaque appel. On n'utilise un
# compte existant que si l'appelant le demande (--existing) ou désigne USERNAME.
# Explicite --random l'emporte sur --existing.
if [ "$EXISTING" -eq 0 ] && [ "$USER_EXPLICIT" -eq 0 ] && [ "$RANDOM_USER" -eq 0 ]; then
  RANDOM_USER=1
fi

# ---------------------------------------------------------------------------
# --random : créer un joueur aléatoire via l'API admin
# ---------------------------------------------------------------------------
if [ "$RANDOM_USER" -eq 1 ]; then
  # admin-cli n'a pas de default client scope, mais pour l'API admin on n'a
  # besoin que d'un token "master" : les claims utilisateur sont ignorés.
  admin_token="$(curl -s -X POST "$MASTER_TOKEN_ENDPOINT" \
    -d grant_type=password \
    -d client_id=admin-cli \
    -d username="$ADMIN_USER" \
    -d password="$ADMIN_PASSWORD" | jq -r '.access_token // empty')"
  if [ -z "$admin_token" ]; then
    echo "❌ Échec d'authentification admin (user=$ADMIN_USER) sur le realm master."
    exit 1
  fi

  # Pseudo + mot de passe. La politique du realm (length(10) and notUsername
  # and notEmail and passwordHistory(3)) impose : >= 10 caractères, distinct du
  # pseudo et de l'email. Un préfixe "Str0ng-" + 16 aléatoires le garantit.
  pseudo="${PREFIX}$(rand_from 8)"
  pw="Str0ng-$(rand_from 16 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')"

  if [ "$RAW" -ne 1 ]; then
    sect "Création d'un joueur aléatoire"
    info "pseudo    $pseudo"
    info "password  $pw"
    info "realm     $REALM   role: $PLAYER_ROLE"
  fi

  # user profile exige email + firstName + lastName : sans eux le password
  # grant échoue plus loin en "Account is not fully set up" (cf. en-tête).
  user_json="$(jq -n --arg u "$pseudo" --arg p "$pw" --arg e "${pseudo}@dyingstar.local" '{
    username: $u, enabled: true, emailVerified: true,
    email: $e, firstName: "Dev", lastName: $u,
    credentials: [{ type: "password", value: $p, temporary: false }]
  }')"

  create_out="$(curl -s -o /dev/null -w '%{http_code}' -D - -X POST "$ADMIN_BASE/users" \
    -H "Authorization: Bearer $admin_token" \
    -H "Content-Type: application/json" \
    -d "$user_json" 2>/dev/null)"
  create_code="$(printf '%s' "$create_out" | tail -1)"
  location="$(printf '%s' "$create_out" | tr -d '\r' | awk -F': ' 'tolower($1)=="location"{print $2}')"

  if [ "$create_code" = "409" ]; then
    echo "❌ Le pseudo $pseudo existe déjà (collision). Relance le script."
    exit 1
  elif [ "$create_code" != "201" ] || [ -z "$location" ]; then
    echo "❌ Création de l'utilisateur $pseudo échouée (HTTP $create_code)."
    exit 1
  fi
  uid="$(printf '%s' "$location" | sed 's#.*/##')"
  [ "$RAW" -ne 1 ] && ok "utilisateur créé (uid $uid)"

  # Assignation du realm role. L'API exige {id, name} : name seul -> 404.
  role_id="$(curl -s -H "Authorization: Bearer $admin_token" \
    "$ADMIN_BASE/roles/$PLAYER_ROLE" | jq -r '.id // empty')"
  if [ -z "$role_id" ]; then
    echo "❌ Realm role $PLAYER_ROLE introuvable dans $REALM."
    exit 1
  fi

  assign_code="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    "$ADMIN_BASE/users/$uid/role-mappings/realm" \
    -H "Authorization: Bearer $admin_token" \
    -H "Content-Type: application/json" \
    -d "[$(jq -n --arg id "$role_id" --arg n "$PLAYER_ROLE" '{id:$id, name:$n}')]")"
  if [ "$assign_code" != "204" ]; then
    echo "❌ Assignation du rôle $PLAYER_ROLE échouée (HTTP $assign_code)."
    exit 1
  fi
  [ "$RAW" -ne 1 ] && ok "realm role $PLAYER_ROLE assigné"

  USERNAME="$pseudo"
  PASSWORD="$pw"
  if [ "$RAW" -ne 1 ]; then
    echo
    info "Réutilisable : USERNAME=$pseudo PASSWORD='$pw' $0"
  fi
fi

# ---------------------------------------------------------------------------
# Password grant sur le client joueur
# ---------------------------------------------------------------------------
resp="$(curl -s -X POST "$TOKEN_ENDPOINT" \
  -d grant_type=password \
  -d client_id="$CLIENT_ID" \
  -d username="$USERNAME" \
  -d password="$PASSWORD" \
  ${SCOPE:+-d "scope=$SCOPE"})"

token="$(printf '%s' "$resp" | jq -r '.access_token // empty')"
if [ -z "$token" ]; then
  err="$(kc_error "$resp")"
  if [ "$RAW" -eq 1 ]; then
    printf '%s\n' "${err:-$resp}" >&2
    exit 1
  fi
  echo "❌ Échec du password grant (client_id=$CLIENT_ID, username=$USERNAME)"
  [ -n "$err" ] && echo "   $err"
  echo "   Vérifie que le compte a un email, firstName et lastName renseignés"
  echo "   (user profile du realm : required.roles=[user]) — cf. en-tête du script."
  exit 1
fi

if [ "$RAW" -eq 1 ]; then
  printf '%s' "$token"
  exit 0
fi

# ---------------------------------------------------------------------------
# Résumé + garde-fous + ligne export
# ---------------------------------------------------------------------------
payload="$(jwt_payload "$token")"
if [ -z "$payload" ]; then
  echo "❌ Token obtenu mais payload illisible (jwt_payload a échoué)."
  exit 1
fi

sect "Token joueur — client $CLIENT_ID"
info "endpoint    $TOKEN_ENDPOINT"
info "realm       $REALM"
info "utilisateur $USERNAME"
echo

sect "Claims utiles"
printf '%s' "$payload" | jq -r '
  [
    ["azp", .azp],
    ["sub", .sub],
    ["preferred_username", .preferred_username],
    ["email", .email],
    ["realm_access.roles", (.realm_access.roles // [] | join(", "))],
    ["scope", .scope],
    ["aud", (if .aud == null then "(absent)" else
              (if (.aud|type) == "array" then (.aud|join(",")) else .aud end)
            end)]
  ] | .[] | "  \(.[0]) = \(.[1])"
' <<< "$payload"

exp="$(printf '%s' "$payload" | jq -r '.exp // 0')"
if [ "$exp" != "0" ] && [ "$exp" != "null" ]; then
  exp_h="$(( ( exp - $(date +%s) ) / 3600 ))"
  exp_date="$(date -d "@$exp" '+%Y-%m-%d %H:%M:%S %Z' 2>/dev/null \
    || date -r "$exp" '+%Y-%m-%d %H:%M:%S %Z' 2>/dev/null \
    || echo "$exp")"
  echo
  info "expires_in $(printf '%s' "$resp" | jq -r '.expires_in') s (~${exp_h} h, jusqu'à $exp_date)"
fi

echo
sect "Garde-fous"

sub="$(printf '%s' "$payload" | jq -r '.sub // empty')"
uname="$(printf '%s' "$payload" | jq -r '.preferred_username // empty')"
aud="$(printf '%s' "$payload" | jq -r '.aud // empty')"

if [ -z "$sub" ] || [ -z "$uname" ]; then
  ko "lightweight token détecté : sub/preferred_username absents (client_id=$CLIENT_ID ?)"
  warn "Utilise $CLIENT_ID (dyingstar-dev), pas admin-cli : ce dernier n'a aucun"
  warn "default client scope et Keycloak 26.7 émet un JWT sans claims utilisateur."
else
  ok "claims utilisateur présents (sub + preferred_username)"
fi

if [ -z "$aud" ]; then
  warn "claim 'aud' absent — refusé sur /api/internal/* des APIs (azp non allowlisté)."
  warn "Valide pour les endpoints joueur et pour MQTT (JWT en username)."
else
  ok "claim 'aud' présent : $aud"
fi

echo
sect "Export (copier-coller)"
echo "export PLAYER_TOKEN='$token'"

echo
info "Usage : export PLAYER_TOKEN=... puis curl -H \"Authorization: Bearer \$PLAYER_TOKEN\" ..."
