# API de Entregas (MVP)

API de entregas para autopeças, inspirada na Uber Direct: cotar, criar, despachar, rastrear e confirmar.
Planeja entregas por endereço, distância e tempo de rota; usa motoboys próprios por padrão e permite registrar uma contratação expressa de terceiro, com pagamento feito fora da API.
Usa PostgreSQL quando `DATABASE_URL` estiver configurada; sem ela, salva os dados localmente em `data/entregas.json`.

## Rodar

```bash
npm install
npm test
npm start              # painel web e API em http://localhost:3000
```

O painel permite cotar por endereço, criar pedidos, acompanhar previsões, gerenciar motoboys e registrar parceiros expressos. Por padrão, usa a chave local `dev-key-123`; configure `API_KEYS` antes de usar fora do ambiente de desenvolvimento. A API continua disponível em `/v1`.

A origem do painel está fixa em Disppar Autopeças - Paranoá, QD. 34 Conj. C Lote 25 - Paranoá, Brasília - DF, 71573-403. A distância e o ETA são recalculados automaticamente após informar ou alterar o destino, item ou modalidade.

Para o destino, selecione Paranoá ou Itapoã e informe rua, quadra, conjunto ou lote. O CEP é opcional e ajuda a desambiguar; se não houver resultado com o CEP, a busca tenta novamente usando o endereço e a região.

Se um comércio ou lote não estiver cadastrado nos mapas públicos, use “Escolher ponto no mapa” para marcar o local. Essa posição é usada na rota; o texto do endereço continua salvo no pedido.

Os endereços são resolvidos com Nominatim (Photon como fallback); motos usam o perfil `motor_scooter` do Valhalla e veículos maiores usam OSRM. O motoboy recebe até três alternativas e o painel seleciona a de menor duração. Se não houver rota viária, a cotação falha e o mapa não desenha uma linha direta. Esses serviços públicos não fornecem trânsito ao vivo; configure `GEOCODING_URL`, `GEOCODING_FALLBACK_URL`, `MOTORCYCLE_ROUTING_URL` e `ROUTING_URL` para provedores aprovados pela empresa. Endereços de clientes não devem ser enviados a serviços públicos sem autorização empresarial.

Sem PostgreSQL, cadastros de motoboys, pedidos, eventos e chaves de idempotência são salvos em `data/entregas.json`, ignorado pelo Git. Esse modo é adequado para estudo e desenvolvimento em uma instância local. Para operação empresarial com vários servidores ou usuários concorrentes, configure PostgreSQL com backup e controle de acesso.

Autenticação: `Authorization: Bearer dev-key-123` (configure em `API_KEYS`).

## PostgreSQL passo a passo

Requisitos: Node.js 20 ou superior e Docker Desktop com Docker Compose.

1. Instale as dependências e crie sua configuração local:

  ```powershell
  npm install
  Copy-Item .env.example .env
  ```

2. Suba o PostgreSQL em contêiner:

  ```powershell
  docker compose up -d db
  docker compose ps
  ```

3. Aplique as migrações versionadas em `src/migrations`:

  ```powershell
  npm run migrate
  ```

  O comando registra cada arquivo em `schema_migrations` e pode ser executado novamente sem reaplicar migrações já concluídas.

4. Inicie a API. O `DATABASE_URL` do `.env` seleciona o PostgreSQL automaticamente:

  ```powershell
  npm start
  ```

5. Em outro terminal, abra `http://localhost:3000` e use o painel ou verifique `http://localhost:3000/health`. Para parar o banco sem apagar os dados, rode `docker compose down`; para apagar também o volume local, use `docker compose down -v`.

O Compose cria um banco de desenvolvimento em `localhost:5433` (`entregas` / `entregas`), para não conflitar com um PostgreSQL local na porta padrão. Altere a senha de exemplo antes de expor o banco fora da máquina local. `npm test` continua usando o store em memória e não exige Docker.

As tabelas são `quotes`, `deliveries`, `couriers`, `delivery_events` e `idempotency_records`. O serviço grava mudanças de estado e eventos na mesma transação; webhooks só são disparados após o commit. Para adicionar mudanças futuras, crie um novo arquivo SQL numerado em `src/migrations` e execute `npm run migrate`.

## Planejamento logístico

- A empresa usa a frota própria como modalidade padrão; cadastre cada motoboy com telefone e endereço-base ou endereço atual.
- Ao abrir um pedido, informe o vendedor responsável e escolha um motoboy disponível ou deixe o despacho automático selecionar pelo menor tempo.
- Na área de entregadores, use “Capturar GPS do aparelho” no celular do motoboy para salvar uma posição com precisão; requer permissão e HTTPS (localhost funciona no desenvolvimento). A captura é manual, não é rastreamento contínuo. Posições com mais de 10 minutos ou precisão acima de 300 m não iniciam o trecho restante da rota.
- A cotação usa os endereços de coleta e entrega para obter distância e duração de rota. O peso não é exigido; o veículo padrão é moto. As coordenadas continuam aceitas pela API para integrações existentes.
- O despacho automático filtra motoboys próprios disponíveis e compatíveis e atribui ao menor tempo estimado até a coleta.
- Cada pedido guarda distância, tempo de viagem, prazo total e previsão de chegada, calculados pela rota viária. O OSRM público não fornece trânsito ao vivo; congestionamentos, fila de coleta e condições reais podem alterar o horário.
- Na modalidade `terceiro_express`, o painel registra nome, telefone e custo informado do prestador. A API não cobra nem processa esse pagamento; a empresa e o cliente acertam por fora.

