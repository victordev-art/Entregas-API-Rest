import { createHash } from 'node:crypto';
import { AppError } from '../errors.js';

// Se o mesmo cliente repetir um POST com o mesmo Idempotency-Key,
// devolvemos a resposta original em vez de criar outra entrega.
export function idempotency(store) {
  return (req, res, next) => {
    const key = req.get('idempotency-key');
    if (!key) return next();

    const id = `${req.cliente}:${req.method}:${req.path}:${key}`;
    const hash = createHash('sha256').update(JSON.stringify(req.body ?? {})).digest('hex');
    const run = async () => {
      const hit = await store.getIdem(id);
      if (hit) {
        if (hit.hash !== hash) {
          return next(new AppError(422, 'idempotency_conflito', 'Idempotency-Key reutilizada com corpo diferente'));
        }
        res.set('Idempotent-Replayed', 'true');
        return res.status(hit.status).json(hit.body);
      }

      const json = res.json.bind(res);
      res.json = (body) => {
        if (res.statusCode >= 500) return json(body);
        Promise.resolve(store.saveIdem(id, { hash, status: res.statusCode, body }))
          .then(() => json(body))
          .catch(next);
        return res;
      };
      next();
    };

    run().catch(next);
  };
}
