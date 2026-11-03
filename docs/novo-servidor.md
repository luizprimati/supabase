# Instalar num servidor novo (Oracle, Ubuntu, sem a rádio)

Passo a passo para montar a mesma estrutura deste repositório (Supabase +
tela de login/painel `/admin` + Dozzle + Beszel + limite de logs) num
servidor Oracle **dedicado**, com o projeto começando vazio, e com um
segundo endereço para um sistema web seu (Node.js) no mesmo servidor.

Exemplo usado em todo o guia (é o servidor da Brancaleone):

| Endereço | O que abre |
|---|---|
| `https://supabase.brancaleone.com.br` | O Supabase completo, igual ao servidor atual: tela de abertura, `/admin`, Studio, API, Dozzle e Beszel |
| `https://painel.brancaleone.com.br` | O seu sistema web (Node.js), num container próprio. Até ele existir, uma página de "em breve" |

O que muda em relação ao servidor atual, que divide a máquina com a rádio:

| | Servidor atual (com AzuraCast) | Servidor novo |
|---|---|---|
| Endereço | `https://dominio:9443` | `https://dominio` (porta 443 padrão); `http://` redireciona para `https://` |
| Certificado HTTPS | Manual, pelo DNS do registro.br, quando faltam ~20 dias para vencer | **Automático**: um certificado com os dois nomes, renovado sozinho pela porta 80, sem parar nada |
| Portas abertas | 9443 | 80 e 443 |
| Overrides (`sh run.sh config`) | `manual-tls`, `override`, `monitoring`, `monitoring-agent` | os mesmos **+ `http`** (porta 80) **+ `painel`** (o segundo endereço) |

Todo o resto (painel `/admin`, Edge Functions, Secrets, Dozzle, Beszel,
limite de logs) é igual. Os comandos abaixo param no primeiro erro: se
algum falhar, corrija e rode o mesmo bloco de novo.

