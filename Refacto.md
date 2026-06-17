# on every start project

minikube start

minikube mount $PWD:/mnt/local-repo.git > /dev/null 2>&1 &

minikube tunnel  # ! on other terminal

get service traefik external ip  and add in host file : 

example :
```
10.104.207.169  horizon.dyingstar.local
10.104.207.169  argocd.dyingstar.local
```
# ON firs install 

# 1. Ajoute le dépôt Helm officiel d'ArgoCD
helm repo add argo https://argoproj.github.io/argo-helm

# 2. Mets à jour tes dépôts locaux
helm repo update

# 3. Installe ArgoCD avec la configuration pour ton mount Minikube
helm install argocd argo/argo-cd \
  --namespace argocd \
  --create-namespace \
  -f argocd/values.yaml \
  -f argocd/values-dev-local.yaml 

kubectl apply -f argocd/root-app-dev.yaml
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.5.1/standard-install.yaml


# use local image

eval $(minikube -p minikube docker-env)
docker build -t mon-projet/frontend:local .


# cmd argocd in pod argoserver

ARGOCD_PASSWORD=$(kubectl get secret argocd-initial-admin-secret -n argocd -o jsonpath="{.data.password}" | base64 -d)


kubectl exec -n argocd deploy/argocd-server -c server -- \
  sh -c "argocd login localhost:8080 --username admin --password $ARGOCD_PASSWORD --insecure && \
          argocd app set horizon --source-position 1 -p image.repository='' -p image.tag='local' -p image.pullPolicy='Never'"


kubectl exec -n argocd deploy/argocd-server -c server -- \
  sh -c "argocd login localhost:8080 --username admin --password $ARGOCD_PASSWORD --insecure && \
          argocd app set horizon --source-position 1 -p image.repository -p image.tag -p image.pullPolicy"



# telepresence 

telepresence connect --namespace dyingstar

telepresence list

telepresence intercept godotserver --port 8980

telepresence leave godotserver

telepresence quit