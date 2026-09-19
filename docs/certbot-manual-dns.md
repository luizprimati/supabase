# Certificado HTTPS manual (DNS-01) para quem não pode usar 80/443

Este servidor já tem o AzuraCast ocupando as portas 80 e 443 — os dois
métodos automáticos de validação do Let's Encrypt (HTTP-01 via porta 80,
TLS-ALPN-01 via porta 443) ficam indisponíveis para o Supabase. A alternativa
é o desafio **DNS-01**: você prova que é dono do domínio colando um registro
TXT no painel de DNS. Como o Wix não tem API pública de DNS para automatizar
isso, o processo é manual — leva ~2 minutos a cada emissão/renovação.

O certificado dura 90 dias; renove a cada ~60 dias (dá folga antes de
vencer). Não há necessidade de portas abertas para nada disso.

## Instalar o certbot (uma vez)

```bash
sudo apt-get update -y
sudo apt-get install -y certbot
```

## Emitir o certificado (primeira vez)

```bash
sudo certbot certonly --manual --preferred-challenges dns \
  -d supabase.valletibooks.com.br \
  --agree-tos -m seu-email@exemplo.com \
  --no-eff-email
```

O certbot vai imprimir algo como:

```
Please deploy a DNS TXT record under the name:

_acme-challenge.supabase.valletibooks.com.br.

with the following value:

AbCdEfGh123...
```

1. Abra o painel Wix → **Configurações do domínio** → `valletibooks.com.br`
   → **DNS** → **Adicionar registro**.
2. Tipo: **TXT** · Nome/Host: `_acme-challenge.supabase` (o Wix já adiciona
   o domínio base sozinho — se pedir o nome completo, use
   `_acme-challenge.supabase.valletibooks.com.br`) · Valor: o texto exato
   que o certbot mostrou.
3. Espere a propagação (geralmente poucos minutos). Confirme com:
   ```bash
   dig +short TXT _acme-challenge.supabase.valletibooks.com.br
   ```
   até aparecer o valor esperado — só então volte ao terminal do certbot e
   aperte Enter para continuar.
4. Sucesso grava os arquivos em
   `/etc/letsencrypt/live/supabase.valletibooks.com.br/{fullchain,privkey}.pem`
   — é exatamente o que `docker-compose.manual-tls.yml` monta no container
   Nginx.
5. **Apague o registro TXT** depois (opcional, mas evita acúmulo de lixo no
   DNS — ele não é mais necessário até a próxima renovação).

## Depois de emitir: subir/recarregar o proxy

```bash
sh run.sh config add manual-tls
sh run.sh start
```

Se o certificado já existia e você só renovou, um restart do container
basta para ele pegar os arquivos novos:

```bash
sh run.sh restart nginx
```

## Renovar (a cada ~60 dias)

Mesmo comando de emissão funciona para renovar:

```bash
sudo certbot certonly --manual --preferred-challenges dns \
  -d supabase.valletibooks.com.br
```

Repita os passos do TXT no Wix, aguarde propagar, confirme com `dig`, deixe
o certbot terminar, e reinicie o container do Nginx (`sh run.sh restart
nginx`).

### Lembrete

Configure um lembrete recorrente (agenda, cron de e-mail, o que for prático
para você) para daqui a ~60 dias — não há renovação automática nesse modo.
Se `curl -vI https://supabase.valletibooks.com.br:9443 2>&1 | grep expire`
começar a mostrar uma data próxima, é sinal de que está na hora.
