import { timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors.js';

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// Autenticação por API key: "Authorization: Bearer <chave>" ou "X-API-Key".
// Define req.cliente com o nome do cliente dono da chave.
export function auth(config) {
  return (req, _res, next) => {
    const header = req.get('authorization')?.replace(/^Bearer\s+/i, '') || req.get('x-api-key');
    if (!header) return next(new AppError(401, 'nao_autenticado', 'API key ausente'));
    for (const [key, nome] of config.apiKeys) {
      if (safeEqual(header, key)) {
        req.cliente = nome;
        return next();
      }
    }
    next(new AppError(401, 'nao_autenticado', 'API key inválida'));
  };
}
