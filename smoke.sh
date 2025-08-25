#!/usr/bin/env bash
set -u
BASE=${1:-http://localhost:3000}
pass=0; fail=0
t(){ name="$1"; method="$2"; url="$3"; body="${4:-}";
  if [ "$method" = "GET" ]; then code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE$url");
  else code=$(curl -s -o /dev/null -w "%{http_code}" -H "content-type: application/json" -d "$body" -X "$method" "$BASE$url"); fi
  if [ "$code" = "200" ]; then echo "✅ $name ($url) - 200"; pass=$((pass+1)); else echo "❌ $name ($url) - $code"; fail=$((fail+1)); fi
}
t health GET /healthz
t ping_store GET /shopify/ping
t ping_admin GET /shopify-admin/ping
t chat POST /chat '{"message":"hello from smoke"}'
echo "— result: $pass passed, $fail failed"
exit $fail
