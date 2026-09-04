{{/*
Expand the name of the chart.
*/}}
{{- define "nextcloud-ds.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" | lower }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "nextcloud-ds.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" | lower }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" | lower }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" | lower }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "nextcloud-ds.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" | lower }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "nextcloud-ds.labels" -}}
helm.sh/chart: {{ include "nextcloud-ds.chart" . }}
{{ include "nextcloud-ds.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "nextcloud-ds.selectorLabels" -}}
app.kubernetes.io/name: {{ include "nextcloud-ds.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Name of the PV/PVC backed by the TrueNAS NFS export.
PersistentVolumes are cluster-scoped, so the namespace is part of the PV name.
*/}}
{{- define "nextcloud-ds.dataPvName" -}}
{{- printf "%s-%s-data" .Release.Namespace (include "nextcloud-ds.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "nextcloud-ds.dataPvcName" -}}
{{- printf "%s-data" (include "nextcloud-ds.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Name of the OIDC secret (existing one if provided, otherwise the chart-managed one).
NOTE: the chart-managed name is also hard-coded in values.yaml under
nextcloud.nextcloud.extraEnv, because Helm cannot template subchart values.
Keep both in sync.
*/}}
{{- define "nextcloud-ds.oidcSecretName" -}}
{{- if .Values.oidc.existingSecret }}
{{- .Values.oidc.existingSecret }}
{{- else }}
{{- printf "%s-oidc" (include "nextcloud-ds.fullname" .) }}
{{- end }}
{{- end }}

{{/*
Name of the PostgreSQL secret (existing one if provided, otherwise chart-managed).
Keys: db-username / db-password / db-database — the key names the upstream
Nextcloud chart expects under externalDatabase.existingSecret.
NOTE: also hard-coded in values.yaml (nextcloud.externalDatabase.existingSecret.secretName).
*/}}
{{- define "nextcloud-ds.postgresqlSecretName" -}}
{{- if .Values.postgresql.auth.existingSecret }}
{{- .Values.postgresql.auth.existingSecret }}
{{- else }}
{{- printf "%s-postgresql" (include "nextcloud-ds.fullname" .) }}
{{- end }}
{{- end }}

{{/*
Name of the Redis secret (existing one if provided, otherwise chart-managed).
NOTE: also hard-coded in values.yaml (nextcloud.externalRedis.existingSecret.secretName).
*/}}
{{- define "nextcloud-ds.redisSecretName" -}}
{{- if .Values.redis.auth.existingSecret }}
{{- .Values.redis.auth.existingSecret }}
{{- else }}
{{- printf "%s-redis" (include "nextcloud-ds.fullname" .) }}
{{- end }}
{{- end }}

{{/*
`kubectl` invocation printed in NOTES.txt, with the kube-context pinned.
This workspace has two contexts (`dyingstar` and `minikube`), so a bare kubectl
would happily run against whichever one happens to be current.
Set kubeContext to "" to leave the flag out.
*/}}
{{- define "nextcloud-ds.kubectl" -}}
kubectl {{ with .Values.kubeContext }}--context={{ . }} {{ end }}-n {{ .Release.Namespace }}
{{- end }}
