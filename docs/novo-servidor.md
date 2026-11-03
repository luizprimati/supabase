# Instalar num servidor novo (Oracle, Ubuntu, só Supabase)

Passo a passo para montar a mesma estrutura deste repositório (Supabase +
tela de login/painel `/admin` + Dozzle + Beszel + limite de logs) num
servidor Oracle **dedicado**, com o projeto começando vazio.

O que muda em relação ao servidor atual, que divide a máquina com a rádio:

| | Servidor atual (com AzuraCast) | Servidor novo (só Supabase) |
|---|---|---|
| Endereço | `https://dominio:9443` | `https://dominio` (porta 443 padrão); `http://dominio` redireciona para ele |
| Certificado HTTPS | Manual, pelo DNS do registro.br, a cada ~60 dias | **Automático**: renova sozinho pela porta 80, sem parar nada |
| Portas abertas | 9443 | 80 e 443 |
| Overrides (`sh run.sh config`) | `manual-tls`, `override`, `monitoring`, `monitoring-agent` | os mesmos **+ `http`** (porta 80) |

Todo o resto (painel, Edge Functions, Secrets, Dozzle, Beszel, limite de
logs) é igual. Os comandos abaixo param no primeiro erro: se algum
falhar, corrija e rode o mesmo bloco de novo.

## 0. Antes de começar

- **Instância:** shape `VM.Standard.A1.Flex` (ARM), imagem **Canonical
  Ubuntu 24.04** (aarch64). Recursos: 4 OCPUs / 24 GB se a conta tiver a
  cota gratuita livre; o mínimo confortável é 2 OCPUs / 12 GB. Disco de
  inicialização: 100 GB ou mais (a cota gratuita dá 200 GB no total).
- **IP público** na instância. Recomendado reservar um IP fixo
  (**Networking → IP Management → Reserved Public IPs**), senão o IP muda
  se a instância for recriada.
- **Domínio ou subdomínio** que você controla, por exemplo
  `supabase2.primati.com.br`.
- Um **e-mail** para o cadastro na Let's Encrypt.

## 1. Rede na Oracle (console)

Na conta Oracle do servidor novo: **Menu ☰ → Networking → Virtual Cloud
Networks → (a VCN da instância) → Security Lists → Default Security
List** → **Add Ingress Rules**, duas regras:

| Origem | Protocolo | Porta destino | Para quê |
|---|---|---|---|
| `0.0.0.0/0` | TCP | 80 | Web: redireciona para o HTTPS e renova o certificado |
| `0.0.0.0/0` | TCP | 443 | Supabase, painel, Dozzle e Beszel |

Não abra 5432, 6543, 8000 nem 3000: banco, pooler, gateway e Studio
nunca ficam públicos.

> **Pegadinha já vista no servidor atual:** um Network Security Group
> (NSG) só vale se estiver anexado à placa de rede da instância
> (**Compute → Instances → instância → Attached VNICs → VNIC → Network
> Security Groups**). Na dúvida, use a Security List, como acima.

## 2. DNS

No painel de DNS do domínio (no registro.br: **Meus domínios →
domínio → DNS**), crie um registro **A** com o nome do subdomínio
apontando para o IP público da instância. Confira de qualquer lugar:

```bash
dig +short supabase2.primati.com.br
```

Só siga para o passo 4 (certificado) quando aparecer o IP certo.

## 3. Preparar o servidor (SSH)

Entre com `ssh ubuntu@IP_DO_SERVIDOR`.

**3.1. Seus dados, uma vez só.** Os próximos blocos leem daqui, então
funcionam mesmo se você abrir outra sessão SSH no meio:

```bash
printf 'DOMINIO=supabase2.primati.com.br\nEMAIL=voce@exemplo.com\n' > ~/novo-servidor.conf && nano ~/novo-servidor.conf
```

Troque pelo seu domínio e e-mail, salve (Ctrl+O, Enter) e saia (Ctrl+X).

**3.2. Atualizar e abrir 80/443 no firewall da instância.** A imagem
Ubuntu da Oracle vem com um firewall (`iptables`) que recusa tudo, menos
SSH. Este passo vem **antes** de instalar o Docker de propósito: o
`netfilter-persistent save` grava as regras atuais, e com o Docker
instalado ele gravaria também as regras dinâmicas do Docker.

