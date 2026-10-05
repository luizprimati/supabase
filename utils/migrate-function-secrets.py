#!/usr/bin/env python3
# Copia os secrets das Edge Functions que ainda vêm do .env (API3S_*,
# SYNC_SECRET, DCAN_SCHEMA, KMM_*) para a aba Secrets do /admin
# (volumes/functions-secrets/secrets.json). Rodar uma vez, ANTES de puxar o
# docker-compose.yml sem essas variáveis e recriar o container "functions".
#
# Lê os valores do container "functions" em execução (não do .env direto):
# assim usa exatamente o que as funções enxergam hoje, já interpretado pelo
# próprio Docker Compose (aspas, $, # etc.). Nunca imprime os valores.
#
# Uso (na pasta do projeto): sudo python3 utils/migrate-function-secrets.py

import datetime
import json
import os
import subprocess
import sys

NAMES = [
    "API3S_USUARIO", "API3S_SENHA", "SYNC_SECRET", "API3S_URL", "API3S_FUSO", "DCAN_SCHEMA",
    "KMM_USUARIO", "KMM_SENHA", "KMM_TOKEN", "KMM_CLIENT_ID", "KMM_URL",
]

project_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
secrets_file = os.path.join(project_dir, "volumes", "functions-secrets", "secrets.json")

if os.geteuid() != 0:
    sys.exit("Rode com sudo: o arquivo de secrets pertence ao root.")

result = subprocess.run(
    ["docker", "compose", "exec", "-T", "functions", "env"],
    cwd=project_dir, capture_output=True, text=True,
)
if result.returncode != 0:
    sys.exit(f"Não consegui ler o ambiente do container functions:\n{result.stderr.strip()}")

container_env = {}
for line in result.stdout.splitlines():
    name, sep, value = line.partition("=")
    if sep:
        container_env[name] = value

try:
    with open(secrets_file) as f:
        secrets = json.load(f).get("secrets", {})
except FileNotFoundError:
    secrets = {}

now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
migrated = 0
for name in NAMES:
    value = container_env.get(name, "").strip()
    if not value:
        print(f"  {name}: vazio, pulado")
    elif name in secrets:
        print(f"  {name}: já existe no painel, mantido como está")
    else:
        secrets[name] = {"value": value, "updatedAt": now}
        migrated += 1
        print(f"  {name}: migrado ({len(value)} caracteres)")

if not migrated:
    print("Nada novo para migrar.")
    sys.exit(0)

os.makedirs(os.path.dirname(secrets_file), mode=0o700, exist_ok=True)
tmp = f"{secrets_file}.tmp"
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump({"secrets": secrets}, f, indent=2)
    f.write("\n")
os.replace(tmp, secrets_file)
print(f"{migrated} secret(s) migrado(s) para {secrets_file}.")
