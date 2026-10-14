{{- define "sales-man.name" -}}sales-man{{- end }}
{{- define "sales-man.fullname" -}}{{ .Release.Name }}{{- end }}
{{- define "sales-man.labels" -}}
app.kubernetes.io/name: {{ include "sales-man.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}
