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
  O Nginx repassa o usuário aos apps num header que **ele sempre
  sobrescreve** (o que vier do navegador é descartado).
- Cada app fica numa rede Docker só dele com o Nginx, então nenhum outro
  **container** fala com eles direto. Processos rodando no próprio host
  (o usuário `ubuntu`/root e o agente do Beszel) alcançam o IP deles e
  poderiam mandar esses headers direto. É o mesmo nível de exposição que o
  Studio e o pg-meta já têm. Por isso: não crie usuários Linux sem
  privilégio nesse servidor nem rode outros containers com
  `network_mode: host`.
- **Dozzle** (`DOZZLE_AUTH_PROVIDER=forward-proxy`):
  - Permissões fixas no Nginx: ver e baixar logs, e criar alertas.
  - **Não** é possível reconfigurar o Dozzle pela tela, ligar o Dozzle
    Cloud, nem parar, reiniciar ou abrir terminal em containers. Essas
    rotas nem existem.
  - Estatísticas de uso para o autor e avatares externos: desligados.
  - Versão fixa (v11.3.0). Ela corrige todos os alertas de segurança de
    2026.
- **Beszel**:
  - O usuário não entra por senha. A única entrada é o header do Nginx,
    que loga como o usuário interno `monitor@beszel.local`.
  - Esse usuário é criado na primeira subida, então a tela de "primeiro
    acesso cria a conta" nunca existe.
  - O superusuário do banco dele (PocketBase) nasce com a senha do `.env`,
    que a instalação troca por uma aleatória que ninguém sabe. A tela
    (`/beszel/_/`) e a API dele ficam fechadas (404) no Nginx.
- O agente do Beszel roda na rede do host, para medir a placa de rede real.
  Ele conversa com o hub por um socket de arquivo num volume compartilhado,
  sem porta.
- **Mesma origem.** O Dozzle, o Beszel, o Studio, o `/admin` e o conteúdo
  do Storage/REST/Functions ficam todos em `https://...:9443`. Por isso:
  - O que vem do gateway e o navegador abriria como página (HTML, SVG,
    XML) vai isolado (`Content-Security-Policy: sandbox`): um SVG com
    script num bucket, aberto por um admin, não age com a sessão dele.
    JSON, imagens, PDF, vídeo e downloads não mudam. Efeito colateral: uma
    Edge Function que sirva página HTML com JavaScript não roda o script.
  - POST/PUT/DELETE vindos de outro site do domínio (outra porta ou
    subdomínio de `primati.com.br`) são recusados no `/admin`, `/dozzle/` e
    `/beszel/`.
  - O cookie da sessão do painel não é repassado aos dois apps.
- **Quem entrou no painel:** cada tentativa de login vira uma linha no log
  do container `supabase-studio-login` (`login-ok admin usuario="luiz"
  ip=...` ou `login-falhou ...`). Veja no Dozzle ou com
  `cd ~/supabase && docker compose logs login | grep login-`.

> **Atenção:** os dois precisam do socket do Docker para ler os containers.
> Quem controla o socket controla o Docker, e o `:ro` não limita isso. É por
> isso que o acesso é só de admin e que as ações do Dozzle ficam desligadas.

## Instalar (uma vez)

Tudo no servidor. Cada bloco para no primeiro erro e pode ser rodado de
novo depois de corrigir o problema.

**0. (Opcional) Guardar os logs atuais.** O passo 1 recria todos os
containers do Supabase, e o log de cada um começa do zero: o limite de
logs só vale para container novo, então não tem como evitar. Se quiser
guardar o histórico (uns 200 MB):

```bash
cd ~/supabase && mkdir -p ~/logs-antes-monitoramento && for s in $(docker compose config --services); do docker compose logs --no-color -t "$s" > ~/logs-antes-monitoramento/"$s".log 2>&1; done; du -sh ~/logs-antes-monitoramento
```

**1. Supabase: monitoramento e limite de logs.** Gera a senha interna do
Beszel (só se ainda não existir), liga o override, recria tudo, reinicia o
Nginx e troca a senha do superusuário do Beszel por uma aleatória. O
Supabase fica fora do ar 1 a 2 minutos. A rádio não é tocada.

```bash
cd ~/supabase && git pull --ff-only \
  && { grep -q '^BESZEL_USER_PASSWORD=.' .env || echo "BESZEL_USER_PASSWORD=$(openssl rand -hex 24)" >> .env; } \
  && sh run.sh config add monitoring \
  && sh run.sh start \
  && sh run.sh restart nginx \
  && docker exec supabase-beszel /beszel superuser upsert monitor@beszel.local "$(openssl rand -hex 32)"
```

