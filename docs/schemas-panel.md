# Publicar schemas do Postgres pelo painel (aba "Schemas")

O Supabase self-hosted não tem a tela "API Settings > Exposed schemas" do
Supabase hospedado — por padrão só `public`/`graphql_public` respondem em
`/rest/v1/`. A aba **Schemas** em `/admin` resolve isso sem terminal.

## O que a aba mostra e faz

1. Lista todos os schemas cadastrados no banco, exceto os internos do
   Postgres (`pg_%`, `information_schema`) e os internos do próprio
   Supabase (`auth`, `storage`, `realtime`, `extensions`, `vault` etc.) —
   esses nunca aparecem, porque não foram desenhados pra responder numa
   API pública (`auth.users`, por exemplo, tem hash de senha e não tem
   RLS pensada pra isso).
2. Marca quais já estão expostos (comparando com `PGRST_DB_SCHEMAS`).
3. Ao clicar em **Publicar**, pede usuário e senha de novo (mesmo que
   você já esteja logado como admin) — é uma confirmação extra, parecida
   com `sudo`, porque a ação muda permissões reais no banco e reinicia
   serviços.
4. Depois de confirmado, para cada schema **novo** marcado:
   - Roda os `GRANT` necessários (`USAGE` no schema, `ALL` em tabelas/
     sequences/routines existentes, e `ALTER DEFAULT PRIVILEGES` para as
     futuras) pros papéis `anon`, `authenticated`, `service_role`.
   - RLS continua valendo por cima disso — expor o schema não quer dizer
     que qualquer chave lê tudo, só que a tabela passa a existir pra API.
5. Atualiza `PGRST_DB_SCHEMAS` no `.env` e recria os serviços `rest` e
   `studio` (a API fica fora do ar por alguns segundos durante a troca).

## Duas formas de terminar a publicação (parte 2, a que muda o PostgREST)

Os `GRANT`s (item 4 acima) sempre rodam sozinhos, sem acesso novo nenhum
— isso é seguro por padrão. Só a parte 5 (editar `.env` + recriar
containers) exige uma escolha de risco, porque fazer isso *de dentro* do
container `login` exige acesso ao socket do Docker:

### Opção A — sem o override (padrão, menor risco)

Sem nada extra configurado, a aba Schemas funciona só pra visualizar: você
vê os schemas e quais estão expostos, mas o botão Publicar fica desabilitado
com um aviso explicando o que falta. Nesse caso, publique manualmente:

```bash
# edite PGRST_DB_SCHEMAS no .env (adicione o schema, separado por vírgula)
nano .env
sh run.sh recreate rest studio
```

### Opção B — com o override `docker-compose.schemas-panel.yml`

Publica de ponta a ponta pelo painel, sem nenhum comando. Em troca, o
container `login` (o mesmo que serve `/admin`) ganha:

- **Acesso ao socket do Docker** (`/var/run/docker.sock`) — necessário
  pra ele mesmo rodar `docker compose up --force-recreate rest studio`.
  Isso equivale a dar a esse container controle **root sobre o servidor
  inteiro** (não só sobre este projeto Supabase) — quem tiver uma conta
  admin em `/admin` passa, na prática, a poder criar/inspecionar/remover
  qualquer container do host, inclusive containers de outros serviços que
  dividam a mesma máquina (ex.: a rádio AzuraCast, se for o caso).
- **Leitura/escrita da pasta inteira do projeto**, montada no mesmo
  caminho absoluto do host — necessário pra esse `docker compose`
  (rodando de dentro do container, mas falando com o Docker do host)
  resolver certo os volumes relativos (`./volumes/...`) e pra editar o
  `.env` de verdade.

Só habilite se aceitar esse risco. Passo a passo:

1. Descubra o caminho absoluto desta pasta no host:
   ```bash
   pwd
   ```
2. Cole o resultado em `HOST_PROJECT_DIR` no `.env` (ex.:
   `HOST_PROJECT_DIR=/home/user/supabase`).
3. Adicione o override e recrie o `login`:
   ```bash
   sh run.sh config add schemas-panel
   sh run.sh recreate login
   ```
4. Volte em `/admin` → aba **Schemas** — o aviso de "publicar desligado"
   deve sumir, e o botão Publicar fica habilitado.

Pra reverter (tirar o acesso ao Docker do container `login`):

```bash
sh run.sh config remove schemas-panel
sh run.sh recreate login
```

## Limitações conhecidas

- Publicar recria `rest` e `studio` (`--force-recreate --no-deps`) — só
  esses dois, o resto da stack (Auth, Storage, Realtime, o próprio banco)
  não é afetado, mas a API REST/GraphQL fica fora do ar por alguns
  segundos durante a troca.
- A validação da senha de confirmação usa o mesmo `users.json` do login
  normal — se a pessoa foi removida ou teve o papel rebaixado depois de
  logar, a confirmação falha mesmo com a sessão ainda válida (esperado).
- Desmarcar um schema na lista e publicar **não** revoga os `GRANT`s já
  aplicados nem remove RLS — só tira o schema de `PGRST_DB_SCHEMAS` (ele
  para de responder em `/rest/v1/`, mas as permissões no banco continuam
  lá caso você exponha de novo depois).
