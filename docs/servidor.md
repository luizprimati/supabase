# Este servidor - referência rápida

Ponto de partida para qualquer dúvida sobre **este** deploy específico
(não o Supabase self-hosted em geral - isso é o `README.md`). Leia este
arquivo primeiro; ele aponta pros outros docs quando o assunto for mais
fundo. Mantenha atualizado quando algo mudar (domínio, caminho, decisão).

## Onde tudo mora

- **Servidor:** Oracle Cloud, instância `instance-20260616-1426`
  (`VM.Standard.A1.Flex`, ARM, região `sa-vinhedo-1`). Detalhes de
  rede/portas/firewall: [oracle-cloud.md](oracle-cloud.md).
- **Usuário SSH:** `ubuntu`.
- **Pasta do projeto no host:** `/home/ubuntu/supabase` (é o valor a usar
  em `HOST_PROJECT_DIR` no `.env`, se/quando precisar - ver
  [schemas-panel.md](schemas-panel.md)).
- **Domínio público:** `supabase.primati.com.br`, porta **9443**
  (`https://supabase.primati.com.br:9443`). Registrado no
  **registro.br** (não é mais o Wix/`valletibooks.com.br` - domínio
  antigo, migração já concluída).
- **Certificado:** emitido manualmente via DNS-01 (registro.br não tem
  API de DNS) - renovar a cada ~60 dias, passo a passo em
  [certbot-manual-dns.md](certbot-manual-dns.md).

## Este servidor NÃO é só do Supabase

Já roda o **AzuraCast** (rádio), há mais tempo. Ele é dono de:

- Portas **80 e 443** (por isso o Supabase usa 9443, não a porta padrão).
- Toda a faixa **8000-8999** (streams/relays das estações).
- Porta **2022** (SFTP do AzuraCast).

**Nunca** usar nenhuma porta dessas faixas pra qualquer coisa do Supabase,
e nunca rodar `sudo systemctl restart docker` sem avisar antes (derruba a
rádio junto). Fora essas portas, os dois convivem sem conflito - o
Supabase nem publica nada direto no host (só o Nginx do override
`manual-tls`, na 9443).