> **Os subdomínios ainda não existem?** Dá para instalar só com o IP e
> trocar depois: veja [Começar só com o IP](#começar-só-com-o-ip-antes-do-dns).

## 0. Antes de começar

- **Instância:** shape `VM.Standard.A1.Flex` (ARM), imagem **Canonical
  Ubuntu 24.04** (aarch64). Recursos: 4 OCPUs / 24 GB se a conta tiver a
  cota gratuita livre; o mínimo confortável é 2 OCPUs / 12 GB. Disco de
  inicialização: 100 GB ou mais (a cota gratuita dá 200 GB no total).
- **Chave SSH:** ao criar a instância, em **Add SSH keys** escolha
  **Paste public keys** e cole a chave pública do seu computador (a mesma
  que você usa no servidor atual, por exemplo o conteúdo de
  `~/.ssh/id_ed25519.pub`). Se escolher **Generate a key pair for me**,
  baixe a chave privada na hora (ela só aparece ali) e entre com
  `ssh -i caminho/da/chave.key ubuntu@IP` (antes, no Linux/macOS:
  `chmod 600 caminho/da/chave.key`).
- **IP público fixo (faça antes do passo 2).** O IP que a instância recebe
  na criação é *efêmero*: ele não vira fixo, e trocar por um reservado
  **muda o IP**. Para fixar: **Compute → Instances → (instância) → Attached
  VNICs → (VNIC) → IPv4 Addresses** → no IP privado primário, **⋮ → Edit**
  → **No public IP** → **Update**; depois **⋮ → Edit** de novo →
  **Reserved public IP** → **Create new reserved IP** → **Update**. Use
  esse IP no DNS (passo 2) e no `ssh`. Só criar o IP em **Networking → IP
  Management → Reserved Public IPs**, sem esta troca, não muda nada na
  instância.
- **Conta Pay As You Go.** Numa conta só *Always Free*, a Oracle pode
  **parar** instâncias que passem 7 dias com pouco uso de CPU, rede e
  memória, e um Supabase com pouco acesso pode cair nessa regra (no
  servidor atual a rádio mantém a máquina ocupada). Em **Billing & Cost
  Management → Upgrade and Manage Payment**, converta a conta para *Pay As
  You Go*: os recursos Always Free (A1 com 4 OCPUs/24 GB, 200 GB de disco)
  continuam sem custo, e a regra de instância ociosa deixa de valer. Crie
  também um **Budget** com alerta baixo (por exemplo US$ 1) para ser avisado
  se algo sair da cota gratuita.
- Acesso ao **DNS** de `brancaleone.com.br`.
- Um **e-mail** para o certbot. A Let's Encrypt não manda mais aviso de
  vencimento (acabou em 04/06/2025) e não guarda o e-mail: ele só entra na
  lista de novidades da ISRG.

## 1. Rede na Oracle (console)

Na conta Oracle do servidor novo: **Menu ☰ → Networking → Virtual Cloud
Networks → (a VCN da instância) → Security Lists → Default Security
List** → **Add Ingress Rules**, duas regras:

| Origem | Protocolo | Porta destino | Para quê |
|---|---|---|---|
| `0.0.0.0/0` | TCP | 80 | Web: redireciona para o HTTPS e renova o certificado |
| `0.0.0.0/0` | TCP | 443 | Supabase, painel `/admin`, Dozzle, Beszel e o sistema web |

Não abra 5432, 6543, 8000, 3000 nem a porta do seu sistema: banco,
pooler, gateway, Studio e o sistema web nunca ficam públicos direto, só
pelo Nginx na 443.

> **Pegadinha já vista no servidor atual:** um Network Security Group
> (NSG) só vale se estiver anexado à placa de rede da instância
> (**Compute → Instances → instância → Attached VNICs → VNIC → Network
> Security Groups**). Na dúvida, use a Security List, como acima.

## 2. DNS

No painel de DNS de `brancaleone.com.br` (no registro.br: **Meus
domínios → brancaleone.com.br → DNS**), crie **dois** registros tipo
**A**, os dois apontando para o IP público da instância:

| Tipo | Nome | Valor |
|---|---|---|
| A | `supabase` | IP público da instância |
| A | `painel` | IP público da instância |

Não crie registro **AAAA** (IPv6) para eles: a instância não usa IPv6
aqui, e a Let's Encrypt tentaria por ele. Confira:

```bash
dig +short supabase.brancaleone.com.br; dig +short painel.brancaleone.com.br
```

Só siga para o passo 4 (certificado) quando os dois mostrarem o IP certo.

## 3. Preparar o servidor (SSH)

Entre com `ssh ubuntu@IP_DO_SERVIDOR` (ou `ssh -i chave.key ubuntu@IP_DO_SERVIDOR`, se a Oracle gerou a chave).

**3.1. Seus dados, uma vez só.** Os próximos blocos leem daqui, então
funcionam mesmo se você abrir outra sessão SSH no meio:

```bash
printf 'DOMINIO=supabase.brancaleone.com.br\nPAINEL=painel.brancaleone.com.br\nEMAIL=voce@exemplo.com\n' > ~/novo-servidor.conf && nano ~/novo-servidor.conf
```

Troque `voce@exemplo.com` pelo seu e-mail, salve (Ctrl+O, Enter) e saia
(Ctrl+X).

**3.2. Atualizar e abrir 80/443 no firewall da instância.** A imagem
Ubuntu da Oracle vem com um firewall (`iptables`) que recusa tudo, menos
SSH. Este passo vem **antes** de instalar o Docker de propósito: o
`netfilter-persistent save` grava as regras atuais, e com o Docker
instalado ele gravaria também as regras dinâmicas do Docker.

```bash
sudo apt-get update && sudo apt-get -y upgrade \
  && { sudo iptables -C INPUT -p tcp --dport 80 -m state --state NEW -j ACCEPT 2>/dev/null || sudo iptables -I INPUT -p tcp --dport 80 -m state --state NEW -j ACCEPT; } \
  && { sudo iptables -C INPUT -p tcp --dport 443 -m state --state NEW -j ACCEPT 2>/dev/null || sudo iptables -I INPUT -p tcp --dport 443 -m state --state NEW -j ACCEPT; } \
  && { [ ! -e /usr/bin/dockerd ] || { echo 'Docker já instalado: não salve (gravaria as regras do Docker).'; false; }; } \
  && sudo netfilter-persistent save \
  && sudo iptables -L INPUT -n --line-numbers
```

As regras de 80 e 443 têm que aparecer **antes** da linha `REJECT`. O
bloco pode ser rodado de novo sem duplicar nada; com o Docker já
instalado ele para antes de salvar, de propósito. Se o `upgrade` atualizou
o kernel, reinicie agora (`sudo reboot`) e entre de novo.

**3.3. Instalar o Docker** (repositório oficial; o Compose vem junto):

```bash
sudo apt-get install -y ca-certificates curl \
  && sudo install -m 0755 -d /etc/apt/keyrings \
  && sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
  && sudo chmod a+r /etc/apt/keyrings/docker.asc \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null \
  && sudo apt-get update \
  && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
  && sudo usermod -aG docker "$USER"
```

**Saia e entre de novo no SSH** (o grupo `docker` só vale numa sessão
nova) e confira:

```bash
docker compose version && docker run --rm hello-world | head -2
```

## 4. Primeiro certificado HTTPS

Um certificado só, com os dois nomes. A Let's Encrypt confere que você
controla os domínios acessando a porta 80 do servidor. Nesta primeira vez
o Supabase ainda não está no ar, então o próprio certbot atende a porta
80 por alguns segundos (`--standalone`). Depois que tudo subir (passo 6),
a renovação passa a ser feita pelo Nginx, sem parar nada. O gancho criado
aqui faz o Nginx reler o certificado a cada renovação.

```bash
. ~/novo-servidor.conf && sudo apt-get install -y certbot \
  && sudo certbot certonly --standalone -d "$DOMINIO" -d "$PAINEL" -m "$EMAIL" --agree-tos --no-eff-email \
  && sudo mkdir -p /var/www/certbot \
  && printf '#!/bin/sh\n# Certificado renovado: o Nginx do Supabase relê os arquivos sem derrubar nada.\ndocker exec supabase-nginx-manual nginx -s reload\n' | sudo tee /etc/letsencrypt/renewal-hooks/deploy/recarregar-nginx-supabase.sh > /dev/null \
  && sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/recarregar-nginx-supabase.sh \
  && sudo ls /etc/letsencrypt/live/"$DOMINIO"/
```

O esperado: `Successfully received certificate` e, na última linha,
`cert.pem chain.pem fullchain.pem privkey.pem README`. A pasta tem o nome
do primeiro domínio (`supabase...`), mas o certificado vale para os dois.
Se a Let's Encrypt não conseguir falar com o servidor (`Timeout during
connect`), a porta 80 ainda está fechada na Security List (passo 1) ou no
`iptables` (confira com `sudo iptables -L INPUT -n --line-numbers`: a
linha `tcp dpt:80` tem que vir antes do `REJECT`), ou o DNS (passo 2) ainda
não aponta para este IP.

## 5. Baixar o projeto e gerar as chaves

As chaves (senha do banco, JWT, chaves da API) são novas e só deste
servidor. Os scripts gravam direto no `.env`; a saída vai para
`/dev/null` para as chaves não ficarem na tela. O `SITE_URL` (para onde
os e-mails de confirmação e os logins do Auth mandam o usuário de volta)
aponta para o sistema web do painel.

```bash
. ~/novo-servidor.conf && cd ~ && git clone https://github.com/luizprimati/supabase.git && cd ~/supabase \
  && cp .env.example .env && chmod 600 .env \
  && sh utils/generate-keys.sh --update-env > /dev/null \
  && sh utils/add-new-auth-keys.sh --update-env > /dev/null \
  && sed -i \
       -e "s|^SUPABASE_PUBLIC_URL=.*|SUPABASE_PUBLIC_URL=https://$DOMINIO|" \
       -e "s|^API_EXTERNAL_URL=.*|API_EXTERNAL_URL=https://$DOMINIO/auth/v1|" \
       -e "s|^SITE_URL=.*|SITE_URL=https://$PAINEL|" \
       -e "s|^PROXY_DOMAIN=.*|PROXY_DOMAIN=$DOMINIO|" .env \
  && printf '\nSUPABASE_PROXY_PORT=443\nPAINEL_DOMAIN=%s\nPROJECT_TITLE=Brancaleone\nPROJECT_TAGLINE=Painel administrativo\nBESZEL_USER_PASSWORD=%s\n' "$PAINEL" "$(openssl rand -hex 24)" >> .env \
  && grep -E '^(SUPABASE_PUBLIC_URL|API_EXTERNAL_URL|SITE_URL|PROXY_DOMAIN|SUPABASE_PROXY_PORT|PAINEL_DOMAIN|PROJECT_TITLE)=' .env \
  && grep -c '^JWT_SECRET=.\{32,\}' .env
```

Tem que aparecer as sete linhas com os seus endereços e, na última, `1`
(o `JWT_SECRET` foi gerado).

## 6. Subir tudo

Cria os arquivos que precisam existir antes da primeira subida, cria a
rede `painel` (por onde o Nginx fala com o seu sistema), liga os
overrides (Nginx + login, banco só em `127.0.0.1`, porta 80, monitoramento
e o painel) e sobe. A primeira vez baixa as imagens (alguns GB) e leva
alguns minutos. No fim, troca a senha do superusuário do Beszel por uma
aleatória (ver [monitoramento.md](monitoramento.md)).

```bash
cd ~/supabase \
  && cp volumes/proxy/manual-tls/users.example.json volumes/proxy/manual-tls/users.json \
  && cp volumes/proxy/manual-tls/backup-config.example.json volumes/proxy/manual-tls/backup-config.json \
  && cp docker-compose.override.yml.example docker-compose.override.yml \
  && { docker network inspect painel > /dev/null 2>&1 || docker network create painel; } \
  && sh run.sh config add manual-tls override http monitoring painel \
  && sh run.sh start \
  && docker exec supabase-beszel /beszel superuser upsert monitor@beszel.local "$(openssl rand -hex 32)"
```

A última linha deve dizer `Successfully saved superuser`.

**Renovação pelo Nginx.** Agora que o Nginx atende a porta 80, a
renovação do certificado passa a usar a pasta `/var/www/certbot` (que ele
serve em `/.well-known/acme-challenge/`, para os dois endereços) em vez do
`--standalone`, que precisaria da porta 80 livre. O `reconfigure` já
testa a renovação nova; o `renew --dry-run` confirma:

```bash
. ~/novo-servidor.conf && sudo certbot reconfigure --cert-name "$DOMINIO" --webroot --webroot-path /var/www/certbot \
  && sudo certbot renew --dry-run \
  && systemctl list-timers certbot.timer --no-pager
```

O esperado: `Congratulations, all simulated renewals succeeded` e o
`certbot.timer` agendado (ele confere duas vezes por dia e só renova perto
do vencimento).

## 7. Criar o primeiro admin do painel `/admin`

O `users.json` veio com um usuário de exemplo sem senha válida. Este
bloco troca ele pelo seu admin: pergunta o usuário e a senha (que não
aparece na tela nem fica no histórico) e grava só o hash.

```bash
read -r -p 'Usuário do admin: ' U && read -r -s -p 'Senha (mínimo 8): ' P && echo \
  && printf '%s' "$P" | docker exec -i -e U="$U" supabase-studio-login node -e '
const c = require("crypto"), fs = require("fs"); let p = "";
process.stdin.on("data", (d) => (p += d)).on("end", () => {
  if (!process.env.U || p.length < 8) { console.error("Usuário vazio ou senha com menos de 8 caracteres."); process.exit(1); }
  const salt = c.randomBytes(16).toString("hex");
  const hash = c.scryptSync(p, salt, 64).toString("hex");
  fs.writeFileSync("/app/users.json", JSON.stringify([{ username: process.env.U, salt, hash, role: "admin" }], null, 2) + "\n");
  console.log("Admin \"" + process.env.U + "\" criado.");
});'; unset P
```

Abra `https://supabase.brancaleone.com.br` no navegador, clique em
**Entrar** e use esse usuário. Os outros usuários você cria pelo `/admin`
→ **Usuários**.

## 8. Conectar o agente do Beszel

1. Abra `https://supabase.brancaleone.com.br/beszel/` e clique em **Add
   System**, na aba **Docker**.
2. **Name:** `brancaleone`. **Host / IP:** `/beszel_socket/beszel.sock`
   (o campo de porta some sozinho).
3. Copie a **Public Key** e clique em **Add System**.
4. No servidor, cole a chave quando o bloco pedir:

```bash
cd ~/supabase && read -r -p 'Cole a Public Key: ' K && printf "BESZEL_AGENT_KEY='%s'\n" "$K" >> .env && sh run.sh config add monitoring-agent && sh run.sh start beszel-agent
```

Em até 1 minuto o sistema fica verde no Beszel.

## 9. Conferir

```bash
. ~/novo-servidor.conf && cd ~/supabase && sh run.sh status \
  && curl -s -o /dev/null -w 'supabase: %{http_code}\n' "https://$DOMINIO/login" \
  && curl -s -o /dev/null -w 'http: %{http_code} -> %{redirect_url}\n' "http://$DOMINIO/login" \
  && curl -s -o /dev/null -w 'dozzle sem login: %{http_code} -> %{redirect_url}\n' "https://$DOMINIO/dozzle/" \
  && curl -s -o /dev/null -w 'painel: %{http_code}\n' "https://$PAINEL/" \
  && sudo ss -tlnp | grep -E ':(80|443|3000|5432|6543|8000)\s'
```

O esperado:
- todos os serviços `Up` (e `healthy` os que têm healthcheck);
- `supabase: 200`, `http: 301 -> https://supabase.brancaleone.com.br/login`
  e `dozzle sem login: 302 -> https://supabase.brancaleone.com.br/login?rd=/dozzle/`;
- `painel: 503` enquanto o seu sistema não estiver no ar (é a página de
  "em breve"); depois, o código que o seu sistema responder;
- na lista de portas, só a **80** e a **443** abertas para fora
  (`0.0.0.0`), e a 5432/6543 em `127.0.0.1`.

## 10. Colocar o sistema web no painel

O seu sistema roda no projeto Docker dele (um repositório seu, separado
deste), ligado à rede `painel`, **sem publicar porta nenhuma**. O Nginx
encontra o container pelo nome `painel-web`, na porta `3000`, e cuida do
HTTPS. Não precisa mexer no Nginx nem reiniciar nada: assim que o
container sobe, `https://painel.brancaleone.com.br` passa a mostrar o
sistema; se ele parar, volta a página de "em breve".

No repositório do sistema, um `Dockerfile` (exemplo para Node.js):

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=3000
CMD ["node", "server.js"]
```

E um `docker-compose.yml`:

```yaml
services:
  web:
    container_name: painel-web
    build: .
    restart: unless-stopped
    env_file: .env
    networks:
      - painel
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"

networks:
  painel:
    external: true
```

Regras para o sistema funcionar atrás do Nginx:
- Escutar em `0.0.0.0:3000` (não em `localhost`), senão o Nginx não
  alcança.
- O HTTPS termina no Nginx: o sistema recebe HTTP e o header
  `X-Forwarded-Proto: https`. No Express, `app.set('trust proxy', 1)`
  para cookies `secure` e redirecionamentos saírem certos.
- Para falar com o Supabase: URL `https://supabase.brancaleone.com.br` e
  a chave pública (`ANON_KEY` ou `SUPABASE_PUBLISHABLE_KEY` do
  `~/supabase/.env`). A `SERVICE_ROLE_KEY`/`SUPABASE_SECRET_KEY` só no
  código de servidor do sistema, nunca no navegador.
- Se o repositório do sistema for privado, o servidor puxa com uma
  *deploy key* só de leitura, como o chat-IA faz no servidor atual (ver
  [servidor.md](servidor.md)).

Subir e atualizar: `cd ~/pasta-do-sistema && git pull --ff-only && docker compose up -d --build`.
Os logs dele aparecem no Dozzle (`painel-web`).

Para usar outro nome ou porta de container, defina no `~/supabase/.env`
`PAINEL_UPSTREAM=http://NOME:PORTA` e rode `sh run.sh recreate nginx`.

## Começar só com o IP (antes do DNS)

Dá para instalar tudo antes de os subdomínios existirem. Só o
certificado de verdade depende do DNS: enquanto isso, o Nginx usa um
certificado **provisório**, gerado no próprio servidor para o IP. O
Supabase, o `/admin`, o Dozzle e o Beszel funcionam normalmente em
`https://IP_DO_SERVIDOR`, mas o navegador avisa que a conexão "não é
particular" (é o certificado provisório; clique em **Avançado →
Continuar**). O endereço do painel (o sistema web) só entra na troca para
os domínios, no fim.

