# Rede no Oracle Cloud: este servidor, especificamente

Levantamento feito em 2026-09-19 via SSH direto na instância. Números e
decisões abaixo são específicos deste servidor — não genéricos.

## O que já roda aqui

- **Shape:** `VM.Standard.A1.Flex` (ARM Ampere, região `sa-vinhedo-1`), 2
  OCPUs, 12 GB RAM. ~10 GB de RAM disponível, 150 GB de disco livre, carga
  quase zero. **Sobra confortável para o Supabase self-hosted.**
- **Docker** 29.1.3 + Compose v5.3.1 já instalados.
- **A rádio é o AzuraCast** (`ghcr.io/azuracast/azuracast:stable`), rodando
  há 2 meses, e ele é dono de:
  - Portas **80 e 443** (`0.0.0.0`, todas as interfaces).
  - Toda a faixa **8000-8999** (mounts/relays de estações — cada estação
    reserva um bloco de 5 portas: `8005-8006`, `8010`, `8015-8016`...).
    Mesmo as portas dessa faixa que não têm nada escutando agora podem ser
    alocadas para uma estação nova no futuro — evite usar qualquer porta
    dentro de 8000-8999 para outra coisa.
  - Porta `2022` (provavelmente SFTP do AzuraCast).
- Porta `8080` tem um processo `python3` de baixo PID (bem antigo, do boot)
  — não mexer, provavelmente é o agente de monitoramento da própria Oracle
  Cloud.
- `iptables` (`INPUT`) já libera: 22, 80, 443, 2022, 3000, 8080 e o bloco
  8000-8999. Política padrão é `ACCEPT` com um `REJECT` só no final da
  chain — ou seja, o que não está numa regra específica cai nesse reject.

## Decisão tomada: Supabase numa porta própria, sem tocar no AzuraCast

Como 80/443 já têm dono e a faixa 8000-8999 é da rádio, o Supabase usa:

- **Porta pública nova: `9443`** (HTTPS) — fora de qualquer faixa da rádio,
  livre neste servidor.
- Certificado emitido manualmente via DNS-01 (não depende de porta 80/443
  — veja [`certbot-manual-dns.md`](certbot-manual-dns.md)), porque o Wix
  não oferece API de DNS para automatizar isso.
- Gateway (Envoy) e Studio do Supabase **não são publicados no host** —
  só o container Nginx do override `manual-tls` fala com a rede externa,
  na 9443. Isso elimina qualquer chance de colisão com as portas da rádio.

Resultado: **nenhuma configuração do AzuraCast é tocada.**

## Liberar a porta 9443

### Security List / NSG (console OCI)

**Menu ☰ → Networking → Virtual Cloud Networks → (sua VCN) → Security
Lists** (ou **Network Security Groups**, se a instância usa NSG — confira
em **Compute → Instances → (sua instância) → Attached VNICs**).

Adicione um Ingress:

| Origem | Protocolo | Porta destino |
|---|---|---|
| `0.0.0.0/0` | TCP | 9443 |

Não precisa mexer nas regras de 80/443/8000-8999 — são da rádio, já
liberadas, e o Supabase não usa nenhuma delas.

### iptables da instância

```bash
sudo iptables -I INPUT -p tcp --dport 9443 -j ACCEPT
sudo netfilter-persistent save
```

Confira a posição: `sudo iptables -L INPUT -n --line-numbers` — a regra
precisa ficar **antes** do `REJECT` no fim da chain (linha 11 no
levantamento original; pode ter mudado — confira antes de inserir).

### Testar de fora

```bash
curl -kI https://SEU_IP_PUBLICO:9443
```

Timeout = firewall (NSG ou iptables) ainda não liberou. "Connection
refused" = firewall ok, containers do Supabase ainda não subiram.

## DNS — subdomínio no registro.br

`primati.com.br` está registrado no [registro.br](https://registro.br) (o
domínio anterior, `valletibooks.com.br`, ficava no Wix - migração já
concluída, veja o histórico de commits deste repositório).

1. [registro.br](https://registro.br) → **Meus domínios** →
   `primati.com.br` → **DNS** → adicionar registro:
   - Tipo: **A**
   - Nome/Host: `supabase`
   - Valor: `167.126.27.216` (IP público atual da instância — se você
     reservar um IP fixo depois em **Networking → IP Management →
     Reserved Public IPs**, atualize aqui).
   - TTL: padrão.
2. Confirme com `dig +short supabase.primati.com.br` até aparecer o IP
   correto.
3. O acesso final é `https://supabase.primati.com.br:9443` — a porta faz
   parte da URL, não tem como ficar "escondida" sem mexer no AzuraCast
   (veja o README para as alternativas que foram descartadas e por quê).

## Postgres/pooler nunca públicos

`docker-compose.override.yml.example` já restringe as portas 5432/6543 do
Supabase a `127.0.0.1`. Não crie regra nenhuma pra elas no Security
List/NSG — não precisam ser alcançáveis de fora do próprio servidor.

## Sobre habilitar analytics (Logflare)

Com 12 GB de RAM disponíveis, não é uma questão de recursos aqui. Mesmo
assim, mantenha `docker-compose.logs.yml` desabilitado a menos que você
realmente vá usar os logs/analytics do Studio — são 2 containers a mais
sem necessidade.
