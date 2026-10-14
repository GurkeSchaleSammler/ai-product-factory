{{- define "manager-man.name" -}}manager-man{{- end }}
{{- define "manager-man.fullname" -}}{{ .Release.Name }}{{- end }}
{{- define "manager-man.labels" -}}
app.kubernetes.io/name: {{ include "manager-man.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}
