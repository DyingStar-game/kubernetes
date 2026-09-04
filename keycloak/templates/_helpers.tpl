{{/*
Expand the name of the chart.
*/}}
{{- define "keycloak.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" | lower }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "keycloak.fullname" -}}
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
{{- define "keycloak.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" | lower }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "keycloak.labels" -}}
helm.sh/chart: {{ include "keycloak.chart" . }}
{{ include "keycloak.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "keycloak.selectorLabels" -}}
app.kubernetes.io/name: {{ include "keycloak.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Selector for the Keycloak server pods only.

`keycloak.selectorLabels` alone is NOT specific enough to select them: the
bundled PostgreSQL Deployment and the Discord bootstrap Job stamp those same two
labels on their pods (with an extra app.kubernetes.io/component). Used as a
Service selector it sends part of the HTTP traffic to PostgreSQL, and as a
Deployment selector it makes `kubectl exec deploy/keycloak` land in the wrong
container. Always select the server through this.
*/}}
{{- define "keycloak.serverSelectorLabels" -}}
{{ include "keycloak.selectorLabels" . }}
app.kubernetes.io/component: server
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "keycloak.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "keycloak.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Name of the admin secret (existing one if provided, otherwise the chart-managed one).
*/}}
{{- define "keycloak.adminSecretName" -}}
{{- if .Values.keycloak.existingSecret }}
{{- .Values.keycloak.existingSecret }}
{{- else }}
{{- printf "%s-admin" (include "keycloak.fullname" .) }}
{{- end }}
{{- end }}

{{/*
Name of the Discord IdP secret (existing one if provided, otherwise the chart-managed one).
*/}}
{{- define "keycloak.discordSecretName" -}}
{{- if .Values.keycloak.discord.existingSecret }}
{{- .Values.keycloak.discord.existingSecret }}
{{- else }}
{{- printf "%s-discord" (include "keycloak.fullname" .) }}
{{- end }}
{{- end }}

{{/*
Name of the PostgreSQL secret (existing one if provided, otherwise chart-managed).
Key: `password`.

Prefer an existing Secret. PostgreSQL only reads POSTGRES_PASSWORD during the
initial initdb: once the PVC holds a database, a new value in a chart-managed
Secret is applied to Keycloak but never to PostgreSQL, and Keycloak can no longer
log in. An existing Secret takes the value out of `helm upgrade`'s hands.
*/}}
{{- define "keycloak.postgresqlSecretName" -}}
{{- if .Values.postgresql.auth.existingSecret }}
{{- .Values.postgresql.auth.existingSecret }}
{{- else }}
{{- printf "%s-postgresql" (include "keycloak.fullname" .) }}
{{- end }}
{{- end }}
