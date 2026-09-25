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

Confira o que está ativo agora com `sh run.sh config`.

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

## Integrações externas conhecidas

- Projeto **editora-valleti-books** (Lovable) consome este Supabase
  usando o schema **`editora`**, exposto via PostgREST (`PGRST_DB_SCHEMAS`
  inclui `editora` + GRANTs aplicados). Se pedir mais schemas expostos no
  futuro, use a aba Schemas em `/admin` em vez de mexer manualmente.

## Outros docs deste projeto

- [oracle-cloud.md](oracle-cloud.md) - rede, firewall, IP, DNS.
- [certbot-manual-dns.md](certbot-manual-dns.md) - emitir/renovar o
  certificado HTTPS.
- [backup-google-drive.md](backup-google-drive.md) - backup automático
  (Postgres + Edge Functions) pro Google Drive.
- [schemas-panel.md](schemas-panel.md) - expor schemas via PostgREST
  pelo painel `/admin`.
