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

    # Igual ao de cima, mas só aprova admin (403 para usuário comum) e
    # devolve o usuário no header X-Auth-User - usado pelas ferramentas de
    # monitoramento (/dozzle/, /beszel/), que veem logs/métricas de TODOS os
    # containers do servidor (rádio e chat-IA inclusive).
    location = /internal-auth-admin {
        internal;
        proxy_pass http://login:8085/auth-admin;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
    }

    location /login {
        proxy_pass http://login:8085;
    }

    location /logout {
        proxy_pass http://login:8085;
    }

    # Página pública de política de privacidade - exigida pelo Google
    # Cloud Console pra publicar o app OAuth usado no Backup (Passo 5.1),
    # sem precisar de sessão/login (igual /login).
    location = /legal/privacidade {
        proxy_pass http://login:8085;
    }

    # CRUD de usuários (só para quem é "admin" - o próprio login-server.js
    # faz essa checagem e devolve 302/403 quando não pode).
    location /admin {
        proxy_pass http://login:8085;
    }

    # JS injetado em toda página do Studio (botão de logout, botão/modal
    # de "Nova função" em Edge Functions) - servido daqui em vez de
    # embutido direto na diretiva sub_filter abaixo, porque essa diretiva
    # tem um limite de ~4KB por parâmetro (já estourou uma vez - ver
    # STUDIO_INJECT_JS em login-server.js).
    location = /studio-inject.js {
        proxy_pass http://login:8085;
    }

    location / {
        auth_request /internal-auth;
        error_page 401 = @login_redirect;
        proxy_pass http://studio:3000;

        # O Studio (imagem oficial) não sabe nada sobre o nosso login/sessão
        # por fora, então não tem botão de sair (nem editor de Edge
        # Functions no self-hosted). sub_filter injeta só uma tag <script
        # src> curta (o conteúdo de verdade é /studio-inject.js, acima) -
        # fica fora da <div id="__next"> do Next.js, então sobrevive à
        # navegação client-side da SPA (só a carga inicial de cada rota
        # reinjeta). Accept-Encoding vazio força o Studio a responder sem
        # compressão - sub_filter não reescreve corpo gzip/br.
        proxy_set_header Accept-Encoding "";
        sub_filter_types text/html;
        sub_filter_once on;
        sub_filter '</body>' '<script src="/studio-inject.js"></script></body>';
    }

    location @login_redirect {
        # $http_host (não $host) preserva a porta não-padrão (9443) que o
        # cliente usou - o Nginx completa redirects relativos com $host,
        # que nunca inclui porta, e isso mandaria o navegador para a 443
        # (do AzuraCast) em vez da 9443.
        return 302 $scheme://$http_host/login?rd=$request_uri;
    }

    # --- Monitoramento (override docker-compose.monitoring.yml) ---
    # Os apps ficam numa rede só deles com este Nginx e são resolvidos na
    # hora de cada requisição (resolver do Docker + variável): se estiverem
    # fora do ar (ou o override nem estiver ativo), só /dozzle/ e /beszel/
    # dão 502 - o resto da 9443 sobe normalmente. Também evita o 502 por IP
    # velho depois de recriar o container (ver docs/servidor.md).

    # Dozzle: logs ao vivo e estatísticas dos containers.
    location = /dozzle {
        return 301 $scheme://$http_host/dozzle/;
    }

    location ^~ /dozzle/ {
        auth_request /internal-auth-admin;
        auth_request_set $auth_user $upstream_http_x_auth_user;
        error_page 401 = @login_redirect;

        resolver 127.0.0.11 valid=10s ipv6=off;
        set $dozzle_upstream http://dozzle:8080;
        proxy_pass $dozzle_upstream;

        # Declarar proxy_set_header aqui faz o bloco não herdar os do server
        # - por isso os X-Forwarded-* se repetem.
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $http_host;
        proxy_set_header X-Forwarded-Port $server_port;

        # DOZZLE_AUTH_PROVIDER=forward-proxy: o Dozzle confia cegamente nestes
        # headers, então todos são SEMPRE definidos aqui (valor "" = não
        # repassa, descartando o que vier do navegador). Remote-Roles fixo e
        # sem "all": ninguém reconfigura o Dozzle, liga o Dozzle Cloud nem
        # ações/terminal pela tela. Sem Remote-User o Dozzle responde 401.
        proxy_set_header Remote-User $auth_user;
        proxy_set_header Remote-Name $auth_user;
        proxy_set_header Remote-Email "";
        proxy_set_header Remote-Filter "";
        proxy_set_header Remote-Roles "download,notifications";

        # Logs e estatísticas chegam por Server-Sent Events.
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding off;
        proxy_read_timeout 3600s;
    }

    # Beszel: saúde do servidor (CPU, memória, disco, rede, carga) com
    # histórico e alertas.
    location = /beszel {
        return 301 $scheme://$http_host/beszel/;
    }

    # Painel de superusuário do PocketBase (banco interno do Beszel) - não é
    # usado aqui; fechado para não ter uma tela de login por senha a mais.
    location ^~ /beszel/_/ {
        return 404;
    }

    location ^~ /beszel/ {
        auth_request /internal-auth-admin;
        error_page 401 = @login_redirect;

        resolver 127.0.0.11 valid=10s ipv6=off;
        set $beszel_upstream http://beszel:8090;
        # Ao contrário do Dozzle, o Beszel responde na raiz: o painel pede
        # /beszel/api/... (APP_URL) e o hub espera /api/... .
        rewrite ^/beszel/(.*)$ /$1 break;
        proxy_pass $beszel_upstream;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $http_host;
        proxy_set_header X-Forwarded-Port $server_port;

        # TRUSTED_AUTH_HEADER do Beszel: loga como o usuário com este e-mail
        # (criado na primeira subida, ver docker-compose.monitoring.yml).
        # Sempre definido aqui - o que vier do navegador é descartado.
        proxy_set_header X-Beszel-User "monitor@beszel.local";

        # Atualização ao vivo do painel (Server-Sent Events do PocketBase).
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
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
