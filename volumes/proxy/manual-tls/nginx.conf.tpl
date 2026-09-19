# Template para o reverse proxy usado quando 80/443 já pertencem a outro
# serviço no host (aqui: AzuraCast) e o certificado é emitido manualmente
# via DNS-01 (veja docs/certbot-manual-dns.md). ${PROXY_DOMAIN} é resolvido
# por envsubst na inicialização do container - as demais variáveis com $
# são do próprio Nginx e não devem ser substituídas.

upstream api_gw_upstream {
    server api-gw:8000;
    keepalive 2;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;

    server_name ${PROXY_DOMAIN};
    server_tokens off;

    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header X-Forwarded-Port $server_port;

    ssl_certificate     /etc/nginx/certs/live/${PROXY_DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/live/${PROXY_DOMAIN}/privkey.pem;

    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    # Evita 502 com cookies/headers grandes do Auth
    large_client_header_buffers 4 16k;
    proxy_buffer_size 128k;
    proxy_buffers 4 256k;
    proxy_busy_buffers_size 256k;

    # Tela de login própria (login-server.js) no lugar do pop-up nativo de
    # Basic Auth do navegador. /internal-auth é uma sub-requisição interna
    # que só valida o cookie de sessão - nunca é chamada direto pelo cliente.
    location = /internal-auth {
        internal;
        proxy_pass http://login:8085/auth;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
    }

    location /login {
        proxy_pass http://login:8085;
    }

    location /logout {
        proxy_pass http://login:8085;
    }

    location / {
        auth_request /internal-auth;
        error_page 401 = @login_redirect;
        proxy_pass http://studio:3000;
    }

    location @login_redirect {
        return 302 /login?rd=$request_uri;
    }

    location /auth {
        proxy_pass http://api_gw_upstream;
    }

    location /rest {
        proxy_pass http://api_gw_upstream;
    }

    location /graphql {
        proxy_pass http://api_gw_upstream;
    }

    location /realtime/v1/ {
        proxy_pass http://api_gw_upstream;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }

    location /storage/v1/ {
        proxy_pass http://api_gw_upstream;
        proxy_buffering off;
        proxy_request_buffering off;
        chunked_transfer_encoding off;
        client_max_body_size 0;
    }

    location /functions {
        proxy_pass http://api_gw_upstream;
    }

    location /mcp {
        proxy_pass http://api_gw_upstream;
    }

    location /sso {
        proxy_pass http://api_gw_upstream;
    }

    location = /.well-known/oauth-authorization-server {
        proxy_pass http://api_gw_upstream;
    }
}
