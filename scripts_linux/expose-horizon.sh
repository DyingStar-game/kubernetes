#!/bin/bash
#
# expose-horizon.sh — Expose un service du cluster dev sur l'hote, de facon
#                     resistante aux redemarrages de pod.
#
# Pourquoi ce script plutot qu'un `kubectl port-forward` direct :
#
#   port-forward s'epingle a UN pod. Quand ce pod est remplace — ce que fait
#   ./scripts_linux/build-and-deploy.sh a chaque build — le relais casse. Et le processus ne
#   meurt pas forcement : il reste la, accepte les connexions locales, puis
#   echoue au moment de les transmettre ("lost connection to pod"). L'echec est
#   donc silencieux jusqu'a ce qu'un client s'y casse les dents.
#
#   Ici on surveille l'adresse d'endpoint du service : des qu'elle change
#   (nouveau pod), on relance le relais.
#
# L'ecoute se fait par defaut sur 0.0.0.0, pour que d'autres machines du LAN
# puissent se connecter en utilisant l'IP de cet hote. C'est le seul chemin
# possible pour une machine distante : ni l'IP du tunnel minikube ni l'IP du
# node (192.168.49.2) ne sont routables depuis le reste du reseau.
#
# Usage :
#   ./scripts_linux/expose-horizon.sh                  # horizon, port lu depuis le Service
#   ./scripts_linux/expose-horizon.sh --local          # n'ecoute que sur 127.0.0.1
#   ./scripts_linux/expose-horizon.sh livekit 7880     # un autre service / port
#
# Ctrl-C pour arreter.

set -uo pipefail
cd "$(dirname "$0")/.."

NAMESPACE="dyingstar"
EXPECTED_CONTEXT="minikube"
SERVICE="horizon"
PORT=""
ADDRESS="0.0.0.0"

# --- Arguments ---------------------------------------------------------------
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --local)   ADDRESS="127.0.0.1" ;;
    -h|--help) sed -n '3,27p' "$0" | sed 's/^#\{1,\} \{0,1\}//'; exit 0 ;;
    -*)        echo "Argument inconnu : $arg" >&2; exit 1 ;;
    *)         POSITIONAL+=("$arg") ;;
  esac
done
[ ${#POSITIONAL[@]} -ge 1 ] && SERVICE="${POSITIONAL[0]}"
[ ${#POSITIONAL[@]} -ge 2 ] && PORT="${POSITIONAL[1]}"

# --- Garde-fou : uniquement le cluster minikube local ------------------------
CURRENT_CONTEXT=$(kubectl config current-context 2>/dev/null || true)
if [ "$CURRENT_CONTEXT" != "$EXPECTED_CONTEXT" ]; then
  echo "❌ Erreur : le contexte kube courant est '${CURRENT_CONTEXT:-<aucun>}', attendu '$EXPECTED_CONTEXT'."
  echo "   Lancez : kubectl config use-context $EXPECTED_CONTEXT"
  exit 1
fi

# --- Resolution du service et du port ----------------------------------------
SVC_PORT=$(kubectl get svc "$SERVICE" -n "$NAMESPACE" \
  -o jsonpath='{.spec.ports[0].port}' 2>/dev/null || true)
if [ -z "$SVC_PORT" ]; then
  echo "❌ Erreur : service '$SERVICE' introuvable dans le namespace '$NAMESPACE'."
  echo "   Services disponibles :"
  kubectl get svc -n "$NAMESPACE" --no-headers 2>/dev/null | awk '{print "     " $1}'
  exit 1
fi
[ -z "$PORT" ] && PORT="$SVC_PORT"

# Pods prets derriere le service, dans l'ordre renvoye par l'EndpointSlice.
# On suit le pod precis auquel le relais est attache plutot que l'ensemble des
# endpoints : pendant un rolling update les deux pods coexistent brievement, et
# surveiller l'ensemble provoquerait deux relances au lieu d'une.
ready_pods() {
  kubectl get endpointslice -n "$NAMESPACE" -l "kubernetes.io/service-name=$SERVICE" \
    -o jsonpath='{range .items[*].endpoints[?(@.conditions.ready==true)]}{.targetRef.name}{" "}{end}' 2>/dev/null
}

PF_PID=""
cleanup() {
  echo ""
  echo "🛑 Arret du relais."
  [ -n "$PF_PID" ] && kill "$PF_PID" 2>/dev/null
  exit 0
}
trap cleanup INT TERM

echo "🔌 Relais vers $SERVICE:$SVC_PORT (namespace $NAMESPACE)"
if [ "$ADDRESS" = "0.0.0.0" ]; then
  LANIP=$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oP 'src \K\S+' || true)
  echo "   Depuis une autre machine : ws://${LANIP:-<ip-de-cet-hote>}:$PORT"
fi
echo "   Depuis cet hote          : ws://127.0.0.1:$PORT"
echo "   (Ctrl-C pour arreter)"
echo ""

# --- Boucle de supervision ---------------------------------------------------
while true; do
  pod=$(ready_pods | awk '{print $1}')
  if [ -z "$pod" ]; then
    echo "⏳ Aucun pod pret pour '$SERVICE' — nouvelle tentative dans 3s..."
    sleep 3
    continue
  fi

  echo "▶️  Relais actif  $ADDRESS:$PORT  ->  $pod:$SVC_PORT"
  kubectl port-forward --address "$ADDRESS" -n "$NAMESPACE" \
    "pod/$pod" "$PORT:$SVC_PORT" >/dev/null 2>&1 &
  PF_PID=$!

  # On relance des que le processus meurt OU que le pod suivi n'est plus pret :
  # port-forward peut survivre au remplacement du pod tout en etant devenu
  # inutilisable, et il faut alors le tuer nous-memes.
  while kill -0 "$PF_PID" 2>/dev/null; do
    sleep 2
    case " $(ready_pods) " in
      *" $pod "*) ;;
      *)
        echo "♻️  Pod $pod remplace — relance du relais"
        kill "$PF_PID" 2>/dev/null
        break
        ;;
    esac
  done

  wait "$PF_PID" 2>/dev/null
  PF_PID=""
  sleep 1
done