Use o IP **fixo** (reservado, passo 0). Se a instância ainda estiver
com o IP efêmero, faça a troca antes de começar: ela muda o IP.

Ordem: passos **0, 1 e 3** normais (no 3.1, se ainda não souber o e-mail,
deixe o de exemplo: ele só é usado na troca). Pule o 2 e o 4, e siga os
blocos abaixo no lugar dos passos 5 e 6.

**I.1. Anotar o IP** no mesmo arquivo do 3.1:

```bash
read -r -p 'IP público do servidor: ' IP \
  && { printf '%s' "$IP" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' || { echo 'Isso não parece um IP (exemplo: 123.45.67.89).'; false; }; } \
  && printf 'IP=%s\n' "$IP" >> ~/novo-servidor.conf && cat ~/novo-servidor.conf
```

**I.2. Certificado provisório** (no lugar do passo 4). Aparecem umas
linhas de pontos e `+` enquanto a chave é gerada; é normal.

```bash
. ~/novo-servidor.conf && [ -n "$IP" ] && sudo mkdir -p /etc/letsencrypt/live/"$IP" /var/www/certbot \
  && sudo openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=$IP" -addext "subjectAltName=IP:$IP" \
       -keyout /etc/letsencrypt/live/"$IP"/privkey.pem -out /etc/letsencrypt/live/"$IP"/fullchain.pem \
  && sudo ls /etc/letsencrypt/live/"$IP"/
```