Também roda neste mesmo servidor, em repositório separado
([chat-IA](https://github.com/luizprimati/chat-IA)), uma API própria de
IA (Ollama) na porta **9444** - mesma lógica de isolamento, outro domínio
(`ia.primati.com.br`), sem tocar em nada do Supabase/rádio.

## Configuração ativa (overrides do `run.sh config`)

- `manual-tls` - Nginx próprio na 9443 + container `login` (tela de
  abertura, `/admin`, autenticação). Sempre ativo neste servidor.
- `override` (de `docker-compose.override.yml.example`) - restringe
  Postgres/pooler a `127.0.0.1`. Sempre ativo - **nunca exponha 5432/6543
  publicamente**.
- `schemas-panel` (opcional) - dá ao painel `/admin` acesso ao socket do
  Docker pra publicar schemas via PostgREST sem terminal. Ver
  [schemas-panel.md](schemas-panel.md) antes de habilitar (é uma escolha
  de risco, feita conscientemente).
- `monitoring` - Dozzle (`/dozzle/`, logs e containers) e Beszel
  (`/beszel/`, saúde do servidor com histórico e alertas), atrás do Nginx
  da 9443 e só para admin. Ver [monitoramento.md](monitoramento.md).

Confira o que está ativo agora com `sh run.sh config`.

**Limite de logs:** todo container dos projetos supabase e chat-IA usa
`json-file` com no máximo 5 arquivos de 10 MB (bloco `x-logging` em cada
compose). Serviço novo em qualquer compose deste servidor deve receber
`logging: *default-logging` - sem isso o log cresce sem limite até o
container ser recriado. O limite global do Docker (`/etc/docker/daemon.json`)
não foi usado de propósito: mudá-lo exige reiniciar o Docker, o que derruba
a rádio. A rádio já vem com o próprio limite (1 MB x 5).

## Pegadinha de rede já encontrada: NSG "existe" mas não vale nada

Ao abrir a porta 9444 (pro projeto `chat-IA`), a regra foi adicionada
certinho ao Network Security Group **"Supabase 9443"**, mas a porta
continuou bloqueada de fora. Causa: esse NSG **nunca esteve realmente
anexado à VNIC da instância** (campo "Network Security Groups" da VNIC
aparecia vazio) - ele existe, tem regras, mas não vale nada até ser
anexado a alguma VNIC. A porta 9443 sempre funcionou porque sua regra de
verdade está na **Default Security List** do VCN, não nesse NSG.

Se precisar abrir outra porta no futuro: confira primeiro em Compute →
Instances → esta instância → Attached VNICs → clique na VNIC → veja se
o campo "Network Security Groups" lista algo. Detalhe completo (sintoma,
diagnóstico, correção) em
[chat-IA/README.md](https://github.com/luizprimati/chat-IA#problemas-conhecidos-troubleshooting).

## Pegadinha já encontrada (de novo): Nginx com IP velho do `studio`/`rest`

O Nginx do override `manual-tls` (`supabase-nginx-manual`) resolve o
endereço de rede de `studio`/`rest` **uma vez só, quando sobe**, e não
percebe sozinho se esses containers forem recriados depois - continua
mandando tráfego pro endereço antigo, que o Docker pode até já ter
reaproveitado para outro container. Resultado: `502 Bad Gateway` na home
inteira (`https://supabase.primati.com.br:9443/`), mesmo com todos os
containers "Up (healthy)" no `docker compose ps`.

Já aconteceu duas vezes por dois motivos diferentes:
1. A aba Schemas publicando um schema (recria `rest`+`studio` de
   propósito) - já corrigido, o próprio painel reinicia o Nginx depois
   (ver [schemas-panel.md](schemas-panel.md)).
2. **Qualquer outro `docker compose up -d <serviço>` que acabe
   recriando `studio`/`rest`/`envoy` como efeito colateral** (por
   dependência) - isso NÃO reinicia o Nginx sozinho. Aconteceu ao
   recriar só o `functions` (integração 3S/DCAN): o compose também
   recriou `studio` e `envoy` por tabela, e a home ficou fora do ar até
   reiniciar o Nginx manualmente.

**Regra geral: depois de qualquer `docker compose up -d` (ou
`sh run.sh recreate`) que toque em `studio`, `rest`, `envoy`/`api-gw` ou
`login`, direto ou como efeito colateral, rode `sh run.sh restart
nginx`** - mesmo que o `docker compose` não tenha reclamado de nada.
Custa segundos e evita o 502.

## Decisões já tomadas (não reabrir sem pedido explícito)

- **Continuar na porta 9443**, não migrar para a 443 padrão - migrar
  exigiria um SNI router e recriar o container do AzuraCast (derruba a
  rádio brevemente). Decisão do usuário, registrada aqui pra não
  propor de novo sem necessidade.
- **Aba Schemas com automação total** (acesso ao socket do Docker) em vez
  da alternativa mais segura (GRANT automático + 1 comando manual). O
  usuário optou conscientemente pelo maior risco/conveniência - ver
  [schemas-panel.md](schemas-panel.md).
- **Nome do projeto no Studio:** "Primati" (`STUDIO_DEFAULT_PROJECT`).

## Onde estão as credenciais (nunca colar valor aqui)

- `POSTGRES_PASSWORD`, `SECRET_KEY_BASE`, chaves OAuth do backup, etc.:
  só no `.env` do servidor (não versionado).
- `ANON_KEY`/`SUPABASE_PUBLISHABLE_KEY` (pública, pode ir em client-side)
  e `SERVICE_ROLE_KEY`/`SUPABASE_SECRET_KEY` (**nunca** client-side): no
  `.env`, ou em Studio → Project Settings → API. Rode
  `sh run.sh secrets` pra imprimir as principais direto do `.env`.
- `users.json`/`backup-config.json` (senhas de login do `/admin`,
  credenciais do Google Drive): `volumes/proxy/manual-tls/`, não
  versionados.
- Secrets das Edge Functions (`API3S_*`, `SYNC_SECRET`, `KMM_*`...): aba
  Secrets do `/admin`, gravados em
  `volumes/functions-secrets/secrets.json` (dono `root`, permissão 600,
  não versionado nem incluído no backup do Drive). Pra usar um valor num
  teste no terminal, sem abrir o painel:
  `sudo jq -r '.secrets.SYNC_SECRET.value' ~/supabase/volumes/functions-secrets/secrets.json`.

## Integrações externas conhecidas

- Projeto **editora-valleti-books** (Lovable) consome este Supabase
  usando o schema **`editora`**, exposto via PostgREST (`PGRST_DB_SCHEMAS`
  inclui `editora` + GRANTs aplicados). Se pedir mais schemas expostos no
  futuro, use a aba Schemas em `/admin` em vez de mexer manualmente.
- Projeto **DCAN** (rastreamento de frota via API 3S/DataExportAPI) usa o
  schema **`dcan`** (exposto do mesmo jeito) + a Edge Function
  `sync-3s` (`volumes/functions/sync-3s/`, não versionada - ver
  `.gitignore`) + os secrets `API3S_USUARIO`/`API3S_SENHA`/
  `SYNC_SECRET` na aba Secrets do `/admin`. Agendada via `pg_cron`
  a cada minuto (job `dcan-sync-3s`, segredo guardado no Vault sob o
  nome `sync_3s_secret` - ver bloco de setup mais abaixo). App consumidor
  é um projeto Lovable separado.

  Três bugs reais já encontrados e corrigidos nessa integração (só no
  `sync-3s`, não no schema/tabelas em si) - registrar aqui porque não
  são óbvios e podem voltar se o código for reescrito do zero:

  1. **Dupla serialização JSON.** A API da 3S às vezes devolve o corpo
     de `/ListaVeiculos` e `/RetornaDados` como uma *string* JSON
     contendo JSON dentro (`"[{\"Placa\":...}]"`), em vez do array
     direto. `/ValidaLogin` não tem esse problema. Corrigido em
     `Cliente3S.chamar()` (`api3s.ts`): se o primeiro `JSON.parse` der
     uma string, tenta parsear de novo.
  2. **Cursor travado em "marcador vazio".** `/RetornaDados` pode
     devolver uma posição só com `{ idPosicao }`, sem coordenada nem
     data - um marcador que o código descarta certo (não tem como
     salvar), mas que precisa avançar o cursor mesmo assim, senão a
     sincronização fica presa pedindo a mesma janela pra sempre.
     Corrigido: `converterPosicoes` agora devolve também o maior
     `idPosicao` visto (`maiorIdVisto`), calculado antes do filtro de
     completude, e o loop em `index.ts` avança/persiste o cursor por
     esse valor.
  3. **Cache de veículos travado em zero.** Efeito colateral do bug 1:
     o primeiro teste manual (antes do fix da dupla serialização) leu
     `/ListaVeiculos` como lista vazia (silenciosamente, sem erro) e
     mesmo assim gravou `veiculos_atualizados_em` - travando o cache de
     "0 veículos" pelas 6h de `INTERVALO_VEICULOS_MS`. Resolvido uma
     vez com `delete from dcan.sync_3s where chave =
     'veiculos_atualizados_em';` pra forçar nova tentativa. Se voltar a
     acontecer (ex.: depois de outro bug na API), o sintoma é
     `veiculosAtualizados: 0` persistente nas respostas do `sync-3s`
     mesmo com veículos reais existindo na 3S - o reset manual é a
     saída.

  Rotina de km por placa: `sync-3s` grava o hodômetro em
  `dcan.posicoes_3s.odometro` e o job `dcan-km-veiculos` (pg_cron, a cada
  5 min, criado pela migração `20261003200000_dcan_veiculos_km.sql` do
  repositório `mapa-calor-dcan`) grava em `dcan.veiculos_km` só quando o
  km muda. **A cópia do `sync-3s` no repositório `mapa-calor-dcan` não
  tem as correções 1 e 2 acima** - nunca copie de lá por cima da versão
  do servidor; aplique só a mudança nova em cima da versão daqui.

  Segunda Edge Function do projeto: `sync-kmm`
  (`volumes/functions/sync-kmm/`, também não versionada), chamada pelo
  botão "Sincronizar KMM" da tela de Clientes do app. Só lê o cadastro de
  pessoas da API do KMM/MultiTMS e devolve as linhas pro app. Confere a
  sessão do app em `dcan.sessao_atual` antes de qualquer consulta. A API
  do KMM autentica só pelo header `Token` (chave fixa emitida pela
  Multisoftware, `KMM_TOKEN`) - o login por usuário/senha em
  `/CadastroUnificado/ObterTokenIntegracao` exige o próprio `Token` +
  `client_id` e devolve 500 vazio sem eles.

  **Todos os secrets das Edge Functions ficam na aba Secrets do
  `/admin`** - valem na hora, sem editar `docker-compose.yml` nem recriar
  o container (ver README, aba Secrets). As variáveis da 3S/KMM saíram do
  `docker-compose.yml`: linhas `API3S_*`/`KMM_*`/`SYNC_SECRET` que ainda
  estejam no `.env` não fazem mais efeito nenhum.

  **Cuidado ao trocar o `SYNC_SECRET`:** ele existe em dois lugares - na
  aba Secrets (o que a função `sync-3s` confere) e no Vault do banco
  (`sync_3s_secret`, o que o cron manda no header). Trocar só um faz o
  cron levar 401 a cada minuto. Pra trocar, salve o novo valor no painel
  e rode no SQL Editor:
  `select vault.update_secret((select id from vault.secrets where name = 'sync_3s_secret'), 'NOVO_VALOR');`

  Setup do agendamento (rodar uma vez, já feito neste servidor):

  ```bash
  SYNC_SECRET="$(sudo jq -r '.secrets.SYNC_SECRET.value' ~/supabase/volumes/functions-secrets/secrets.json)" && \
  cd ~/supabase && \
  docker compose exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -v secret="$SYNC_SECRET" <<'SQL'
  create extension if not exists pg_cron;
  create extension if not exists pg_net with schema extensions;
  create extension if not exists supabase_vault cascade;
  select vault.create_secret(:'secret', 'sync_3s_secret', 'x-sync-secret da Edge Function sync-3s (DCAN)');
  select cron.schedule('dcan-sync-3s', '* * * * *', $$
    select net.http_post(
      url := 'http://kong:8000/functions/v1/sync-3s',
      headers := jsonb_build_object('Content-Type', 'application/json',
        'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'sync_3s_secret')),
      body := '{}'::jsonb, timeout_milliseconds := 55000
    ) as request_id;
  $$);
  SQL
  ```

## Outros docs deste projeto

- [oracle-cloud.md](oracle-cloud.md) - rede, firewall, IP, DNS.
- [certbot-manual-dns.md](certbot-manual-dns.md) - emitir/renovar o
  certificado HTTPS.
- [backup-google-drive.md](backup-google-drive.md) - backup automático
  (Postgres + Edge Functions) pro Google Drive.
- [schemas-panel.md](schemas-panel.md) - expor schemas via PostgREST
  pelo painel `/admin`.
- [monitoramento.md](monitoramento.md) - Dozzle e Beszel: logs, saúde
  do servidor, alertas.
- [chat-IA](https://github.com/luizprimati/chat-IA) - repositório
  separado, API de IA (Ollama) rodando no mesmo servidor, porta 9444.
