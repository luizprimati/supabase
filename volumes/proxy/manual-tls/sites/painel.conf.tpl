# Site extra: o sistema web do painel (Node.js), num subdomínio próprio,
# atrás do mesmo Nginx do Supabase. Só é carregado com o override
# docker-compose.painel.yml (ver docs/novo-servidor.md). ${PAINEL_DOMAIN},
# ${PAINEL_UPSTREAM} e ${PROXY_DOMAIN} são resolvidos por envsubst na
# inicialização do container - as demais variáveis com $ são do Nginx.
#
# O certificado é o mesmo do Supabase (um certificado com os dois nomes,
# emitido com -d ${PROXY_DOMAIN} -d ${PAINEL_DOMAIN}). A porta 80 já é
# atendida pelo bloco do nginx.conf.tpl, que redireciona qualquer endereço
# para o HTTPS e responde o desafio da Let's Encrypt.
#
# Nada do login do Supabase vale aqui: o cookie da sessão do painel do
# Supabase é do outro endereço e o navegador nunca o manda para cá.

# WebSocket (se o sistema usar): repassa o pedido de upgrade.
map $http_upgrade $painel_connection_upgrade {
    default upgrade;
    ''      '';
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;

    server_name ${PAINEL_DOMAIN};
    server_tokens off;

    ssl_certificate     /etc/nginx/certs/live/${PROXY_DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/live/${PROXY_DOMAIN}/privkey.pem;

    # Uploads pelo sistema web (ajuste se precisar de arquivos maiores).
    client_max_body_size 50m;

    location / {
        # Resolvido na hora de cada acesso: se o sistema estiver parado (ou
        # ainda nem existir), só este endereço mostra a página de "em breve"
        # - o Supabase continua no ar normalmente.
        resolver 127.0.0.11 valid=10s ipv6=off;
        set $painel_upstream ${PAINEL_UPSTREAM};
        proxy_pass $painel_upstream;

        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $painel_connection_upgrade;
        proxy_read_timeout 300s;

        # Só quando o Nginx não consegue falar com o sistema (container
        # parado ou inexistente). Erros que o próprio sistema devolver
        # passam direto.
        error_page 502 504 = @painel_fora_do_ar;
    }

    location @painel_fora_do_ar {
        default_type text/html;
        add_header Cache-Control "no-store" always;
        add_header Retry-After "60" always;
        return 503 '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Em breve</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#0b0b0c;color:#e8e8e8}main{text-align:center;padding:24px}h1{font-size:28px;margin:0 0 8px}p{color:#a0a0a0;margin:0}</style></head><body><main><h1>Em breve</h1><p>Este endereço ainda está sendo preparado.</p></main></body></html>';
    }
}
