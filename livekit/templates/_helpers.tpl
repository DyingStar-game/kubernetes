{{/*
Expand the name of the chart.
*/}}
{{- define "livekit.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" | lower }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "livekit.fullname" -}}
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
{{- define "livekit.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" | lower }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "livekit.labels" -}}
helm.sh/chart: {{ include "livekit.chart" . }}
{{ include "livekit.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "livekit.selectorLabels" -}}
app.kubernetes.io/name: {{ include "livekit.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "livekit.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "livekit.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Name of the API key Secret (existing one if provided, otherwise the chart-managed one).
Holds LIVEKIT_API_KEY and LIVEKIT_API_SECRET — also consumed by horizonserver.
*/}}
{{- define "livekit.keysSecretName" -}}
{{- if .Values.livekit.existingKeysSecret }}
{{- .Values.livekit.existingKeysSecret }}
{{- else }}
{{- printf "%s-keys" (include "livekit.fullname" .) }}
{{- end }}
{{- end }}

{{/*
Name of the Redis password Secret.
*/}}
{{- define "livekit.redisSecretName" -}}
{{- if .Values.redis.existingSecret }}
{{- .Values.redis.existingSecret }}
{{- else }}
{{- printf "%s-redis" (include "livekit.fullname" .) }}
{{- end }}
{{- end }}

{{/*
Name of the TURN TLS Secret (cert/key) — required when livekit.turn.enabled and
livekit.turn.tls is true. Always provisioned out-of-band (cert-manager or manual).
*/}}
{{- define "livekit.turnTlsSecretName" -}}
{{- default (printf "%s-turn-tls" (include "livekit.fullname" .)) .Values.livekit.turn.tlsSecretName }}
{{- end }}