```bash
sudo apt-get update && sudo apt-get -y upgrade \
  && sudo iptables -I INPUT -p tcp --dport 80 -m state --state NEW -j ACCEPT \
  && sudo iptables -I INPUT -p tcp --dport 443 -m state --state NEW -j ACCEPT \
  && sudo netfilter-persistent save \
  && sudo iptables -L INPUT -n --line-numbers
```

As regras de 80 e 443 têm que aparecer **antes** da linha `REJECT`. Se o
`upgrade` atualizou o kernel, reinicie agora (`sudo reboot`) e entre de
novo.

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

A Let's Encrypt confere que você controla o domínio acessando a porta 80
do servidor. Nesta primeira vez o Supabase ainda não está no ar, então o
próprio certbot atende a porta 80 por alguns segundos (`--standalone`).
Depois que tudo subir (passo 6), a renovação passa a ser feita pelo Nginx
do Supabase, sem parar nada. O gancho criado aqui faz o Nginx reler o
certificado a cada renovação.

```bash
. ~/novo-servidor.conf && sudo apt-get install -y certbot \
  && sudo certbot certonly --standalone -d "$DOMINIO" -m "$EMAIL" --agree-tos --no-eff-email \
  && sudo mkdir -p /var/www/certbot \
  && printf '#!/bin/sh\n# Certificado renovado: o Nginx do Supabase relê os arquivos sem derrubar nada.\ndocker exec supabase-nginx-manual nginx -s reload\n' | sudo tee /etc/letsencrypt/renewal-hooks/deploy/recarregar-nginx-supabase.sh > /dev/null \
  && sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/recarregar-nginx-supabase.sh \
  && sudo ls /etc/letsencrypt/live/"$DOMINIO"/
```

O esperado: `Successfully received certificate` e, na última linha,
`cert.pem chain.pem fullchain.pem privkey.pem README`. Se a Let's Encrypt
não conseguir falar com o servidor (`Timeout during connect`), a porta 80
ainda está fechada na Security List (passo 1) ou no `iptables` (passo
3.2), ou o DNS (passo 2) ainda não aponta para este IP.

## 5. Baixar o projeto e gerar as chaves

As chaves (senha do banco, JWT, chaves da API) são novas e só deste
servidor. Os scripts gravam direto no `.env`; a saída vai para
`/dev/null` para as chaves não ficarem na tela.

```bash
. ~/novo-servidor.conf && cd ~ && git clone https://github.com/luizprimati/supabase.git && cd ~/supabase \
  && cp .env.example .env && chmod 600 .env \
  && sh utils/generate-keys.sh --update-env > /dev/null \
  && sh utils/add-new-auth-keys.sh --update-env > /dev/null \
  && sed -i \
       -e "s|^SUPABASE_PUBLIC_URL=.*|SUPABASE_PUBLIC_URL=https://$DOMINIO|" \
       -e "s|^API_EXTERNAL_URL=.*|API_EXTERNAL_URL=https://$DOMINIO/auth/v1|" \
       -e "s|^SITE_URL=.*|SITE_URL=https://$DOMINIO|" \
       -e "s|^PROXY_DOMAIN=.*|PROXY_DOMAIN=$DOMINIO|" .env \
  && printf '\nSUPABASE_PROXY_PORT=443\nBESZEL_USER_PASSWORD=%s\n' "$(openssl rand -hex 24)" >> .env \
  && grep -E '^(SUPABASE_PUBLIC_URL|API_EXTERNAL_URL|SITE_URL|PROXY_DOMAIN|SUPABASE_PROXY_PORT)=' .env \
  && grep -c '^JWT_SECRET=.\{32,\}' .env
```

Tem que aparecer as cinco linhas com o seu domínio e, na última, `1`
(o `JWT_SECRET` foi gerado).

Opcional: o texto da tela de abertura. Sem isto ela mostra o título do
servidor atual. Acrescente no `.env` (com `nano ~/supabase/.env`):

```dotenv
PROJECT_TITLE=Nome do projeto
PROJECT_TAGLINE=Painel administrativo
PROJECT_DESCRIPTION=Área restrita à equipe autorizada.
```

## 6. Subir tudo