O esperado na última linha: `fullchain.pem  privkey.pem`.

**I.3. Baixar o projeto e gerar as chaves** (no lugar do passo 5). É o
mesmo bloco do passo 5, com o IP no lugar do domínio do Supabase. O
`SITE_URL` e o `PAINEL_DOMAIN` já ficam com o endereço definitivo do
painel.

```bash
. ~/novo-servidor.conf && [ -n "$IP" ] && cd ~ && git clone https://github.com/luizprimati/supabase.git && cd ~/supabase \
  && cp .env.example .env && chmod 600 .env \
  && sh utils/generate-keys.sh --update-env > /dev/null \
  && sh utils/add-new-auth-keys.sh --update-env > /dev/null \
  && sed -i \
       -e "s|^SUPABASE_PUBLIC_URL=.*|SUPABASE_PUBLIC_URL=https://$IP|" \
       -e "s|^API_EXTERNAL_URL=.*|API_EXTERNAL_URL=https://$IP/auth/v1|" \
       -e "s|^SITE_URL=.*|SITE_URL=https://$PAINEL|" \
       -e "s|^PROXY_DOMAIN=.*|PROXY_DOMAIN=$IP|" .env \
  && printf '\nSUPABASE_PROXY_PORT=443\nPAINEL_DOMAIN=%s\nPROJECT_TITLE=Brancaleone\nPROJECT_TAGLINE=Painel administrativo\nBESZEL_USER_PASSWORD=%s\n' "$PAINEL" "$(openssl rand -hex 24)" >> .env \
  && grep -E '^(SUPABASE_PUBLIC_URL|API_EXTERNAL_URL|SITE_URL|PROXY_DOMAIN|SUPABASE_PROXY_PORT|PAINEL_DOMAIN|PROJECT_TITLE)=' .env \
  && grep -c '^JWT_SECRET=.\{32,\}' .env
```

