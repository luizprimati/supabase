# Backup automático (Postgres + Edge Functions) no Google Drive

A aba `Backup` (em `/admin`) faz, na frequência que você
escolher:

1. `pg_dump` do Postgres (formato `custom`, já comprimido) → `db.dump`.
2. `tar.gz` de `volumes/functions` → `edge-functions.tar.gz`.
3. Cria uma subpasta com o carimbo da rodada (formato `AAAAMMDDHHmm`,
   ex.: `202609211228`) dentro da pasta que você escolheu, e sobe os dois
   arquivos ali dentro.
4. Apaga as subpastas mais antigas que sobrarem além da retenção
   configurada (contando pastas inteiras - "manter 7" guarda as últimas
   7 rodadas, cada uma com seu `db.dump` + `edge-functions.tar.gz`).

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
6. **APIs e serviços → Biblioteca** → procure "Google Picker API" →
   **Ativar** (é o seletor de pastas dentro do `/admin` - separado da
   Drive API do passo 3).
7. **APIs e serviços → Credenciais → Criar credenciais → Chave de API**:
   - Copie a chave gerada.
   - Recomendado: clique nela → em "Restrições de aplicativo" escolha
     "Sites" (HTTP referrers) e adicione `https://supabase.primati.com.br/*`
     (troque pelo seu domínio) - evita que outra pessoa use sua chave.
   - Em "Restrições de API", pode restringir só à "Google Picker API".

## Configurar em `/admin`

1. `/admin` → aba **Backup**.
2. Cole o **Client ID**, o **Client Secret** e a **Google API Key**,
   clique em **Salvar**.
3. Clique em **Conectar ao Google Drive** - você é levado pra tela de
   consentimento do Google, aprova, e volta pro `/admin` já conectado.
4. Clique em **"Escolher pasta no Drive"** pra navegar e selecionar uma
   pasta existente, ou em **"+ Criar nova pasta"** pra criar uma direto
   pelo painel (sem precisar abrir o Drive em outra aba). Qualquer um dos
   dois já preenche o campo "Pasta do Drive" sozinho - não precisa mais
   copiar link/ID manualmente (mas o campo continua aceitando colar um
   link/ID direto, se preferir).
5. Escolha a **frequência** e quantos backups **manter** (retenção),
   clique em **Salvar**.
6. Use **"Rodar backup agora"** pra testar imediatamente, sem esperar a
   frequência configurada - o botão fica desabilitado com "Backup em
   andamento..." enquanto roda, e mostra sucesso ou erro assim que
   termina (a tela verifica o progresso a cada poucos segundos sozinha).

Depois de configurado, o backup roda sozinho no fundo (uma checagem a
cada 5 minutos decide se já passou tempo suficiente desde a última
rodada) - não precisa de cron nem de nada externo ao container `login`.

## Restaurar um backup

Abra a subpasta da rodada que quer restaurar (ex.: `202609211228`) e baixe os
dois arquivos de dentro dela:

```bash
# Banco de dados (dentro do container ou de uma máquina com pg_restore)
pg_restore --clean --if-exists -d <nome-do-banco> db.dump

# Edge Functions
tar xzf edge-functions.tar.gz -C volumes/functions
```

## Limitações conhecidas

- O seletor de pastas ("Escolher pasta no Drive") carrega um script do
  próprio Google (`apis.google.com/js/api.js`) direto no navegador de
  quem está usando o `/admin` - se essa CDN estiver bloqueada/sem
  internet nesse momento, aparece um aviso e você ainda pode colar o
  link/ID da pasta manualmente no campo, sem precisar do seletor.
- O upload é feito de uma vez só (não é o protocolo "resumível" do
  Google) - suficiente pro tamanho normal de um projeto pessoal, mas se
  o banco crescer muito (centenas de MB+), vale revisitar.
- A versão do `pg_dump` instalada via `apk` no Alpine pode não ser
  exatamente igual à do Postgres 17 usado pelo Supabase - normalmente
  não é problema pra um dump/restore padrão, só gera um aviso de versão
  no log.
- Reconectar (trocar de conta do Google, por exemplo) é só clicar em
  "Desconectar" e depois em "Conectar ao Google Drive" de novo.
