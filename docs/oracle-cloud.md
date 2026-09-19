# Rede no Oracle Cloud (OCI): liberando portas sem derrubar a rádio

O OCI tem **duas camadas de firewall** independentes. As duas precisam liberar
a porta, senão nada funciona — e é fácil esquecer a segunda, que é a mais
comum de pegar quem já mexeu só com o Security Group da AWS:

1. **Security List / Network Security Group (NSG)** — regra no console web da
   Oracle, na VCN da instância. Controla o tráfego "de fora para a VCN".
2. **Firewall dentro da própria instância** (`iptables`/`netfilter` no
   Ubuntu, ou `firewalld` no Oracle Linux) — as imagens oficiais da Oracle já
   vêm com regras `iptables` que **bloqueiam por padrão** portas que não
   sejam 22 (SSH). Mesmo com o NSG liberado, se você não abrir aqui também,
   a porta continua fechada.

## 1. Descobrir o que já está exposto (a rádio)

Antes de mexer em qualquer firewall, veja o que já está rodando e em qual
porta, para não derrubar a rádio:

```bash
sudo ss -tlnp
# ou, se preferir:
sudo docker ps            # se a rádio também roda em container
sudo systemctl status nginx caddy 2>/dev/null
```

Se a porta 80 e/ou 443 já estiverem ocupadas (Nginx/Caddy da rádio), o
Supabase **não pode** usar seu próprio Caddy/Nginx nessas portas — veja a
seção "Convivendo com um proxy que já existe" no README principal.

## 2. Security List / NSG (console OCI)

No console: **Menu ☰ → Networking → Virtual Cloud Networks → (sua VCN) →
Security Lists** (ou **Network Security Groups**, se a instância usa NSG em
vez de Security List — confira em **Compute → Instances → (sua instância) →
Attached VNICs → sua VNIC**).

Adicione regras de **Ingress**:

| Origem (Source CIDR) | Protocolo | Porta destino | Motivo |
|---|---|---|---|
| `0.0.0.0/0` | TCP | 80 | HTTP (redirect para HTTPS, validação Let's Encrypt) |
| `0.0.0.0/0` | TCP | 443 | HTTPS (Studio + API do Supabase) |

**Não abra** a 5432 (Postgres) nem a 6543 (pooler) para `0.0.0.0/0`. Essas
portas não precisam ser públicas — o `docker-compose.override.yml` deste
projeto já as restringe a `127.0.0.1` (veja `docker-compose.override.yml.example`
na raiz do repo).

## 3. Firewall da instância (iptables / firewalld)

### Ubuntu (imagem padrão OCI usa `iptables` com `netfilter-persistent`)

```bash
sudo iptables -I INPUT -p tcp --dport 80  -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT

# Persistir entre reboots:
sudo netfilter-persistent save
# (se o pacote não existir: sudo apt-get install -y iptables-persistent)
```

Confira a posição da regra: em algumas imagens já existe uma regra
`REJECT`/`DROP` no fim da chain `INPUT`. Use `sudo iptables -L INPUT -n
--line-numbers` e, se precisar, insira antes dela com `-I INPUT <linha>`.

### Oracle Linux (usa `firewalld`)

```bash
sudo firewall-cmd --permanent --add-port=80/tcp
sudo firewall-cmd --permanent --add-port=443/tcp
sudo firewall-cmd --reload
```

### Testar de fora

Depois das duas camadas liberadas, teste de outra máquina (seu computador,
não de dentro do servidor):

```bash
curl -I http://SEU_IP_PUBLICO
```

Se der timeout, o problema é firewall (NSG ou iptables). Se der "connection
refused", o firewall está ok mas nada está escutando nessa porta ainda
(normal antes de subir os containers).

## 4. DNS — subdomínio no Wix (`valletibooks.com.br`)

1. Painel Wix → **Configurações do domínio** (ou `wix.com` → *Meus domínios*
   → `valletibooks.com.br` → **DNS**).
2. Adicione um registro:
   - Tipo: **A**
   - Nome/Host: `supabase` (resulta em `supabase.valletibooks.com.br`)
   - Valor: o **IP público** da instância Oracle (fixo — na OCI, reserve um
     IP público **reservado** em vez do efêmero padrão, para ele não mudar
     se a instância for reiniciada/recriada: **Networking → IP Management →
     Reserved Public IPs**).
   - TTL: padrão (ou o menor disponível, para propagar rápido durante os
     testes).
3. Propagação costuma levar de alguns minutos a 1h. Teste com:
   ```bash
   dig +short supabase.valletibooks.com.br
   ```
   até aparecer o IP correto.

## 5. Recursos: o free tier aguenta o Supabase self-hosted junto com a rádio?

O stack completo do Supabase sobe ~12 containers (Postgres, Auth, PostgREST,
Realtime, Storage, imgproxy, postgres-meta, Edge Functions, gateway, Studio,
pooler). Isso não cabe confortavelmente numa VM **AMD Micro** do Always Free
(1 OCPU / 1 GB RAM) — vai sofrer com OOM.

Se seu servidor Oracle é uma instância **Ampere A1 (ARM)** do Always Free
(até 4 OCPU / 24 GB RAM no total, divisível entre instâncias), há folga de
sobra rodando junto com a rádio. Pontos de atenção:

- As imagens do Supabase são multi-arch (funcionam em ARM), então A1 funciona
  bem.
- Recomendo **não habilitar** o override `docker-compose.logs.yml`
  (Logflare + Vector) a menos que precise de analytics — ele adiciona 2
  containers e consumo de RAM sem necessidade para uma instância pequena.
- Monitore com `docker stats` nos primeiros dias.