Tem que aparecer as sete linhas (três delas com o IP) e, na última, `1`.

**I.4. Subir tudo** (no lugar do passo 6). Igual ao passo 6, mas ainda
sem o override `painel` e sem a parte do certbot:

```bash
cd ~/supabase \
  && cp volumes/proxy/manual-tls/users.example.json volumes/proxy/manual-tls/users.json \
  && cp volumes/proxy/manual-tls/backup-config.example.json volumes/proxy/manual-tls/backup-config.json \
  && cp docker-compose.override.yml.example docker-compose.override.yml \
  && sh run.sh config add manual-tls override http monitoring \
  && sh run.sh start \
  && docker exec supabase-beszel /beszel superuser upsert monitor@beszel.local "$(openssl rand -hex 32)"
```

A última linha deve dizer `Successfully saved superuser`.

**I.5. Admin e Beszel:** passos **7 e 8** normais. Onde eles dizem
`https://supabase.brancaleone.com.br`, abra `https://IP_DO_SERVIDOR` e
aceite o aviso do navegador uma vez.

**I.6. Conferir:**

```bash
. ~/novo-servidor.conf && cd ~/supabase && sh run.sh status \
  && curl -sk -o /dev/null -w 'supabase: %{http_code}\n' "https://$IP/login" \
  && curl -s -o /dev/null -w 'http: %{http_code} -> %{redirect_url}\n' "http://$IP/login" \
  && curl -sk -o /dev/null -w 'dozzle sem login: %{http_code} -> %{redirect_url}\n' "https://$IP/dozzle/" \
  && sudo ss -tlnp | grep -E ':(80|443|3000|5432|6543|8000)\s'
```

