# Supabase self-hosted no Oracle Cloud (convivendo com o AzuraCast)

Deploy do [Supabase](https://supabase.com) self-hosted (a stack Docker
oficial, gratuita) no servidor Oracle Cloud onde já roda a rádio
([AzuraCast](https://azuracast.com)). Este repositório contém uma cópia dos
arquivos oficiais de
[`supabase/supabase` (`docker/`)](https://github.com/supabase/supabase/tree/master/docker),
mais a configuração específica para esta instância.

> Levantamento do servidor feito em 2026-09-19 (veja
> [docs/oracle-cloud.md](docs/oracle-cloud.md)). Para atualizar depois, veja
> [Manutenção](#manutenção-e-atualizações).

## Diagnóstico do servidor (já feito)

- **Capacidade: sobra.** ARM Ampere A1, 2 OCPUs / 12 GB RAM (~10 GB
  disponíveis), 150 GB de disco livre, carga quase zero. O stack do
  Supabase (~12 containers) usa uns 2-4 GB — folga de sobra mesmo com a
  rádio rodando junto.
- **Docker 29.1.3 + Compose v5.3.1** já instalados — pula o Passo 3.
- **Conflito real, já resolvido no design deste repo:** o AzuraCast é dono
  das portas **80, 443** e de toda a faixa **8000-8999** (mounts de
  estação). Por isso o Supabase aqui:
  - fica atrás de um Nginx próprio numa porta nova (**9443**), sem tocar
    em nenhuma porta do AzuraCast;
  - usa certificado emitido manualmente via DNS-01 (não HTTP-01/TLS-ALPN-01,
    que exigiriam 80/443) — o Wix não tem API de DNS para automatizar isso.
  - Postgres/pooler (5432/6543) nunca ficam expostos publicamente.

Se quiser reconferir os números (RAM/disco/portas em uso) antes de seguir,
os comandos estão no fim do [docs/oracle-cloud.md](docs/oracle-cloud.md).

## O que sobe

Studio (dashboard), gateway de API (Envoy), Auth, PostgREST, Realtime,
Storage, imgproxy, postgres-meta, Edge Functions, Postgres e o pooler
(Supavisor) — tudo via `docker compose`, sem custo de licença.

## Passo 1 — Rede (Oracle Cloud) e DNS

Leia **[docs/oracle-cloud.md](docs/oracle-cloud.md)**: liberar a porta
**9443** (não 80/443 — são da rádio) no Security List/NSG *e* no `iptables`
da instância, e criar o registro DNS `A` de
`supabase.valletibooks.com.br` apontando para o IP público do servidor.

## Passo 2 — Clonar este repositório no servidor

```bash
ssh usuario@SEU_IP_PUBLICO
git clone https://github.com/luizprimati/supabase.git
cd supabase
```

## Passo 3 — Configurar `.env`

```bash
cp .env.example .env
sh utils/generate-keys.sh --update-env       # POSTGRES_PASSWORD, JWT_SECRET, ANON_KEY, SERVICE_ROLE_KEY...
sh utils/add-new-auth-keys.sh --update-env   # chaves de API assimétricas (novo formato)
```

Edite `.env` e ajuste (note a porta `9443` nas URLs):

```dotenv
SUPABASE_PUBLIC_URL=https://supabase.valletibooks.com.br:9443
API_EXTERNAL_URL=https://supabase.valletibooks.com.br:9443/auth/v1
SITE_URL=https://supabase.valletibooks.com.br:9443
PROXY_DOMAIN=supabase.valletibooks.com.br
DASHBOARD_USERNAME=escolha-um-usuario
DASHBOARD_PASSWORD=troque-esta-senha
SUPABASE_PROXY_PORT=9443
```

`.env` está no `.gitignore` — nunca será commitado.

## Passo 4 — Certificado HTTPS (manual, DNS-01)

Como 80/443 são do AzuraCast, o certificado não pode ser emitido
automaticamente pelas vias padrão. Siga
**[docs/certbot-manual-dns.md](docs/certbot-manual-dns.md)** — leva uns 2
minutos, envolve colar um registro TXT no painel do Wix. Precisa ser feito
antes do Passo 5 (o container do proxy não sobe saudável sem o certificado
já existir em `/etc/letsencrypt`).

## Passo 5 — Subir a stack

```bash
cp docker-compose.override.yml.example docker-compose.override.yml
sh run.sh config add manual-tls
sh run.sh config add override
sh run.sh start
```

- `manual-tls` ativa um Nginx próprio na porta 9443 (usando o certificado
  do Passo 4), enquanto o gateway e o Studio do Supabase ficam só na rede
  interna do Docker — nada novo publicado em 80/443/8000-8999, nada do
  AzuraCast é tocado.
- `override` restringe Postgres/pooler a `127.0.0.1` (nunca precisam ser
  públicos). Precisa ser adicionado explicitamente porque o `manual-tls`
  já deixa o `COMPOSE_FILE` explícito no `.env`, o que desliga o
  carregamento automático do `docker-compose.override.yml` pelo Docker
  Compose.

## Passo 6 — Validar

```bash
sh run.sh status
curl -kI https://supabase.valletibooks.com.br:9443
```

Abra `https://supabase.valletibooks.com.br:9443` no navegador — deve pedir
o usuário/senha do `DASHBOARD_USERNAME`/`DASHBOARD_PASSWORD` e abrir o
Studio.

Confirme que a rádio continua no ar normalmente em `http(s)://SEU_DOMINIO_DA_RADIO`
(nenhuma porta dela foi alterada).

Credenciais do Studio: `DASHBOARD_USERNAME`/`DASHBOARD_PASSWORD` do `.env`
(`sh run.sh secrets` **não** imprime o `DASHBOARD_USERNAME` — só o
`DASHBOARD_PASSWORD` — confira o usuário com `grep DASHBOARD_USERNAME .env`).

## Problemas conhecidos (troubleshooting)

Encontrados e resolvidos durante o deploy inicial neste servidor — deixando
registrado para não repetir o mesmo caminho:

- **`supabase-pooler` reiniciando em loop com `hostname: Temporary failure
  in name resolution`.** O Supavisor (Elixir/Erlang) tenta resolver o
  próprio hostname via DNS ao iniciar o modo distribuído, e isso falha
  nesse ambiente. Corrigido dando um `hostname` fixo ao container + uma
  entrada em `extra_hosts` apontando pra `127.0.0.1` (já incluído em
  `docker-compose.override.yml.example`).
- **`supabase-pooler` falhando com `failed to bind host port
  127.0.0.1:5432/tcp: address already in use`, mesmo sem nada ocupando a
  porta** (`ss`/`lsof` vazios). Causa: o Compose **soma** listas de
  `ports` entre arquivos por padrão, em vez de substituir — a porta
  5432 acabava com duas tentativas de bind (a original em `0.0.0.0` do
  `docker-compose.yml` base + a restrita em `127.0.0.1` do override), a
  segunda falhava e o Docker desfazia a criação do container inteiro,
  sem deixar rastro. Corrigido usando a tag `!override` (não `!reset`) na
  lista de portas do `supavisor` em `docker-compose.override.yml` — ela
  **substitui** a lista em vez de somar.
- **Nunca rode `sudo systemctl restart docker` neste servidor sem saber o
  que está fazendo.** Ele reinicia (não só "reconecta") todos os
  containers, **incluindo o AzuraCast** — já causou uma queda real da
  rádio durante esse processo. Prefira `docker restart <container>` ou
  `sh run.sh restart <serviço>` para agir só no container específico.

## Segurança — não pule isto

- **Nunca** libere 5432/6543 (Postgres/pooler) no Security List/NSG — o
  `docker-compose.override.yml` do Passo 5 já os restringe a `127.0.0.1`.
- Troque `DASHBOARD_PASSWORD` para algo forte antes de expor publicamente.
- Guarde uma cópia do `.env` em um cofre de senhas (1Password, Bitwarden) —
  se perder `JWT_SECRET`/`SERVICE_ROLE_KEY`, todos os tokens emitidos
  deixam de validar.
- Configure backup do volume `volumes/db/data` (ou do Postgres via
  `pg_dump`) — não há backup automático nesta stack.
- Configure um lembrete para renovar o certificado a cada ~60 dias (veja
  [docs/certbot-manual-dns.md](docs/certbot-manual-dns.md)) — não é
  automático nesse modo.

## Manutenção e atualizações

```bash
sh run.sh status              # ver containers
sh run.sh logs [serviço]      # acompanhar logs
sh run.sh restart [serviço]   # reiniciar um serviço específico (ex: nginx após renovar cert)
sh run.sh secrets             # reimprimir senhas/keys já geradas em .env
sh update.sh                  # atualizar para uma versão mais nova do Supabase
```

`update.sh` faz merge de 3 vias contra o snapshot original (`.supabase-version`)
— revise o diff antes de aplicar em produção.

## Referência

- Guia oficial: <https://supabase.com/docs/guides/self-hosting/docker>
- `CONFIG.md` (neste repo) — todas as variáveis de ambiente documentadas.
- `docs/oracle-cloud.md` — rede/firewall/DNS específicos deste servidor.
- `docs/certbot-manual-dns.md` — emissão/renovação do certificado.