Cria os arquivos que precisam existir antes da primeira subida, liga os
overrides (Nginx + login, banco só em `127.0.0.1`, porta 80,
monitoramento) e sobe.
A primeira vez baixa as imagens (alguns GB) e leva alguns minutos. No fim,
troca a senha do superusuário do Beszel por uma aleatória (ver
[monitoramento.md](monitoramento.md)).

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

**Renovação pelo Nginx.** Agora que o Nginx atende a porta 80, a
renovação do certificado passa a usar a pasta `/var/www/certbot` (que ele
serve em `/.well-known/acme-challenge/`) em vez do `--standalone`, que
precisaria da porta 80 livre. O `reconfigure` já testa a renovação nova;
o `renew --dry-run` confirma:

```bash
. ~/novo-servidor.conf && sudo certbot reconfigure --cert-name "$DOMINIO" --webroot --webroot-path /var/www/certbot \
  && sudo certbot renew --dry-run \
  && systemctl list-timers certbot.timer --no-pager
```

O esperado: `Congratulations, all simulated renewals succeeded` e o
`certbot.timer` agendado (ele confere duas vezes por dia e só renova perto
do vencimento).

## 7. Criar o primeiro admin do painel

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

Abra `https://SEU_DOMINIO` no navegador, clique em **Entrar** e use esse
usuário. Os outros usuários você cria pelo `/admin` → **Usuários**.

## 8. Conectar o agente do Beszel

1. Abra `https://SEU_DOMINIO/beszel/` e clique em **Add System**, na
   aba **Docker**.
2. **Name:** o nome do servidor. **Host / IP:**
   `/beszel_socket/beszel.sock` (o campo de porta some sozinho).
3. Copie a **Public Key** e clique em **Add System**.
4. No servidor, cole a chave quando o bloco pedir:

```bash
cd ~/supabase && read -r -p 'Cole a Public Key: ' K && printf "BESZEL_AGENT_KEY='%s'\n" "$K" >> .env && sh run.sh config add monitoring-agent && sh run.sh start beszel-agent
```

Em até 1 minuto o sistema fica verde no Beszel.

## 9. Conferir

```bash
. ~/novo-servidor.conf && cd ~/supabase && sh run.sh status \
  && curl -s -o /dev/null -w 'site: %{http_code}\n' "https://$DOMINIO/login" \
  && curl -s -o /dev/null -w 'http: %{http_code} -> %{redirect_url}\n' "http://$DOMINIO/login" \
  && curl -s -o /dev/null -w 'dozzle sem login: %{http_code} -> %{redirect_url}\n' "https://$DOMINIO/dozzle/" \
  && sudo ss -tlnp | grep -E ':(80|443|3000|5432|6543|8000)\s'
```

O esperado:
- todos os serviços `Up` (e `healthy` os que têm healthcheck);
- `site: 200`, `http: 301 -> https://SEU_DOMINIO/login` e
  `dozzle sem login: 302 -> https://SEU_DOMINIO/login?rd=/dozzle/`;
- na lista de portas, só a **80** e a **443** abertas para fora
  (`0.0.0.0`), e a 5432/6543 em `127.0.0.1`.

## Opcionais

- **Alertas** do Beszel e do Dozzle: [monitoramento.md](monitoramento.md#alertas-recomendados).
- **Backup no Google Drive:** [backup-google-drive.md](backup-google-drive.md).
  Num servidor novo, o endereço de retorno (redirect URI) das credenciais
  do Google muda para o domínio novo.
- **E-mails do Auth** (confirmação de cadastro, troca de senha): o `.env`
  vem com um SMTP de mentira (`SMTP_*`). Para o app mandar e-mail de
  verdade, preencha com um provedor real.
- **Painel de Schemas** publicando sozinho: [schemas-panel.md](schemas-panel.md).

## Manutenção

- **Certificado:** nada a fazer. Para conferir:
  `sudo certbot certificates` (mostra a validade). Não desligue o
  override `http`: sem a porta 80, a renovação para de funcionar.
- **Atualizar o projeto** quando houver novidade neste repositório:
  `cd ~/supabase && git pull --ff-only && sh run.sh start` (recria só o
  que mudou) e, se mudou o Nginx ou o login, `sh run.sh restart nginx`.
- O resto (cortar acesso de alguém, atualizar Dozzle/Beszel, problemas
  comuns) está em [monitoramento.md](monitoramento.md) e no
  [README](../README.md); onde eles falam em `:9443`, no servidor novo é
  o endereço sem porta.
