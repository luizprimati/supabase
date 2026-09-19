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

    # CRUD de usuários (só para quem é "admin" - o próprio login-server.js
    # faz essa checagem e devolve 302/403 quando não pode).
    location /admin {
        proxy_pass http://login:8085;
    }

    location / {
        auth_request /internal-auth;
        error_page 401 = @login_redirect;
        proxy_pass http://studio:3000;

        # O Studio (imagem oficial) não sabe nada sobre o nosso login/sessão
        # por fora, então não tem botão de sair. Injeta um botão flutuante
        # de "Sair" em toda página HTML dele via sub_filter - fica fora da
        # <div id="__next"> do Next.js, então sobrevive à navegação
        # client-side da SPA (só a carga inicial de cada rota reinjeta).
        # Accept-Encoding vazio força o Studio a responder sem compressão -
        # sub_filter não reescreve corpo gzip/br.
        proxy_set_header Accept-Encoding "";
        sub_filter_types text/html;
        sub_filter_once on;
        sub_filter '</body>' '<style>#__logout_fab{position:fixed;bottom:20px;right:20px;z-index:999999;width:32px;height:32px;border-radius:50%;background:#3ecf8e;color:#05261a;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,.3);text-decoration:none;opacity:.7;transition:opacity .15s,transform .15s}#__logout_fab:hover{opacity:1;background:#34b87c;transform:scale(1.08)}</style><a id="__logout_fab" href="/logout" title="Sair"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg></a><script>(function(){function isValidFnName(n){if(!n)return false;if(n.length>63)return false;if(n==="main")return false;var c0=n.charCodeAt(0);if(c0<97||c0>122)return false;for(var i=0;i<n.length;i++){var c=n.charCodeAt(i);var ok=(c>=97&&c<=122)||(c>=48&&c<=57)||c===45||c===95;if(!ok)return false;}return true;}var modalApi=null;function getModal(){if(modalApi)return modalApi;var overlay=document.createElement("div");overlay.id="__fn_modal_overlay";overlay.style.position="fixed";overlay.style.inset="0";overlay.style.background="rgba(0,0,0,.5)";overlay.style.display="none";overlay.style.alignItems="center";overlay.style.justifyContent="center";overlay.style.zIndex="1000000";overlay.style.fontFamily="inherit";var card=document.createElement("div");card.style.background="#fff";card.style.borderRadius="10px";card.style.padding="20px";card.style.width="320px";card.style.boxSizing="border-box";card.style.boxShadow="0 10px 40px rgba(0,0,0,.3)";card.style.fontFamily="inherit";var title=document.createElement("div");title.textContent="Nova função";title.style.fontSize="15px";title.style.fontWeight="600";title.style.color="#1c1c1c";title.style.marginBottom="12px";var label=document.createElement("label");label.textContent="Nome da função";label.style.display="block";label.style.fontSize="12px";label.style.color="#555";label.style.marginBottom="6px";label.style.fontWeight="500";var input=document.createElement("input");input.type="text";input.placeholder="minha-funcao";input.style.width="100%";input.style.boxSizing="border-box";input.style.padding="8px 10px";input.style.border="1px solid #d4d4d4";input.style.borderRadius="6px";input.style.fontSize="13px";input.style.fontFamily="inherit";input.style.marginBottom="4px";input.style.outline="none";input.addEventListener("focus",function(){input.style.borderColor="#3ecf8e";});input.addEventListener("blur",function(){input.style.borderColor="#d4d4d4";});var hint=document.createElement("div");hint.textContent="Letras minúsculas, números, - ou _, começando com letra.";hint.style.fontSize="11px";hint.style.color="#888";hint.style.marginBottom="10px";var errorMsg=document.createElement("div");errorMsg.style.fontSize="12px";errorMsg.style.color="#c0392b";errorMsg.style.marginBottom="10px";errorMsg.style.display="none";var actions=document.createElement("div");actions.style.display="flex";actions.style.justifyContent="flex-end";actions.style.gap="8px";actions.style.marginTop="4px";var cancelBtn=document.createElement("button");cancelBtn.type="button";cancelBtn.textContent="Cancelar";cancelBtn.style.border="1px solid #d4d4d4";cancelBtn.style.background="#fff";cancelBtn.style.color="#333";cancelBtn.style.borderRadius="6px";cancelBtn.style.padding="6px 14px";cancelBtn.style.fontSize="13px";cancelBtn.style.fontFamily="inherit";cancelBtn.style.cursor="pointer";var createBtn=document.createElement("button");createBtn.type="button";createBtn.textContent="Criar";createBtn.style.border="none";createBtn.style.background="#3ecf8e";createBtn.style.color="#05261a";createBtn.style.fontWeight="600";createBtn.style.borderRadius="6px";createBtn.style.padding="6px 14px";createBtn.style.fontSize="13px";createBtn.style.fontFamily="inherit";createBtn.style.cursor="pointer";actions.appendChild(cancelBtn);actions.appendChild(createBtn);card.appendChild(title);card.appendChild(label);card.appendChild(input);card.appendChild(hint);card.appendChild(errorMsg);card.appendChild(actions);overlay.appendChild(card);document.body.appendChild(overlay);function resetBtn(){createBtn.disabled=false;createBtn.textContent="Criar";}function showError(msg){errorMsg.textContent=msg;errorMsg.style.display="block";}function close(){overlay.style.display="none";input.value="";errorMsg.style.display="none";resetBtn();}function submit(){var name=input.value.trim();if(!isValidFnName(name)){showError("Nome inválido.");return;}errorMsg.style.display="none";createBtn.disabled=true;createBtn.textContent="Criando...";var code=`Deno.serve(() => Response.json({ message: "Hello from Edge Functions!" }));`;fetch("/admin/api/functions/"+encodeURIComponent(name),{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:code})}).then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d};});}).then(function(res){if(!res.ok){resetBtn();showError(res.d&&res.d.error?res.d.error:"Não foi possível criar a função.");return;}window.location.reload();}).catch(function(){resetBtn();showError("Erro de rede ao criar a função.");});}cancelBtn.addEventListener("click",close);overlay.addEventListener("click",function(e){if(e.target===overlay)close();});createBtn.addEventListener("click",submit);input.addEventListener("keydown",function(e){if(e.key==="Enter")submit();if(e.key==="Escape")close();});modalApi={open:function(){overlay.style.display="flex";input.value="";errorMsg.style.display="none";setTimeout(function(){input.focus();},0);},remove:function(){overlay.remove();}};return modalApi;}function createFnBtn(){var btn=document.createElement("button");btn.id="__new_fn_btn";btn.type="button";var svgNS="http://www.w3.org/2000/svg";var svg=document.createElementNS(svgNS,"svg");svg.setAttribute("width","13");svg.setAttribute("height","13");svg.setAttribute("viewBox","0 0 24 24");svg.setAttribute("fill","none");svg.setAttribute("stroke","currentColor");svg.setAttribute("stroke-width","2.5");svg.setAttribute("stroke-linecap","round");svg.setAttribute("stroke-linejoin","round");var l1=document.createElementNS(svgNS,"line");l1.setAttribute("x1","12");l1.setAttribute("y1","5");l1.setAttribute("x2","12");l1.setAttribute("y2","19");var l2=document.createElementNS(svgNS,"line");l2.setAttribute("x1","5");l2.setAttribute("y1","12");l2.setAttribute("x2","19");l2.setAttribute("y2","12");svg.appendChild(l1);svg.appendChild(l2);var lbl=document.createElement("span");lbl.textContent="Nova função";btn.appendChild(svg);btn.appendChild(lbl);btn.style.position="fixed";btn.style.zIndex="999999";btn.style.border="none";btn.style.borderRadius="6px";btn.style.background="#3ecf8e";btn.style.color="#05261a";btn.style.fontWeight="600";btn.style.fontSize="12px";btn.style.fontFamily="inherit";btn.style.cursor="pointer";btn.style.boxSizing="border-box";btn.style.height="26px";btn.style.lineHeight="1";btn.style.padding="0 10px";btn.style.display="inline-flex";btn.style.alignItems="center";btn.style.gap="6px";btn.style.justifyContent="center";btn.addEventListener("click",function(){getModal().open();});document.body.appendChild(btn);return btn;}function ensureFnBtn(){var existing=document.getElementById("__new_fn_btn");if(window.location.pathname.indexOf("/functions")===-1){if(existing)existing.remove();var m=document.getElementById("__fn_modal_overlay");if(m)m.remove();modalApi=null;return;}var els=document.querySelectorAll("a,button");var examplesBtn=null;for(var i=0;i<els.length;i++){if(els[i].id!=="__new_fn_btn"&&els[i].textContent.trim()==="Examples"){examplesBtn=els[i];break;}}if(!examplesBtn){if(existing)existing.remove();return;}var btn=existing||createFnBtn();var group=examplesBtn.parentElement||examplesBtn;var groupRect=group.getBoundingClientRect();var w=btn.offsetWidth||140;btn.style.top=groupRect.top+"px";btn.style.left=Math.max(8,groupRect.left-w-8)+"px";}setInterval(ensureFnBtn,600);ensureFnBtn();})();</script></body>';
    }

    location @login_redirect {
        # $http_host (não $host) preserva a porta não-padrão (9443) que o
        # cliente usou - o Nginx completa redirects relativos com $host,
        # que nunca inclui porta, e isso mandaria o navegador para a 443
        # (do AzuraCast) em vez da 9443.
        return 302 $scheme://$http_host/login?rd=$request_uri;
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
