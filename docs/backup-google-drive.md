# Backup automático (Postgres + Edge Functions) no Google Drive

A aba `Backup` (em `/admin`) faz, na frequência que você
escolher:

1. `pg_dump` do Postgres (formato `custom`, já comprimido) → `db-<data>.dump`.
2. `tar.gz` de `volumes/functions` → `edge-functions-<data>.tar.gz`.
3. Sobe os dois pra uma pasta do seu Google Drive.
4. Apaga os backups mais antigos que sobrarem além da retenção configurada
   (contando os dois tipos separadamente - "manter 7" guarda os últimos 7
   dumps de banco **e** os últimos 7 tars de functions).

Não inclui `volumes/storage` (arquivos do Storage) nesta versão - só
banco e Edge Functions, como pedido.

## Por que precisa criar credenciais no Google Cloud Console

O backup sobe pro **seu** Google Drive (contando na sua cota normal),
não numa conta separada - por isso usa OAuth com a sua conta pessoal em
vez de uma "conta de serviço" (que em conta Gmail comum, não Workspace,
não tem cota própria pra escrever em pasta nenhuma). Isso exige criar,
uma única vez, um "OAuth Client" grátis no Google Cloud Console.

## Passo a passo (uma vez só)

1. Acesse [console.cloud.google.com](https://console.cloud.google.com/)
   com a conta Google onde quer guardar os backups.
2. Crie um projeto novo (qualquer nome, ex.: "backup-supabase").
3. **APIs e serviços → Biblioteca** → procure "Google Drive API" → **Ativar**.
4. **APIs e serviços → Tela de permissão OAuth**:
   - Tipo de usuário: **Externo**.
   - Preencha nome do app, e-mail de suporte e e-mail do desenvolvedor
     (podem ser os seus mesmos).
   - Em "Escopos", adicione `https://www.googleapis.com/auth/drive.file`
     (acesso só aos arquivos que este app cria - nunca vê o resto do seu
     Drive).
   - **Importante:** depois de criar, no resumo da tela de permissão,
     clique em **"PUBLICAR APP"** (mudar de "Testando" para "Em
     produção"). Contas em modo "Testando" recebem um token que expira
     em 7 dias - publicar evita isso. Como o escopo usado
     (`drive.file`) não é sensível, isso não deve pedir verificação
     manual do Google; se aparecer um aviso de "app não verificado" na
     hora de conectar, é esperado (é o seu próprio app, feito por você) -
     clique em "Avançado" → "Acessar [nome do app] (não seguro)" pra
     continuar.
5. **APIs e serviços → Credenciais → Criar credenciais → ID do cliente OAuth**:
   - Tipo de aplicativo: **Aplicativo da Web**.
   - Em "URIs de redirecionamento autorizados", adicione **exatamente**
     (troque pelo seu domínio/porta reais):
     ```
     https://supabase.primati.com.br:9443/admin/api/backup/oauth/callback
     ```
   - Salve e copie o **Client ID** e o **Client Secret** mostrados.

## Configurar em `/admin`

1. `/admin` → aba **Backup**.
2. Cole o **Client ID** e o **Client Secret**, clique em **Salvar**.
3. Clique em **Conectar ao Google Drive** - você é levado pra tela de
   consentimento do Google, aprova, e volta pro `/admin` já conectado.
4. Crie (ou escolha) uma pasta no seu Drive só pra esses backups, abra
   ela e copie o link da barra de endereço (algo como
   `https://drive.google.com/drive/folders/1AbCdEfGh...`) - cole em
   **"Pasta do Drive"** (aceita o link inteiro ou só o ID).
5. Escolha a **frequência** e quantos backups **manter** (retenção),
   clique em **Salvar**.
6. Use **"Rodar backup agora"** pra testar imediatamente, sem esperar a
   frequência configurada. O status (data/hora do último backup, sucesso
   ou erro) aparece na própria tela.

Depois de configurado, o backup roda sozinho no fundo (uma checagem a
cada 5 minutos decide se já passou tempo suficiente desde a última
rodada) - não precisa de cron nem de nada externo ao container `login`.

## Restaurar um backup

```bash
# Banco de dados (dentro do container ou de uma máquina com pg_restore)
pg_restore --clean --if-exists -d <nome-do-banco> db-2026-09-21T12-00-00-000Z.dump

# Edge Functions
tar xzf edge-functions-2026-09-21T12-00-00-000Z.tar.gz -C volumes/functions
```

## Limitações conhecidas

- O upload é feito de uma vez só (não é o protocolo "resumível" do
  Google) - suficiente pro tamanho normal de um projeto pessoal, mas se
  o banco crescer muito (centenas de MB+), vale revisitar.
- A versão do `pg_dump` instalada via `apk` no Alpine pode não ser
  exatamente igual à do Postgres 17 usado pelo Supabase - normalmente
  não é problema pra um dump/restore padrão, só gera um aviso de versão
  no log.
- Reconectar (trocar de conta do Google, por exemplo) é só clicar em
  "Desconectar" e depois em "Conectar ao Google Drive" de novo.
