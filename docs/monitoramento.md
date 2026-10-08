# Monitoramento: Dozzle e Beszel

Duas ferramentas gratuitas (licença MIT), leves (~32 MB de RAM as três
peças juntas) e acessíveis pelo navegador, atrás do mesmo Nginx e login do
Supabase:

| Endereço | Ferramenta | Para que serve |
|---|---|---|
| `https://supabase.primati.com.br:9443/beszel/` | **Beszel** | Saúde do **servidor**: CPU, memória, disco, rede e carga reais, com histórico e alertas. Também lista os containers. |
| `https://supabase.primati.com.br:9443/dozzle/` | **Dozzle** | **Logs ao vivo** de todos os containers (rádio, chat-IA e Supabase), com busca, filtros e download, e CPU/memória/rede/disco de cada container. |

Os dois enxergam **todos** os containers do servidor, por isso só
**administradores** do painel entram. Usuário comum recebe "acesso
negado", e quem não está logado cai na tela de login. Para admins, o
painel (`/login` e `/admin`) mostra atalhos para os dois.

## Como funciona (e por que é seguro)

- Nada é publicado no host: nenhuma porta nova, nenhum certificado novo,
  nenhuma regra nova no firewall da Oracle. Tudo passa pela 9443.
- Quem decide quem entra é o login-server (rota `/auth-admin`, só admin).
  O Nginx repassa o usuário aos apps num header que **ele mesmo sempre
  define** (o que vier do navegador é descartado). Cada app fica numa rede
  Docker só dele com o Nginx, então nenhum outro container fala com eles
  direto.
- **Dozzle** (`DOZZLE_AUTH_PROVIDER=forward-proxy`):
  - Permissões fixas no Nginx: ver e baixar logs, e criar alertas.
  - **Não** é possível reconfigurar o Dozzle pela tela, ligar o Dozzle
    Cloud, nem parar, reiniciar ou abrir terminal em containers. Essas
    rotas nem existem.
  - Estatísticas de uso para o autor: desligadas.
  - Versão fixa (v11.3.0). Ela corrige todos os alertas de segurança de
    2026.
- **Beszel**:
  - Login por senha desligado. A única entrada é o header do Nginx, que
    loga como o usuário interno `monitor@beszel.local`.
  - Esse usuário é criado na primeira subida, então a tela de "primeiro
    acesso cria a conta" nunca existe.
  - O painel interno do banco dele (PocketBase, `/beszel/_/`) fica fechado
    (404).
- O agente do Beszel roda na rede do host, para medir a placa de rede real.
  Ele conversa com o hub por um socket de arquivo num volume compartilhado,
  sem porta.

> **Atenção:** os dois precisam do socket do Docker para ler os containers.
> Quem controla o socket controla o Docker, e o `:ro` não limita isso. É por
> isso que o acesso é só de admin e que as ações do Dozzle ficam desligadas.

## Instalar (uma vez)

No servidor, na pasta do projeto:

```bash
cd ~/supabase && git status --short && git pull

# 1. Senha interna do Beszel (ninguém digita; só precisa ser forte e ficar no .env)
echo "BESZEL_USER_PASSWORD=$(openssl rand -hex 24)" >> .env

# 2. Liga o override e recria tudo de uma vez (aplica também o limite de
#    logs em todos os containers). O Supabase fica fora do ar ~1 minuto.
#    A rádio não é tocada. O agente do Beszel fica para o passo 3.
sh run.sh config add monitoring
sh run.sh recreate --except beszel-agent
sh run.sh restart nginx
```

**3. Conectar o agente do Beszel.** É o único passo pela tela:

1. Abra `https://supabase.primati.com.br:9443/beszel/` e clique em
   **Add System**, na aba **Docker**.
2. **Name:** `oracle` (ou o que preferir). **Host / IP:**
   `/beszel_socket/beszel.sock`. O campo de porta some sozinho.
