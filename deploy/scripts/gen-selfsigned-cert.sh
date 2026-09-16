#!/usr/bin/env bash
# ============================================================================
# 生成自签 TLS 证书(内网联调 / 压测环境用)
# ----------------------------------------------------------------------------
# ⚠ 自签证书**不能用于对外正式环境**:浏览器会报安全警告,
#   微信内置浏览器与分享链接大概率直接拒绝。正式域名请用 Let's Encrypt
#   (见 docs/DEPLOYMENT.md「TLS 证书」)。
#
# 输出(与 conf.d/june.conf 期望的文件名一致):
#   deploy/nginx/certs/fullchain.pem
#   deploy/nginx/certs/privkey.pem
#   deploy/nginx/certs/chain.pem     # 自签没有真正的中间证书,这里放证书自身作占位
#
# 用法:
#   ./deploy/scripts/gen-selfsigned-cert.sh                       # CN=localhost
#   ./deploy/scripts/gen-selfsigned-cert.sh june.internal 10.0.0.8
#     参数 1:主域名;参数 2 及之后:附加的域名或 IP(自动识别写入 SAN)
# ============================================================================
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

require_cmd openssl

PRIMARY="${1:-localhost}"
shift || true
EXTRA=("$@")

CERT_DIR="${JUNE_TLS_CERT_DIR_LOCAL:-$REPO_ROOT/deploy/nginx/certs}"
mkdir -p "$CERT_DIR"
chmod 755 "$CERT_DIR"

# ---- 拼 SAN:IP 和域名要用不同前缀,否则 Chrome 不认 ----
san="DNS:${PRIMARY}"
case "$PRIMARY" in
  *[0-9].[0-9]*) san="IP:${PRIMARY},DNS:${PRIMARY}" ;;
esac
for host in "${EXTRA[@]}"; do
  if printf '%s' "$host" | grep -Eq '^[0-9]+(\.[0-9]+){3}$'; then
    san="${san},IP:${host}"
  else
    san="${san},DNS:${host}"
  fi
done
# 本机回环一律带上,方便容器内 curl 自测
san="${san},DNS:localhost,IP:127.0.0.1"

step "生成自签证书"
log "主域名:$PRIMARY"
log "SAN   :$san"
log "输出  :$CERT_DIR"

# ECDSA P-256:比 RSA 2048 更快更小,现代浏览器与 TLS1.2/1.3 全支持;
# 与 nginx.conf 里 ssl_ciphers 的 ECDHE-ECDSA-* 套件匹配。
openssl req -x509 \
  -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
  -keyout "$CERT_DIR/privkey.pem" \
  -out "$CERT_DIR/fullchain.pem" \
  -days 825 \
  -nodes \
  -subj "/C=CN/O=JUNE-Commerce-Platform/CN=${PRIMARY}" \
  -addext "subjectAltName=${san}" \
  -addext "keyUsage=digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth" \
  2>/dev/null

# conf.d/june.conf 开了 ssl_stapling,需要 ssl_trusted_certificate 指向一个存在的文件。
# 自签场景没有中间证书,也没有 OCSP responder:
# 这里放证书自身作为占位,Nginx 启动时只会在 error.log 里打一条
# "ssl_stapling ignored, issuer certificate not found" 的 warning,不影响握手。
cp "$CERT_DIR/fullchain.pem" "$CERT_DIR/chain.pem"

chmod 600 "$CERT_DIR/privkey.pem"
chmod 644 "$CERT_DIR/fullchain.pem" "$CERT_DIR/chain.pem"

ok "证书已生成"
openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -subject -dates -ext subjectAltName | sed 's/^/    /'

cat <<'EOF'

下一步:
  1. 确认 docker-compose.yml 的 JUNE_TLS_CERT_DIR 指向该目录(默认已是);
  2. docker compose up -d nginx  或  docker compose exec nginx nginx -s reload
  3. 自测:curl -k https://127.0.0.1/healthz

⚠ 提醒:私钥 privkey.pem 权限已设为 600,并且被 .dockerignore 排除(不会进镜像)。
   但仓库根 .gitignore 目前**没有**证书相关规则,请自行追加以下两行再提交代码:
       deploy/nginx/certs/
       deploy/**/*.pem
EOF
