# tech-challenge-fiap-lambda-auth

Function Serverless de autenticação por CPF e API Gateway do Tech Challenge
(Fase 3).

É o **terceiro** repositório da cadeia de deploy: lê a rede do `infra-k8s` e o
segredo e o security group do `infra-db`, e é quem entrega a porta de entrada
pública do sistema.

## Índice

- [Propósito](#propósito)
- [O que atende do Tech Challenge](#o-que-atende-do-tech-challenge)
- [Tecnologias](#tecnologias)
- [Arquitetura](#arquitetura)
- [Como a função foi construída](#como-a-função-foi-construída)
- [Contrato da API](#contrato-da-api)
- [Como rodar](#como-rodar) — local, testes, deploy e verificação
- [CI/CD](#cicd)
- [Problemas comuns](#problemas-comuns)
- [Pendências conhecidas](#pendências-conhecidas)
- [Documentação relacionada e repositórios da entrega](#documentação-relacionada-e-repositórios-da-entrega)

## Propósito

Provisiona o **API Gateway** do sistema e a autenticação na frente dele.
Duas funções, um bundle cada:

- **`auth`** ([`src/handler.ts`](src/handler.ts)) — `POST /auth`: recebe um CPF
  e devolve um JWT.
- **`authorizer`** ([`src/authorizer.ts`](src/authorizer.ts)) — valida o JWT de
  toda rota protegida antes de a requisição chegar à API.

A função `auth`, dado um CPF:

1. **Valida o CPF** pelos dois dígitos verificadores, antes de qualquer
   consulta ao banco.
2. **Consulta o cliente** na tabela `cliente` do RDS, considerando ativo
   quem tem `deletado_em IS NULL` (o schema usa soft delete).
3. **Emite um JWT** assinado em HS256 com a `JWT_ACCESS_SECRET` do Secrets
   Manager — a mesma chave que a API usa para validar.

> **Isto é login, não cadastro.** A função não cria clientes: o cadastro é feito
> pela API do `app-oficina`. Um CPF válido que não esteja na tabela `cliente`
> recebe `401`.

## O que atende do Tech Challenge

| Requisito do PDF | Onde está | Situação |
|---|---|---|
| API Gateway | [`terraform/api_gateway.tf`](terraform/api_gateway.tf) (HTTP API) | ✅ |
| Proteger rotas sensíveis com autenticação via CPF | `POST /auth` emite o token; o authorizer protege o `$default` | ✅ (rotas da API só existem com o NLB configurado) |
| Function Serverless: validar o CPF | [`src/cpf.ts`](src/cpf.ts) | ✅ |
| Function Serverless: consultar existência e status do cliente | [`src/cliente.ts`](src/cliente.ts) — "ativo" = `deletado_em IS NULL`; a tabela não tem coluna de status | ✅ |
| Function Serverless: gerar e devolver o JWT | [`src/handler.ts`](src/handler.ts) | ✅ |
| Terraform para provisionamento | [`terraform/`](terraform/) | ✅ |
| Repositório próprio com CI/CD e deploy automático | [`.github/workflows/ci.yml`](.github/workflows/ci.yml) | ✅ para `main`; a `dev` só roda `plan` (ver [pendências](#pendências-conhecidas)) |
| Logs estruturados (JSON) com correlação | [`src/logger.ts`](src/logger.ts) — `correlationId` = `requestId` do gateway | ✅ no CloudWatch |
| Integração com Datadog / New Relic | — | ⚠️ não há integração neste repositório; os logs ficam no CloudWatch |
| Dockerfile | — | não se aplica: a Lambda é publicada como zip, não como imagem |
| Link para Swagger/Postman | [seção abaixo](#swagger-e-postman) | ✅ |

## Tecnologias

Node.js 20 · TypeScript · `jsonwebtoken` · `pg` · AWS SDK v3 · esbuild
(bundle) · Jest · ESLint · Prettier · Terraform · API Gateway HTTP API ·
GitHub Actions com OIDC.

### Componentes

```mermaid
flowchart LR
    C["Cliente / Front-end"] -->|"POST /auth { cpf }"| GW["API Gateway<br/>HTTP API"]
    C -->|"Authorization: Bearer JWT"| GW
    GW -->|"rota /auth"| A["Lambda auth<br/>subnets privadas"]
    GW -->|"rotas protegidas"| Z["Lambda authorizer<br/>fora da VPC"]
    GW -->|"HTTP_PROXY"| N["NLB"] --> API["app-oficina<br/>EKS"]
    A -->|"consulta o cliente"| DB[("RDS PostgreSQL<br/>tabela cliente")]
    A -->|"lê o segredo"| SM["Secrets Manager"]
    Z -->|"lê JWT_ACCESS_SECRET"| SM
```

A API (`app-oficina`) valida o JWT de novo, com a mesma `JWT_ACCESS_SECRET`
entregue ao pod pelo deploy dela.

### Fluxo de autenticação

```mermaid
sequenceDiagram
    participant C as Cliente
    participant GW as API Gateway
    participant A as Lambda auth
    participant DB as RDS (cliente)
    participant Z as Lambda authorizer
    participant API as app-oficina (EKS)

    C->>GW: POST /auth { cpf }
    GW->>A: invoca a função
    A->>A: valida o CPF (dígitos verificadores)
    alt CPF inválido
        A-->>C: 400
    else CPF válido
        A->>DB: busca o cliente ativo
        alt não existe ou foi removido
            A-->>C: 401
        else cliente ativo
            A-->>C: 200 { accessToken }
        end
    end

    C->>GW: GET /rota-protegida (Bearer token)
    GW->>Z: valida o JWT
    alt token recusado
        GW-->>C: 401 ou 403 (sem motivo na resposta)
    else token válido
        GW->>API: encaminha a requisição
        API-->>C: resposta
    end
```

## Como a função foi construída

### Estrutura do repositório

```text
src/
  handler.ts      POST /auth: valida o CPF, consulta o cliente, emite o JWT
  authorizer.ts   valida o JWT das rotas protegidas
  cpf.ts          normalização e dígitos verificadores
  cliente.ts      consulta ao RDS (pool reaproveitado entre invocações)
  config.ts       leitura e cache do segredo no Secrets Manager
  logger.ts       log estruturado em JSON
scripts/
  bundle.mjs      esbuild: um bundle por função
terraform/        gateway, as duas Lambdas, IAM, log groups
test/             unitários (mocks) e integração (Postgres real)
```

### Passo a passo

1. **Fluxo do `auth`** ([`handler.ts`](src/handler.ts)). A ordem é pensada para
   gastar o mínimo antes de recusar: corpo não é JSON → `400`; CPF ausente →
   `400`; dígito verificador errado → `400` (**sem abrir conexão com o banco**);
   cliente inexistente ou removido → `401`; qualquer exceção → `500` com
   mensagem genérica (o detalhe vai só para o log).
2. **Validação do CPF** ([`cpf.ts`](src/cpf.ts)). Aceita com ou sem pontuação,
   confere os dois dígitos verificadores e recusa sequências repetidas
   (`111.111.111-11` passa na fórmula, mas não é um CPF válido).
3. **Consulta ao cliente** ([`cliente.ts`](src/cliente.ts)). Parametrizada, com
   `regexp_replace` na coluna: a aplicação grava `num_documento` **com
   pontuação** e o handler consulta só com dígitos. A comparação direta nunca
   casa e daria `401` para todo cliente válido, sem erro no log. O custo é não
   usar o índice único; para o volume de uma oficina é irrelevante.
4. **Segredo** ([`config.ts`](src/config.ts)). O Secrets Manager guarda um JSON
   com `DATABASE_URL`, `JWT_ACCESS_SECRET` (e `JWT_REFRESH_SECRET`, opcional),
   criado pelo `infra-db`. A Lambda recebe só o **nome** do segredo, na variável
   `API_SECRET_NAME`; o conteúdo nunca vira variável de ambiente, porque ela
   aparece em texto claro no console da AWS.
5. **JWT.** HS256, validade de 1 hora, payload com `sub` (id do cliente), `nome`,
   `email` e `tipo: "CLIENTE"`. Não há revogação, por isso a validade é curta.
6. **Authorizer** ([`authorizer.ts`](src/authorizer.ts)). Função separada porque
   roda em toda requisição protegida: tem bundle menor (não importa `pg`), role
   própria (só logs e leitura do segredo) e fica fora da VPC, sem pagar a
   criação de ENI no cold start.
7. **Empacotamento** ([`scripts/bundle.mjs`](scripts/bundle.mjs)). O esbuild gera
   um arquivo por função (`dist/handler.js` ~143 KB, `dist/authorizer.js`
   ~58 KB) em vez de subir o `node_modules`, o que reduz o cold start. O
   `@aws-sdk/*` fica de fora, porque o runtime já o traz.
8. **Infraestrutura como código** ([`terraform/`](terraform/)):

   | Arquivo | O que cria |
   |---|---|
   | `main.tf` | Lambda `auth`, role, log group (dentro da VPC) |
   | `authorizer.tf` | Lambda `authorizer`, role própria, log group |
   | `api_gateway.tf` | API Gateway, stage com access log, rotas, authorizer, CORS |
   | `versions.tf` | backend S3 (state `lambda-auth/terraform.tfstate`), provider e leitura do state do `infra-k8s` e do `infra-db` |
   | `variables.tf` / `outputs.tf` | variáveis (timeout, memória, `api_nlb_hostname`…) e outputs (`api_endpoint`…) |

9. **Observabilidade.** Cada evento sai como uma linha JSON (`level`, `message`,
   `service`, `timestamp`, `correlationId`). O `correlationId` é o `requestId` do
   gateway, devolvido também no header `x-correlation-id`. O access log do
   gateway usa o mesmo `requestId`, então dá para seguir uma requisição entre os
   dois logs.

### Decisões que vale conhecer

**A Lambda roda dentro da VPC — e o preço disso.** O RDS está em subnet privada,
então a função precisa estar na VPC. Ela perde o acesso à internet por padrão, e
o Secrets Manager é um serviço **público**: sem **NAT Gateway** ou **VPC
endpoint** (`com.amazonaws.<região>.secretsmanager`), a leitura do segredo trava
até o timeout. O sintoma engana: parece lentidão do banco. A VPC do `infra-k8s`
já provisiona NAT.

**Cache do segredo e do pool entre invocações.** Ambos ficam em variável de
escopo de módulo, que sobrevive enquanto o container está quente. O cache do
segredo guarda a *Promise*, não o valor: duas invocações concorrentes esperam a
mesma chamada. Uma falha é removida do cache, senão um timeout no cold start
ficaria memoizado até o container ser reciclado. O pool usa `max: 1` de
propósito: cada container atende uma invocação por vez, e um pool maior só
esgotaria as conexões do `db.t4g.micro`.

**401 genérico para "não existe" e para "removido".** Distinguir os dois
transformaria a rota pública num oráculo para descobrir quais CPFs são clientes.
A diferença fica só no log.

**CPF nunca aparece no log.** É dado pessoal. Onde ajuda no diagnóstico, só os 3
últimos dígitos (`***725`). Token e conteúdo do segredo também nunca são logados.

## Contrato da API

### `POST /auth`

```bash
curl -X POST "$API_ENDPOINT/auth" \
  -H 'content-type: application/json' \
  -d '{ "cpf": "529.982.247-25" }'
```

`API_ENDPOINT` é o output `api_endpoint` do Terraform. O CPF é aceito com ou
sem pontuação.

```jsonc
// 200 OK
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "expiresIn": 3600,
  "tokenType": "Bearer"
}
```

| Status | Quando |
|---|---|
| `200` | CPF válido e cliente ativo — token emitido |
| `400` | CPF ausente, corpo que não é JSON ou dígito verificador errado |
| `401` | Cliente não encontrado **ou** removido |
| `500` | Falha interna (detalhe só no log, nunca na resposta) |

Toda resposta traz o header `x-correlation-id`, que é o `requestId` do API
Gateway. É por ele que se acha a requisição nos logs do CloudWatch.

#### Payload do token

```jsonc
{
  "sub": "6f1c2a3e-...",   // cliente_id (UUID)
  "nome": "Maria Souza",
  "email": "maria@example.com",
  "tipo": "CLIENTE",
  "exp": 1760000000
}
```

Uso: `Authorization: Bearer <accessToken>` nas rotas protegidas.

### Rotas do gateway

| Rota | Destino | Authorizer |
|---|---|---|
| `POST /auth` | Lambda `auth` | não (é o login) |
| `GET /health/{proxy+}` | API (NLB) | não |
| `POST /auth/login` | API (NLB) | não |
| `POST /auth/refresh` | API (NLB) | não |
| `GET /publico/{proxy+}` | API (NLB) | não |
| `GET /aprovacao/{proxy+}` | API (NLB) | não |
| `POST /aprovacao/{proxy+}` | API (NLB) | não |
| `OPTIONS /{proxy+}` | API (NLB) | não (preflight de CORS do navegador) |
| `$default` (todo o resto) | API (NLB) | **sim** |

As rotas da API (todas, menos `POST /auth`) só são criadas quando a variável
`api_nlb_hostname` está preenchida — ver [Como rodar](#expor-a-api-no-gateway).
Rota explícita tem precedência sobre `$default`. As rotas públicas existem para
que o funcionário consiga se logar, para que os links de aprovação enviados por
e-mail ao cliente não levem `401` no gateway, e para que o preflight do
navegador (que não leva `Authorization`) não seja barrado pelo authorizer.

### Authorizer

REQUEST, payload format 2.0, resposta simples, resultado em cache por 300 s
(por valor do header `Authorization`). Verifica o token em HS256 com a mesma
`JWT_ACCESS_SECRET` e **aceita os dois formatos de token do sistema**:

| Emissor | Payload obrigatório | `context.tipo` |
|---|---|---|
| `POST /auth` (este repo) | `{ sub: <uuid>, nome, email, tipo: "CLIENTE" }` | `CLIENTE` |
| `POST /auth/login` (API) | `{ sub: <number>, email, roles: "admin" \| "funcionario" \| "mecanico" }` — sem `iss`, `aud` nem `tipo` | `FUNCIONARIO` |

O authorizer valida **assinatura e estrutura do payload**:

- Token de cliente (`tipo: "CLIENTE"`) — exige o campo `nome` preenchido.
- Token de funcionário (sem `tipo`) — exige `roles` com um dos valores do enum
  `Roles` do `app-oficina` (`admin`, `funcionario` ou `mecanico`). É **um valor
  só**, não uma lista, apesar do nome.
- Qualquer `tipo` diferente de `"CLIENTE"` é recusado.

Isso garante que o token é nosso, está válido e tem o formato de um dos dois
emissores. **Não restringe o que cada tipo pode acessar**: a autorização por
papel é da API, e hoje ela não a faz (ver
[pendências](#pendências-conhecidas)).

O `context` devolvido tem `sub` (sempre string), `tipo` e, quando presente no
token, `email`. Qualquer falha (header ausente, sem `Bearer`, assinatura errada,
expirado, `alg: none`, segredo indisponível, payload fora do contrato) devolve só
`{ isAuthorized: false }`: o motivo vai para o log, nunca para a resposta, e o
token nunca é logado.

### Swagger e Postman

Não há uma coleção Postman neste repositório nem no `app-oficina`. A
documentação das rotas da API está no Swagger dela (`/docs`, com o OpenAPI em
`/docs-json`, importável no Postman ou no Insomnia) e na
[referência da API](https://github.com/pedruvaz/tech-challenge-fiap-app-oficina/blob/main/docs/06-api-referencia.md).

Para o login por CPF no Postman:

1. `POST {{api_endpoint}}/auth`, corpo `raw` JSON: `{ "cpf": "<cpf de um cliente>" }`.
2. Copie o `accessToken` da resposta.
3. Nas demais requisições, aba **Authorization** → tipo **Bearer Token** → cole o
   token.

Pelo gateway, o `/docs` da API também é rota protegida: precisa do token.

## Como rodar

### Pré-requisitos

| Para | Precisa de |
|---|---|
| Testes e bundle locais | Node.js 20 ou mais novo e npm |
| Teste de integração com banco | Docker |
| Deploy manual | Terraform 1.10 ou mais novo, AWS CLI e credenciais da conta |
| Deploy pela pipeline | só o GitHub (a pipeline usa OIDC; ninguém precisa de credencial na máquina) |

### Local, sem AWS

```bash
npm ci
npm test              # unitários, com mocks do banco e do Secrets Manager
npm run lint
npm run format:check
npm run package       # typecheck + bundle: gera dist/handler.js e dist/authorizer.js
```

Os testes unitários rodam offline. O teste central é o que verifica o JWT
emitido com a mesma chave que a API usaria: se ele quebrar, a autenticação ponta
a ponta quebrou.

### Teste de integração com Postgres real

Roda a consulta de verdade, incluindo o caso do CPF gravado com pontuação, que
nenhum teste com mock pegaria. Sem `DATABASE_URL`, esses casos aparecem como
`skipped`.

Suba o banco e crie a tabela. No **Git Bash, Linux ou macOS**:

```bash
docker run -d --name pg-lambda -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=oficina -p 5432:5432 postgres:16
docker exec -i pg-lambda psql -U postgres -d oficina -v ON_ERROR_STOP=1 < test/fixtures/schema.sql
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/oficina npx jest test/cliente.integration.spec.ts
```

No **PowerShell** (que não aceita `<` nem `VARIAVEL=valor comando`):

```powershell
docker run -d --name pg-lambda -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=oficina -p 5432:5432 postgres:16
Get-Content test/fixtures/schema.sql | docker exec -i pg-lambda psql -U postgres -d oficina -v ON_ERROR_STOP=1
$env:DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/oficina"
npx jest test/cliente.integration.spec.ts
```

O esperado é `3 passed`. Para limpar: `docker rm -f pg-lambda`.

O [`schema.sql`](test/fixtures/schema.sql) é um subconjunto do schema do
`app-oficina`; se `num_documento` ou `deletado_em` mudarem lá, ele precisa
acompanhar.

### Deploy

#### Ordem da cadeia

Os repositórios dependem uns dos outros pelo state do Terraform, e a ordem
importa:

```text
infra-k8s (base → cluster)  →  infra-db  →  lambda-auth (este)  →  app-oficina
```

Este repositório lê o state `cluster/terraform.tfstate` (rede) e
`db/terraform.tfstate` (segredo e security group). Se um deles não existe ou está
vazio, o `terraform apply` falha — ver [Problemas comuns](#problemas-comuns).
Numa conta AWS nova, o setup inicial (bucket de state, stack `base`, secrets do
GitHub) está no runbook
[`docs/00-setup-inicial-aws.md` do infra-k8s](https://github.com/pedruvaz/tech-challenge-fiap-infra-k8s/blob/main/docs/00-setup-inicial-aws.md).

#### Pela pipeline (recomendado)

1. Configure no GitHub deste repositório (Settings → Secrets and variables →
   Actions): secret `AWS_TERRAFORM_ROLE_ARN` (output `github_terraform_role_arn`
   do `infra-k8s`) e variable `AWS_REGION` (`us-east-1`).
2. Abra um Pull Request para a `main`. O CI roda lint, testes e bundle e faz um
   `terraform plan`. **Nada é criado na AWS nesta etapa.**
3. Faça o merge. O push na `main` roda o `terraform apply`, que cria as duas
   Lambdas, o API Gateway, as roles e os log groups.

O resumo do job mostra o nome da função publicada. A URL do gateway está no
output `api_endpoint`.

#### Manual, da sua máquina

Útil para testar antes do PR. O state é remoto, então a pipeline reconhece
depois o que já existe.

```bash
npm run package       # o Terraform empacota ../dist; sem ele o archive_file falha
cd terraform
terraform init
terraform apply
```

#### Expor a API no gateway

De início só `POST /auth` existe. As demais rotas aparecem quando o Service `api`
do `app-oficina` criar o NLB e o hostname for informado:

```bash
NLB=$(kubectl get svc api -n tech-challenge \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
terraform apply -var "api_nlb_hostname=$NLB"   # e -var api_nlb_port=<porta do Service>
```

Pela pipeline, o mesmo valor entra pela variable `API_NLB_HOSTNAME` do
repositório (`gh variable set API_NLB_HOSTNAME --body "$NLB"`); o job a passa
como `TF_VAR_api_nlb_hostname`. Depois de criar ou alterar a variable, dispare o
workflow na `main` (workflow_dispatch) ou dê um push: o apply só roda na `main`.

Com `api_nlb_hostname` vazio (o default), nenhuma rota da API é criada, o que
deixa o gateway aplicável antes de o cluster existir.

#### Deploy ativo

URL do gateway: _preencher com o output `api_endpoint` depois do primeiro deploy
bem-sucedido._

### Verificar se funcionou

```bash
curl -i -X POST "$API_ENDPOINT/auth" \
  -H 'content-type: application/json' \
  -d '{ "cpf": "<cpf de um cliente cadastrado>" }'
```

O esperado é `200` com o `accessToken`. Para testar a rota protegida, use o
token em qualquer rota da API:

```bash
curl -i "$API_ENDPOINT/clientes" -H "authorization: Bearer $TOKEN"
```

Sem o header, o gateway recusa antes de chegar à API.

Para acompanhar os logs em tempo real:

```bash
aws logs tail /aws/lambda/tech-challenge-fiap-auth --follow
```

| Log group | O que mostra |
|---|---|
| `/aws/lambda/tech-challenge-fiap-auth` | a função de login (`Autenticacao concluida`, `CPF invalido`, `Cliente nao encontrado ou inativo`, `Falha inesperada na autenticacao`) |
| `/aws/lambda/tech-challenge-fiap-authorizer` | a validação do token; o campo `motivo` explica a recusa |
| `/aws/apigateway/tech-challenge-fiap-api` | access log do gateway, com `requestId`, status, latência e erro do authorizer |

O cliente precisa existir na tabela `cliente`: rode as migrations e o seed do
`app-oficina` antes de testar.

## CI/CD

| Gatilho | O que roda |
|---|---|
| Pull request (para `main` ou `dev`) | formatação, lint, typecheck, testes com cobertura (com Postgres de serviço), bundle, `terraform plan` |
| Push em `dev` | o mesmo, só com `terraform plan` (não aplica) |
| Push em `main` | o mesmo + `terraform apply` (ambiente `prod` do GitHub) |

O bundle testado é o mesmo publicado: ele sobe como artefato no job de teste e é
baixado pelo job de deploy, em vez de ser reconstruído. Evita o clássico "passou
no CI e subiu outra coisa". PRs de fork não rodam o job de Terraform.

O `terraform plan` tem `continue-on-error`: antes do primeiro apply das stacks de
infra não há state para ler e o plan falha, o que não deve reprovar o PR. A
consequência é que um PR verde **não garante** que o `apply` vai passar.

Configuração necessária: secret `AWS_TERRAFORM_ROLE_ARN`, variables `AWS_REGION`
e, quando o NLB existir, `API_NLB_HOSTNAME`. A branch `main` é protegida: merge
só via Pull Request.

## Problemas comuns

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| `Unable to find remote state` ao aplicar | o `infra-k8s` ou o `infra-db` nunca concluiu um apply (não existe o state que este repositório lê) | aplicar as stacks anteriores na [ordem da cadeia](#ordem-da-cadeia); conferir com `aws s3 ls s3://tf-state-tech-challenge-fiap-679084116359/ --recursive` |
| `outputs is object with no attributes` | existe o state do cluster, mas sem outputs: o cluster não foi aplicado, foi interrompido ou foi destruído | reaplicar o `infra-k8s` (`base`, depois `cluster`) |
| `archive_file` falha no Terraform | falta o `dist/` | `npm run package` antes do `terraform apply` |
| `401` em `/auth` para um CPF que parece certo | o cliente não existe no banco ou tem `deletado_em` preenchido | conferir a tabela `cliente`; o log mostra `Cliente nao encontrado ou inativo` |
| `500` em `/auth` e timeout (~15 s) no log | a Lambda está na VPC e não alcança o Secrets Manager (sem NAT nem VPC endpoint) | garantir NAT ou o endpoint `secretsmanager` na VPC |
| `500` no gateway sem nenhum log na função | integração ou permissão: `invoke_arn` trocado por `arn`, ou falta o `aws_lambda_permission` | revisar `api_gateway.tf` |
| rota protegida recusa um token que parece válido | o authorizer recusou (assinatura, expiração, payload) ou o resultado ainda está em cache (300 s) | ver o campo `motivo` no log do authorizer; esperar o cache expirar |
| o navegador falha no preflight (CORS) | a rota `OPTIONS /{proxy+}` só existe quando `api_nlb_hostname` está preenchido | informar o hostname do NLB e reaplicar |
| testes de integração aparecem como `skipped` | `DATABASE_URL` não está definida na janela do terminal | ver [Teste de integração](#teste-de-integração-com-postgres-real) |

## Pendências conhecidas

- **A API não faz autorização por papel.** A
  [RFC-003 do `app-oficina`](https://github.com/pedruvaz/tech-challenge-fiap-app-oficina/blob/main/docs/15-rfcs/rfc-003-estrategia-de-autenticacao.md)
  registra, lendo o código (sem executar), que a API só valida a assinatura do
  JWT e não tem nenhum guard de papel. Na prática, um token de cliente emitido
  por `POST /auth` passa no middleware de todas as rotas protegidas, e o
  `roles` dos funcionários não é consultado. O authorizer deste repositório
  valida o formato do token, mas **não resolve isso**: a correção é na API (guard
  por `tipo` e `roles`) ou numa mudança de contrato do JWT nos dois lados.
- **NLB exposto fora do gateway.** O NLB do `app-oficina` é `internet-facing`,
  então a integração é HTTP direta, sem VPC Link, e quem conhecer o hostname do
  NLB contorna o authorizer. Fechar isso (NLB interno + VPC Link) depende do
  `infra-k8s`.
- **Contexto do authorizer não chega à API.** Em integração `HTTP_PROXY` o
  `context` não é repassado sem mapeamento de parâmetros; hoje a API revalida o
  JWT sozinha.
- **Sem limite de requisições no `POST /auth`.** O CPF é a única credencial do
  cliente e não é segredo; o stage do gateway não declara throttling.
- **Sem deploy automático de homologação.** A branch `dev` só roda `terraform
  plan`; o PDF pede deploy automático de homologação e produção.
- **Sem integração com ferramenta de observabilidade.** Os logs ficam no
  CloudWatch; não há Datadog nem New Relic configurado neste repositório.
- **Runtime `nodejs20.x` em fim de vida.** A AWS o marcou como deprecated em
  30/04/2026 (criar funções só será bloqueado em 29/07/2027). Migrar para
  `nodejs22.x` exige trocar o `runtime` nos dois `aws_lambda_function`, o
  `target` do esbuild e o Node do CI.

## Documentação relacionada e repositórios da entrega

Decisões e documentação de arquitetura, no `app-oficina`:
[RFC-003 (autenticação por CPF, Lambda, JWT e authorizer)](https://github.com/pedruvaz/tech-challenge-fiap-app-oficina/blob/main/docs/15-rfcs/rfc-003-estrategia-de-autenticacao.md) ·
[RFC-001 (escolha da nuvem)](https://github.com/pedruvaz/tech-challenge-fiap-app-oficina/blob/main/docs/15-rfcs/rfc-001-escolha-da-nuvem.md) ·
[ADR-001 (quatro repositórios)](https://github.com/pedruvaz/tech-challenge-fiap-app-oficina/blob/main/docs/16-adrs/adr-001-quatro-repositorios.md) ·
[ADR-002 (comunicação entre repositórios)](https://github.com/pedruvaz/tech-challenge-fiap-app-oficina/blob/main/docs/16-adrs/adr-002-comunicacao-entre-repositorios.md)

| Repositório | Papel |
|---|---|
| [infra-k8s](https://github.com/pedruvaz/tech-challenge-fiap-infra-k8s) | VPC, EKS, ECR, OIDC |
| [infra-db](https://github.com/pedruvaz/tech-challenge-fiap-infra-db) | RDS e Secrets Manager |
| [lambda-auth](https://github.com/pedruvaz/tech-challenge-fiap-lambda-auth) | **este** — autenticação por CPF e API Gateway |
| [app-oficina](https://github.com/pedruvaz/tech-challenge-fiap-app-oficina) | API da oficina no EKS |
