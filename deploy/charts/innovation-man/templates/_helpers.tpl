{{- define "innovation-man.name" -}}innovation-man{{- end }}
{{- define "innovation-man.fullname" -}}{{ .Release.Name }}{{- end }}
{{- define "innovation-man.labels" -}}
app.kubernetes.io/name: {{ include "innovation-man.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}
