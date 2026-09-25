'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const config = require('./../config');
const { db } = require('./../db');
const auth = require('./../auth');
const { envolver } = require('./helpers');

const TIPOS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
};

const MAX_IMAGENS_POR_CONTA = num(process.env.MAX_IMAGENS_POR_CONTA, 300);
const MAX_BYTES_POR_CONTA = num(process.env.MAX_BYTES_POR_CONTA, 512 * 1024 * 1024);

function num(valor, padrao) {
  const n = Number(valor);
  return Number.isFinite(n) ? n : padrao;
}

function assinaturaDeImagem(buffer) {
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length > 6 && buffer.slice(0, 6).toString('ascii') === 'GIF87a') return 'image/gif';
  if (buffer.length > 6 && buffer.slice(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (buffer.length > 12 && buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

async function usoDoUsuario(userId) {
  const arquivos = await db.uploads.find({ userId });
  return {
    quantidade: arquivos.length,
    bytes: arquivos.reduce((total, item) => total + (item.bytes || 0), 0)
  };
}

function registrar(router) {
  const jsonGrande = express.json({ limit: `${Math.ceil(config.MAX_IMAGE_BYTES / 1024 / 1024) + 2}mb` });

  router.post(
    '/uploads',
    auth.exigirAcesso,
    jsonGrande,
    envolver(async (req, res) => {
      const data = String(req.body.data || '');
      const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(data);

      if (!match) {
        throw Object.assign(new Error('Envie uma imagem válida (png, jpg, gif ou webp) em base64.'), { status: 400 });
      }

      const tipoDeclarado = match[1].toLowerCase();
      if (!TIPOS[tipoDeclarado]) {
        throw Object.assign(new Error('Formato não suportado. Use png, jpg, gif ou webp.'), { status: 400 });
      }

      const buffer = Buffer.from(match[2], 'base64');

      if (!buffer.length) {
        throw Object.assign(new Error('Imagem vazia.'), { status: 400 });
      }

      if (buffer.length > config.MAX_IMAGE_BYTES) {
        throw Object.assign(new Error(`Imagem maior que ${Math.round(config.MAX_IMAGE_BYTES / 1024 / 1024)} MB.`), { status: 413 });
      }

      // Confere o conteúdo real: o header do data URL pode dizer uma coisa e o
      // arquivo ser outra coisa.
      const tipoReal = assinaturaDeImagem(buffer);
      if (!tipoReal || tipoReal !== tipoDeclarado) {
        throw Object.assign(new Error('O conteúdo do arquivo não corresponde a uma imagem válida.'), { status: 400 });
      }

      const uso = await usoDoUsuario(req.user._id);
      if (uso.quantidade >= MAX_IMAGENS_POR_CONTA) {
        throw Object.assign(new Error('Limite de imagens atingido. Exclua campanhas antigas para liberar espaço.'), { status: 403 });
      }
      if (uso.bytes + buffer.length > MAX_BYTES_POR_CONTA) {
        throw Object.assign(new Error('Limite de espaço em imagens atingido para a sua conta.'), { status: 403 });
      }

      const nome = `${crypto.randomUUID()}.${TIPOS[tipoReal]}`;
      const destino = path.join(config.UPLOADS_DIR, nome);
      fs.writeFileSync(destino, buffer);

      await db.uploads.insert({
        _id: crypto.randomUUID(),
        nome,
        caminho: destino,
        userId: req.user._id,
        bytes: buffer.length,
        tipo: tipoReal,
        campaignIds: [],
        criadoEm: new Date()
      });

      res.status(201).json({
        ok: true,
        nome,
        url: `/api/uploads/${nome}`,
        bytes: buffer.length
      });
    })
  );
}

module.exports = { registrar, assinaturaDeImagem, usoDoUsuario };