## Fluxo

```
cotacao → criar entrega → procurando_entregador → entregador_atribuido
→ coletada → em_rota → entregue   (ou falhou → devolvendo → devolvida / cancelada)
```

## Endpoints (`/v1`)

| Método | Rota | Quem usa |
|---|---|---|
| POST | `/entregas/cotacao` | sistema de vendas |
| POST | `/entregas` (use `Idempotency-Key`; `vendedor_nome?`, `entregador_id?`) | sistema de vendas |
| GET | `/entregas`, `/entregas/:id` | sistema de vendas |
| GET | `/planejamento` | painel (rotas ativas e motoboys para o mapa) |
| POST | `/entregas/:id/cancelar` | sistema de vendas (até a coleta) |
| POST | `/entregas/:id/atribuir` `{entregador_id}` | painel interno (despacho manual) |
| POST | `/entregas/:id/atribuir-terceiro` `{nome, telefone, custo_centavos?}` | operação (parceiro expresso, pagamento externo) |
| POST | `/entregas/:id/liberar` | entregador desistiu |
| POST | `/entregas/:id/coletar` · `/iniciar-rota` | app do entregador |
| POST | `/entregas/:id/finalizar` `{codigo, foto_url?, recebedor?}` | app do entregador |
| POST | `/entregas/:id/falha` `{motivo}` · `/devolver` · `/devolucao-concluida` | operação |
| POST/GET | `/entregadores` · POST `/entregadores/:id/posicao` | operação / app |

## Exemplo rápido

```bash
H='-H "Authorization: Bearer dev-key-123" -H "Content-Type: application/json"'

curl -X POST localhost:3000/v1/entregas/cotacao $H -d '{
  "origem":{"endereco":"SIA Trecho 3, Brasília, DF"},
  "destino":{"endereco":"QI 10, Lago Sul, Brasília, DF"},
  "itens":[{"descricao":"Pastilha de freio","quantidade":2}],
  "forma_entrega":"propria"}'
# -> distância, tempo de viagem, prazo, previsão, fonte da rota e valor da frota própria

curl -X POST localhost:3000/v1/entregas $H -H "Idempotency-Key: ped-4521" -d '{
  "cotacao_id":"cot_xxxx","pedido_externo_id":"PED-4521",
  "coleta":{"endereco":"SIA Trecho 3","contato":{"nome":"Expedição","telefone":"61999990000"}},
  "entrega":{"endereco":"QI 10 Lago Sul","contato":{"nome":"Oficina","telefone":"61988880000"}}}'
```

Valores próprios em **centavos** (inteiros). Na entrega expressa, `valor_centavos` é `null`; `custo_centavos` é apenas um registro do pagamento feito fora da API. A resposta traz `codigo_confirmacao`: repasse ao cliente final;
o entregador precisa digitar esse código para finalizar.

## Webhooks

Defina `WEBHOOK_URL` e `WEBHOOK_SECRET`. Cada mudança de status envia `POST` com
`X-Signature: sha256=<HMAC do corpo>` e `X-Event-Id`. Retentativas: 1 min, 5 min, 30 min.
Eventos: `entrega.criada`, `.procurando_entregador`, `.entregador_atribuido`, `.coletada`,
`.em_rota`, `.entregue`, `.falhou`, `.devolvendo`, `.devolvida`, `.cancelada`.

Verificação no receptor (Node):

```js
const esperado = 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
```

## Estrutura

```
src/config.js              preços, TTL da cotação, chaves, webhook
src/store/                 armazenamento em memória e PostgreSQL
src/migrations/            migrações SQL versionadas
src/services/quote.js      distância, escolha de veículo, preço, prazo
src/services/stateMachine.js   transições permitidas
src/services/deliveries.js regras de negócio (toda mudança passa por transition())
src/services/webhooks.js   HMAC + retentativas
src/middleware/            auth (API key) e idempotência
src/app.js                 rotas Express + validação Zod
```

## Limitações conhecidas (próximos passos)

- Webhooks sem fila durável; eventos enviados após o commit, mas uma queda do processo pode perder a entrega ao destino.
- Valhalla/OSRM públicos calculam rotas pela malha viária, mas não incluem trânsito ao vivo; use um provedor empresarial de rotas/tráfego para ETAs em tempo real.
- Posição dos motoboys é atualizada por endereço no painel; ainda não há rastreamento contínuo por GPS.
- Mesma API key para vendas e operação; separar em papéis (operador, entregador).
- Despacho automático seleciona o entregador disponível com posição informada e veículo compatível mais próximo da coleta; sem candidato, a entrega permanece na fila e pode ser atribuída manualmente.