O esperado: serviços `Up`, `supabase: 200`, `http: 301 -> https://IP/login`,
`dozzle sem login: 302 -> https://IP/login?rd=/dozzle/` e, nas portas, só
a 80 e a 443 para fora.

### Trocar o IP pelos domínios (quando o DNS estiver pronto)

1. Crie os dois registros A do [passo 2](#2-dns) e confira se o servidor
   já enxerga os dois no IP certo:

   ```bash
   . ~/novo-servidor.conf && echo "IP do servidor: $IP" && for d in "$DOMINIO" "$PAINEL"; do echo "$d -> $(getent ahostsv4 "$d" | awk 'NR==1{print $1}')"; done
   ```

   Os dois têm que mostrar o IP do servidor. Confira também se o `EMAIL`
   em `~/novo-servidor.conf` é o seu (`nano ~/novo-servidor.conf`).

2. Emitir o certificado de verdade e trocar o endereço. O Nginx já
   atende a porta 80, então o certbot usa a pasta `/var/www/certbot` sem
   parar nada (e a renovação já fica configurada assim). Depois, o `.env`
   passa a usar o domínio, o override `painel` entra e o certificado
   provisório é apagado:

   ```bash
   . ~/novo-servidor.conf && [ -n "$IP" ] && sudo apt-get install -y certbot \
     && sudo certbot certonly --webroot --webroot-path /var/www/certbot -d "$DOMINIO" -d "$PAINEL" -m "$EMAIL" --agree-tos --no-eff-email --keep-until-expiring \
     && sudo mkdir -p /etc/letsencrypt/renewal-hooks/deploy \
     && printf '#!/bin/sh\n# Certificado renovado: o Nginx do Supabase relê os arquivos sem derrubar nada.\ndocker exec supabase-nginx-manual nginx -s reload\n' | sudo tee /etc/letsencrypt/renewal-hooks/deploy/recarregar-nginx-supabase.sh > /dev/null \
     && sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/recarregar-nginx-supabase.sh \
     && cd ~/supabase \
     && sed -i \
          -e "s|^SUPABASE_PUBLIC_URL=.*|SUPABASE_PUBLIC_URL=https://$DOMINIO|" \
          -e "s|^API_EXTERNAL_URL=.*|API_EXTERNAL_URL=https://$DOMINIO/auth/v1|" \
          -e "s|^PROXY_DOMAIN=.*|PROXY_DOMAIN=$DOMINIO|" .env \
     && { docker network inspect painel > /dev/null 2>&1 || docker network create painel; } \
     && sh run.sh config add painel \
     && sh run.sh start \
     && sh run.sh restart nginx \
     && sudo certbot renew --dry-run \
     && sudo rm -f /etc/letsencrypt/live/"$IP"/fullchain.pem /etc/letsencrypt/live/"$IP"/privkey.pem \
     && { ! sudo test -d /etc/letsencrypt/live/"$IP" || sudo rmdir /etc/letsencrypt/live/"$IP"; }
   ```

   O esperado: `Successfully received certificate`, os serviços subindo
   de novo e `Congratulations, all simulated renewals succeeded`. Se
   parar no certbot, nada mudou ainda: corrija (DNS, porta 80, e-mail) e
   rode o bloco de novo.

3. Siga a partir do [passo 9](#9-conferir) (conferir), já com os
   domínios. Como o endereço mudou, entre de novo no
   `https://supabase.brancaleone.com.br`: o login feito pelo IP não vale
   no domínio.

## Opcionais

- **Alertas** do Beszel e do Dozzle: [monitoramento.md](monitoramento.md#alertas-recomendados).
- **Backup no Google Drive:** [backup-google-drive.md](backup-google-drive.md).
  Num servidor novo, o endereço de retorno (redirect URI) das credenciais
  do Google muda para o domínio novo.
- **E-mails do Auth** (confirmação de cadastro, troca de senha): o `.env`
  vem com um SMTP de mentira (`SMTP_*`). Para o sistema mandar e-mail de
  verdade, preencha com um provedor real.
- **Painel de Schemas** publicando sozinho: [schemas-panel.md](schemas-panel.md).

## Manutenção

- **Certificado:** renova sozinho, mas ninguém avisa se falhar. De vez
  em quando rode `sudo certbot certificates`: a validade
  (`VALID: N days`) deve ficar acima de 30 dias, que é quando o certbot
  renova. Se estiver abaixo, veja o erro com
  `sudo journalctl -u certbot.service --since -7d --no-pager`. Não desligue
  o override `http`: sem a porta 80, a renovação para de funcionar.
- **Atualizar o Supabase** quando houver novidade neste repositório:
  `cd ~/supabase && git pull --ff-only && sh run.sh start` (recria só o
  que mudou) e, se mudou algo em `volumes/proxy/manual-tls/` (Nginx, login
  ou o site do painel), `sh run.sh recreate login nginx`.
- **Outro endereço no certificado** (um terceiro subdomínio, por
  exemplo): crie o registro A e rode
  `sudo certbot certonly --webroot -w /var/www/certbot --cert-name supabase.brancaleone.com.br -d supabase.brancaleone.com.br -d painel.brancaleone.com.br -d NOVO.brancaleone.com.br`
  (sempre com **todos** os nomes).
- O resto (cortar acesso de alguém, atualizar Dozzle/Beszel, problemas
  comuns) está em [monitoramento.md](monitoramento.md) e no
  [README](../README.md); onde eles falam em `supabase.primati.com.br:9443`,
  aqui é `supabase.brancaleone.com.br`, sem porta.