Se o `git pull` reclamar de alterações locais ou de branches divergentes,
pare e resolva antes (`git status`). Nada foi alterado ainda.

**2. chat-IA: limite de logs.** É outro projeto: o `run.sh` do Supabase
não mexe nele. Recria os 3 containers do chat-IA, então a 9444 fica fora
alguns segundos e o Ollama descarrega o modelo (a primeira resposta
depois fica mais lenta). A rádio e o Supabase não são tocados.

```bash
cd ~/chat-IA && git pull --ff-only && docker compose up -d
```

**3. Conectar o agente do Beszel.** É o único passo pela tela:

1. Abra `https://supabase.primati.com.br:9443/beszel/` e clique em
   **Add System**, na aba **Docker**.
2. **Name:** `oracle` (ou o que preferir). **Host / IP:**
   `/beszel_socket/beszel.sock`. O campo de porta some sozinho.
3. Clique no botão de copiar do campo **Public Key** e depois em **Add
   System**.
4. No servidor, rode o bloco abaixo, cole a chave quando ele pedir e
   tecle Enter. Ele grava a chave no `.env`, liga o override do agente e
   sobe só o agente:

```bash
cd ~/supabase && read -r -p 'Cole a Public Key: ' K && printf "BESZEL_AGENT_KEY='%s'\n" "$K" >> .env && sh run.sh config add monitoring-agent && sh run.sh start beszel-agent
```

Em até um minuto o sistema aparece verde no Beszel, com CPU, memória,
disco e rede. É a tela que confirma: o comando termina OK mesmo com a
chave errada. Se não ficar verde, veja "Problemas comuns".

**4. Conferir o limite de logs** dos dois projetos:

```bash
for c in $(docker ps -q); do docker inspect -f '{{.Name}} {{.HostConfig.LogConfig.Config}}' $c; done
```

Todos os `supabase-*`, `chat-ia-*` e o agente devem mostrar
`map[max-file:5 max-size:10m]`. A rádio (`azuracast`) mantém o próprio
limite.

## Alertas recomendados

**Beszel** (sininho no sistema, e Settings → Notifications para o
destino):
- **Status:** avisar quando o servidor ficar offline. É também o alerta
  que pega o agente desconectado.
- **Disco:** acima de 85%.
- **Memória:** acima de 90% por 10 minutos.
- **CPU:** acima de 90% por 10 minutos.

Destinos: Telegram, Discord, ntfy, Slack ou webhook (formato Shoutrrr,
ex.: `telegram://TOKEN@telegram?chats=ID`). E-mail exige configurar SMTP
no painel do PocketBase, que está fechado. Se quiser e-mail, peça para
liberar.

**Dozzle** (sininho no topo):
- **Container parou ou ficou unhealthy.** Evento, para todos os
  containers. O agente do Beszel não tem healthcheck (o da versão 0.21
  nunca falha); para ele vale o "Status" do Beszel acima.
- **Linha de erro no log** de containers importantes. Por exemplo, nível
  `error` no `supabase-db` ou no `azuracast`.

Destinos: webhook, Slack, Discord ou ntfy.

## Tirar o acesso de alguém

Remover ou rebaixar um admin no `/admin` bloqueia na hora qualquer acesso
novo ao `/dozzle/` e ao `/beszel/`. Mas os logs e gráficos que essa pessoa
já tem abertos continuam chegando até ela fechar a aba. Para cortar na
hora:

```bash
cd ~/supabase && sh run.sh restart dozzle beszel
```

Quem continua admin reconecta sozinho em poucos segundos. Não use
`nginx -s reload` para isso (não corta as conexões abertas), e
`restart nginx` corta, mas derruba a 9443 inteira por uns segundos. Num
computador compartilhado, feche as abas do Dozzle e do Beszel antes de
sair: o "Sair" não fecha abas abertas.

## Limites (o que cada um não faz)

- **Dozzle:**
  - Mostra só o que o Docker guarda de log: até ~50 MB por container
    (5 arquivos de 10 MB) e 5 MB na rádio. Ao recriar um container, o
    histórico dele zera.
  - Logs que um programa grava em arquivo **dentro** do container não
    aparecem. Só a saída padrão.
  - O "Memory" do card do servidor no Dozzle é a soma dos containers. Use o
    Beszel para a memória real.
