# Supabase self-hosted no Oracle Cloud

Deploy do [Supabase](https://supabase.com) self-hosted (a stack Docker
oficial, gratuita) no servidor Oracle Cloud onde já roda a rádio. Este
repositório contém uma cópia dos arquivos oficiais de
[`supabase/supabase` (`docker/`)](https://github.com/supabase/supabase/tree/master/docker),
mais a configuração e os scripts específicos para essa instância (rede da
Oracle Cloud, DNS, proxy reverso convivendo com a rádio).

> Snapshot capturado em 2026-09-19. Para atualizar depois, veja
> [Manutenção](#manutenção-e-atualizações).

## O que sobe

Studio (dashboard), gateway de API (Envoy), Auth, PostgREST, Realtime,
Storage, imgproxy, postgres-meta, Edge Functions, Postgres e o pooler
(Supavisor) — tudo via `docker compose`, sem custo de licença.

## Pré-requisitos

- Acesso SSH ao servidor Oracle (você roda os comandos abaixo *no servidor*,
  não aqui — esta sessão não tem acesso à sua infraestrutura).
- Ubuntu ou Oracle Linux na instância (o `setup.sh`/scripts abaixo cobrem os
  dois).
- Um subdomínio livre em `valletibooks.com.br` (ex:
  `supabase.valletibooks.com.br`) — veja o passo de DNS abaixo.

## Passo 1 — Rede (Oracle Cloud)

Leia **[docs/oracle-cloud.md](docs/oracle-cloud.md)** primeiro: cobre as
duas camadas de firewall da OCI (Security List/NSG *e* iptables da própria
instância — é fácil liberar só uma e achar que "não funciona"), como
verificar se a rádio já ocupa a porta 80/443, e como criar o registro DNS no
Wix.

Resumo do essencial:
1. Liberar 80/443 no Security List ou NSG da VCN.
2. Liberar 80/443 no `iptables`/`firewalld` da instância.
3. Criar o registro `A` de `supabase.valletibooks.com.br` apontando para o
   IP público (de preferência reservado) da instância.
4. Confirmar se a rádio já usa Nginx/Caddy na 80/443 nessa instância — isso
   decide qual opção do Passo 4 usar.

## Passo 2 — Clonar este repositório no servidor

```bash
ssh usuario@SEU_IP_PUBLICO
git clone https://github.com/luizprimati/supabase.git
cd supabase
```

## Passo 3 — Instalar Docker (se ainda não tiver)

```bash
docker compose version || sh setup.sh -y --project-dir /tmp/_supabase_setup
```

(pede sua senha de `sudo` quando precisar instalar pacotes.) O `setup.sh`
oficial instala Docker Engine + plugin Compose e depois cria um projeto
**novo** em `--project-dir` (fluxo pensado para quem ainda não tem um
repositório próprio). Como você já tem este repo, use-o **só para instalar
o Docker** e depois apague a pasta temporária:

```bash
rm -rf /tmp/_supabase_setup
```

Se preferir instalar o Docker manualmente, siga a
[documentação oficial](https://docs.docker.com/engine/install/) — qualquer
forma serve, o que importa é `docker compose version` funcionar depois.

## Passo 4 — Configurar `.env`

```bash
cp .env.example .env
sh utils/generate-keys.sh --update-env       # POSTGRES_PASSWORD, JWT_SECRET, ANON_KEY, SERVICE_ROLE_KEY...
sh utils/add-new-auth-keys.sh --update-env   # chaves de API assimétricas (novo formato)
```

Edite `.env` e ajuste:

```dotenv
SUPABASE_PUBLIC_URL=https://supabase.valletibooks.com.br
API_EXTERNAL_URL=https://supabase.valletibooks.com.br/auth/v1
SITE_URL=https://supabase.valletibooks.com.br
PROXY_DOMAIN=supabase.valletibooks.com.br
CERTBOT_EMAIL=seu-email@exemplo.com
DASHBOARD_USERNAME=escolha-um-usuario
DASHBOARD_PASSWORD=troque-esta-senha
```

`.env` está no `.gitignore` — nunca será commitado.

## Passo 5 — Proxy reverso: escolha uma opção

### Opção A — Nada rodando na 80/443 ainda (Caddy cuida do HTTPS sozinho)

```bash
sh run.sh config add caddy
sh run.sh start
```

O Caddy sobe nos containers, pega certificado Let's Encrypt automaticamente
para `PROXY_DOMAIN` e expõe Studio + API na 80/443.

### Opção B — A rádio já usa Nginx/Caddy na 80/443 nessa instância

Não use `run.sh config add caddy`/`nginx` (eles tentam tomar as portas
80/443 para si). Em vez disso:

1. Restrinja a porta do gateway do Supabase a `127.0.0.1`:
   ```bash
   cp docker-compose.override.yml.example docker-compose.override.yml
   ```
2. Suba a stack:
   ```bash
   sh run.sh start
   ```
3. Configure o Nginx **do host** para fazer proxy do subdomínio para
   `127.0.0.1:8000`, usando
   [docs/nginx-existente.conf.example](docs/nginx-existente.conf.example)
   como modelo (inclui os `location` de Realtime/Storage que precisam de
   configuração especial — sem eles, upload de arquivo grande e websockets
   quebram).
4. Gere o certificado com certbot para o novo subdomínio (`certbot --nginx
   -d supabase.valletibooks.com.br`), sem mexer no vhost da rádio.

## Passo 6 — Validar

```bash
sh run.sh status
curl -I https://supabase.valletibooks.com.br
```

Abra `https://supabase.valletibooks.com.br` no navegador — deve pedir o
usuário/senha do `DASHBOARD_USERNAME`/`DASHBOARD_PASSWORD` e abrir o Studio.

Confirme que a rádio continua no ar normalmente (nenhuma porta dela deve ter
mudado).

## Segurança — não pule isto

- **Nunca** libere 5432/6543 (Postgres/pooler) no Security List/NSG. Use o
  `docker-compose.override.yml` (Passo 5B) mesmo se for pela Opção A —
  essas portas não precisam estar acessíveis de lugar nenhum além do próprio
  servidor.
- Troque `DASHBOARD_PASSWORD` para algo forte antes de expor publicamente.
- Guarde uma cópia do `.env` em um cofre de senhas (1Password, Bitwarden) —
  se perder `JWT_SECRET`/`SERVICE_ROLE_KEY`, todos os tokens emitidos
  deixam de validar.
- Configure backup do volume `volumes/db/data` (ou do Postgres via
  `pg_dump`) — não há backup automático nesta stack.

## Manutenção e atualizações

```bash
sh run.sh status              # ver containers
sh run.sh logs [serviço]      # acompanhar logs
sh run.sh restart [serviço]   # reiniciar um serviço específico
sh run.sh secrets             # reimprimir senhas/keys já geradas em .env
sh update.sh                  # atualizar para uma versão mais nova do Supabase
```

`update.sh` faz merge de 3 vias contra o snapshot original (`.supabase-version`)
— revise o diff antes de aplicar em produção.

## Referência

- Guia oficial: <https://supabase.com/docs/guides/self-hosting/docker>
- `CONFIG.md` (neste repo) — todas as variáveis de ambiente documentadas.
- `docs/oracle-cloud.md` — rede/firewall/DNS específicos da Oracle Cloud.
