#!/usr/bin/env node
'use strict';

// Gera o salt+hash (scrypt) de uma senha, para colar em users.json.
// Nunca grava a senha em texto puro em lugar nenhum.
//
// Uso (dentro do container do login):
//   docker exec -it supabase-studio-login node /app/hash-password.js "a-senha-aqui"

const crypto = require('crypto');

const password = process.argv[2];
if (!password) {
  console.error('Uso: node hash-password.js "a-senha-aqui"');
  process.exit(1);
}

const salt = crypto.randomBytes(16).toString('hex');
crypto.scrypt(password, salt, 64, (err, derivedKey) => {
  if (err) throw err;
  console.log(JSON.stringify({ salt, hash: derivedKey.toString('hex') }, null, 2));
  console.log('\nAdicione um objeto com "username" + esses dois campos em users.json.');
});