- **Beszel:** foca em métricas, mas também mostra as últimas 200 linhas de
  log e o `docker inspect` (sem variáveis de ambiente) de qualquer
  container. Por isso, como o Dozzle, é só para admin: não libere o
  `/beszel/` para usuário comum achando que é "só CPU e memória".
- **Nenhum dos dois** avisa sobre o certificado HTTPS perto de vencer. A
  renovação continua manual (ver [certbot-manual-dns.md](certbot-manual-dns.md)).

## Atualizar as versões

As versões são fixas no `docker-compose.monitoring.yml`
(`amir20/dozzle:v11.3.0`, `henrygd/beszel:0.21.0`) e no
`docker-compose.monitoring-agent.yml` (`henrygd/beszel-agent:0.21.0`), de
propósito. Atualize trocando a tag depois de ler as notas da versão,
principalmente os alertas de segurança do Dozzle
(https://github.com/amir20/dozzle/security/advisories). Depois rode:

```bash
cd ~/supabase && docker compose pull dozzle beszel beszel-agent && sh run.sh recreate dozzle beszel beszel-agent
```

## Problemas comuns

- **`/dozzle/` ou `/beszel/` dá 502:** o container está parado. Rode
  `docker compose ps dozzle beszel` e `docker compose logs dozzle`. O resto
  da 9443 continua funcionando, porque o Nginx só procura os apps na hora
  de cada acesso.
- **Qualquer `docker compose` reclama de `BESZEL_USER_PASSWORD`:** a linha
  sumiu do `.env`. Ela precisa continuar lá. Recoloque qualquer senha
  forte: o Beszel só usa essa senha na primeira subida.
- **Qualquer `docker compose` reclama de `BESZEL_AGENT_KEY`:** o override
  `monitoring-agent` está ligado, mas a chave sumiu ou ficou vazia no
  `.env`. Refaça o passo 3, ou desligue o agente com
  `docker compose rm -sf beszel-agent && sh run.sh config remove monitoring-agent`.
- **Sistema "down" no Beszel:** confira se o `BESZEL_AGENT_KEY` é a chave
  da tela Add System (`docker compose logs beszel-agent`). Se houver mais
  de uma linha `BESZEL_AGENT_KEY` no `.env`, vale a última. Depois de
  corrigir: `sh run.sh recreate beszel-agent`.
- **Disco errado no Beszel** (tamanho diferente dos 193 GB do `df -h /`,
  ou o log do agente fala em `Root I/O unmapped`): acrescente
  `FILESYSTEM: sda1` no `environment` do `beszel-agent` em
  `docker-compose.monitoring-agent.yml` e rode
  `sh run.sh recreate beszel-agent`.
- **Recriou o volume do Beszel** (`supabase_beszel-data`): o banco dele
  volta do zero com a senha do `.env`. Rode de novo a troca de senha do
  passo 1 (a linha `docker exec supabase-beszel /beszel superuser upsert
  ...`) e refaça o passo 3, porque a chave do hub muda.

## Desligar

```bash
cd ~/supabase && docker rm -f supabase-dozzle supabase-beszel supabase-beszel-agent; sh run.sh config remove monitoring monitoring-agent && sh run.sh recreate login nginx
```

Isso desliga o monitoramento, mas não volta o código. A rota
`/auth-admin`, as regras novas do Nginx e o limite de logs continuam e não
fazem mal: `/dozzle/` e `/beszel/` passam a dar 502. Os dados ficam nos
volumes; para apagar também:
`docker volume rm supabase_dozzle-data supabase_beszel-data supabase_beszel-socket supabase_beszel-agent-data`.

**Voltar também o Nginx e o login** ao que eram antes do monitoramento
(por exemplo, se a 9443 se comportar diferente depois da instalação): rode
**primeiro** o bloco acima e só depois:

```bash
cd ~/supabase && git checkout d7efb95 -- volumes/proxy/manual-tls/nginx.conf.tpl volumes/proxy/manual-tls/login-server.js && sh run.sh recreate login nginx
```

`d7efb95` é o último commit antes do monitoramento (`git log --oneline`
mostra). Para desfazer essa volta:
`git checkout HEAD -- volumes/proxy/manual-tls/` e
`sh run.sh recreate login nginx`. Não apague o
`docker-compose.monitoring.yml` nem faça checkout de um commit antigo
inteiro antes do `config remove`: com o arquivo listado no `.env` e
ausente no disco, todo `docker compose` falha com "no such file".