3. Clique no botão de copiar do campo **Public Key** e depois em **Add
   System**.
4. No servidor, cole a chave no `.env`, entre aspas simples, e suba o
   agente:

```bash
nano ~/supabase/.env      # BESZEL_AGENT_KEY='ssh-ed25519 AAAA...'
cd ~/supabase && sh run.sh start beszel-agent
```

Em até um minuto o sistema aparece verde no Beszel, com CPU, memória,
disco e rede.

## Alertas recomendados

**Beszel** (sininho no sistema, e Settings → Notifications para o
destino):
- **Status:** avisar quando o servidor ficar offline.
- **Disco:** acima de 85%.
- **Memória:** acima de 90% por 10 minutos.
- **CPU:** acima de 90% por 10 minutos.

Destinos: Telegram, Discord, ntfy, Slack ou webhook (formato Shoutrrr,
ex.: `telegram://TOKEN@telegram?chats=ID`). E-mail exige configurar SMTP
no painel do PocketBase, que está fechado. Se quiser e-mail, peça para
liberar.

**Dozzle** (sininho no topo):
- **Container parou ou ficou unhealthy.** Evento, para todos os
  containers.
- **Linha de erro no log** de containers importantes. Por exemplo, nível
  `error` no `supabase-db` ou no `azuracast`.

Destinos: webhook, Slack, Discord ou ntfy.

## Limites (o que cada um não faz)

- **Dozzle:**
  - Mostra só o que o Docker guarda de log: até ~50 MB por container
    (5 arquivos de 10 MB) e 5 MB na rádio. Ao recriar um container, o
    histórico dele zera.
  - Logs que um programa grava em arquivo **dentro** do container não
    aparecem. Só a saída padrão.
  - O "Memory" do card do servidor no Dozzle é a soma dos containers. Use o
    Beszel para a memória real.
- **Beszel:** não lê logs. Para isso existe o Dozzle.
- **Nenhum dos dois** avisa sobre o certificado HTTPS perto de vencer. A
  renovação continua manual (ver [certbot-manual-dns.md](certbot-manual-dns.md)).

## Atualizar as versões

As versões são fixas no `docker-compose.monitoring.yml` (`amir20/dozzle:v11.3.0`,
`henrygd/beszel:0.21.0`, `henrygd/beszel-agent:0.21.0`), de propósito.
Atualize trocando a tag depois de ler as notas da versão, principalmente
os alertas de segurança do Dozzle
(https://github.com/amir20/dozzle/security/advisories). Depois rode:

```bash
cd ~/supabase && docker compose pull dozzle beszel beszel-agent
sh run.sh recreate dozzle beszel beszel-agent
```

## Problemas comuns

- **`/dozzle/` ou `/beszel/` dá 502:** o container está parado. Rode
  `docker compose ps dozzle beszel` e `docker compose logs dozzle`. O resto
  da 9443 continua funcionando, porque o Nginx só procura os apps na hora
  de cada acesso.
- **Qualquer `docker compose` reclama de `BESZEL_USER_PASSWORD`:** a linha
  sumiu do `.env`. Ela precisa continuar lá. Recoloque a **mesma** senha,
  se tiver, ou qualquer senha forte. O Beszel só usa essa senha na
  primeira subida.
- **Sistema "down" no Beszel:** confira se o `BESZEL_AGENT_KEY` é a chave
  da tela Add System (`docker compose logs beszel-agent`).
- **Disco errado no Beszel** (tamanho diferente dos 193 GB do `df -h /`,
  ou o log do agente fala em `Root I/O unmapped`): acrescente
  `FILESYSTEM: sda1` no `environment` do `beszel-agent` em
  `docker-compose.monitoring.yml` e rode `sh run.sh recreate beszel-agent`.

## Desligar

```bash
cd ~/supabase && docker compose rm -sf dozzle beszel beszel-agent
sh run.sh config remove monitoring
sh run.sh recreate login nginx
```
