#!/usr/bin/env bash
set -euo pipefail

NS="ai-product-factory"

k() {
  sudo k3s kubectl "$@"
}

secret_dir="$(mktemp -d)"
chmod 700 "$secret_dir"
trap 'rm -rf "$secret_dir"' EXIT
umask 077

prompt_secret() {
  local label="$1"
  local destination="$2"
  local value=""
  while [[ -z "$value" ]]; do
    read -r -s -p "$label: " value </dev/tty
    printf '\n' >/dev/tty
  done
  printf '%s' "$value" >"$destination"
  unset value
}

echo "Creating namespace $NS ..."
k create namespace "$NS" --dry-run=client -o yaml | k apply -f -

k -n "$NS" get secret innovation-man-secrets -o jsonpath='{.data.database-url}' | base64 -d > "$secret_dir/innovation-database-url"
prompt_secret "Innovation-Man DeepSeek API key" "$secret_dir/innovation-llm-api-key"
k -n "$NS" create secret generic innovation-man-secrets \
  --from-file=database-url="$secret_dir/innovation-database-url" \
  --from-file=llm-api-key="$secret_dir/innovation-llm-api-key" \
  --dry-run=client -o yaml | k apply -f -

k -n "$NS" get secret sales-man-secrets -o jsonpath='{.data.database-url}' | base64 -d > "$secret_dir/sales-database-url"
prompt_secret "Sales-Man DeepSeek API key" "$secret_dir/sales-llm-api-key"
k -n "$NS" create secret generic sales-man-secrets \
  --from-file=database-url="$secret_dir/sales-database-url" \
  --from-file=llm-api-key="$secret_dir/sales-llm-api-key" \
  --dry-run=client -o yaml | k apply -f -

k -n "$NS" get secret manager-man-secrets -o jsonpath='{.data.database-url}' | base64 -d > "$secret_dir/manager-database-url"
prompt_secret "Manager GitHub classic PAT" "$secret_dir/github-token"
prompt_secret "GurkeSchaleSammler infrastructure token (Helm/GitOps write)" "$secret_dir/infra-github-token"
prompt_secret "DeepSeek API key for product repositories" "$secret_dir/deepseek-api-key"
k -n "$NS" create secret generic manager-man-secrets \
  --from-file=database-url="$secret_dir/manager-database-url" \
  --from-file=github-token="$secret_dir/github-token" \
  --from-file=infra-github-token="$secret_dir/infra-github-token" \
  --from-file=deepseek-api-key="$secret_dir/deepseek-api-key" \
  --dry-run=client -o yaml | k apply -f -

read -r -p "GitHub username for GHCR: " ghcr_username </dev/tty
prompt_secret "GHCR classic PAT (read:packages)" "$secret_dir/ghcr-token"
ghcr_token="$(<"$secret_dir/ghcr-token")"
for secret_name in ghcr-innovation-man ghcr-sales-man ghcr-manager-man; do
  k -n "$NS" create secret docker-registry "$secret_name" \
    --docker-server=ghcr.io \
    --docker-username="$ghcr_username" \
    --docker-password="$ghcr_token" \
    --dry-run=client -o yaml | k apply -f -
done
unset ghcr_token ghcr_username

prompt_secret "Product GHCR token for sechssiebe67-wq (read:packages)" "$secret_dir/product-ghcr-token"
product_ghcr_token="$(<"$secret_dir/product-ghcr-token")"
k -n "$NS" create secret docker-registry ghcr-product-images \
  --docker-server=ghcr.io \
  --docker-username=sechssiebe67-wq \
  --docker-password="$product_ghcr_token" \
  --dry-run=client -o yaml | k apply -f -
unset product_ghcr_token

echo
echo "Created secrets:"
k -n "$NS" get secret \
  innovation-man-secrets \
  sales-man-secrets \
  manager-man-secrets \
  factory-migration-secrets \
  ghcr-innovation-man \
  ghcr-sales-man \
  ghcr-manager-man \
  ghcr-product-images \
  -o custom-columns=NAME:.metadata.name,TYPE:.type --no-headers

echo
echo "Secret setup complete. Values were not printed."
