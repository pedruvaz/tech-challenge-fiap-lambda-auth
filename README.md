# tech-challenge-fiap-lambda-auth

Function Serverless de autenticação por CPF do Tech Challenge.

É o **terceiro** repositório da cadeia de deploy. Lê a rede do `infra-k8s` e o
segredo e o security group do `infra-db`.

## Propósito

Provisiona o **API Gateway** do sistema e a autenticação na frente dele.
Duas funções, um bundle cada:

- **`auth`** (`src/handler.ts`) — `POST /auth`: recebe um CPF e emite o JWT.
- **`authorizer`** (`src/authorizer.ts`) — valida o JWT de toda rota protegida
  antes de a requisição chegar à API.

A função `auth`, dado um CPF:

1. **Valida o CPF** pelos dois dígitos verificadores, antes de qualquer
   consulta ao banco.
2. **Consulta o cliente** na tabela `cliente` do RDS, considerando ativo
   quem tem `deletado_em IS NULL` (o schema usa soft delete).
3. **Emite um JWT** assinado em HS256 com a `JWT_ACCESS_SECRET` do Secrets
   Manager — a mesma chave que a API usa para validar.

## Tecnologias

Node.js 20 · TypeScript · `jsonwebtoken` · `pg` · AWS SDK v3 ·
esbuild (bundle) · Jest · Terraform · API Gateway HTTP API · GitHub Actions
com OIDC.

## Coleção Postman / OpenAPI

A coleção Postman com os exemplos de autenticação e uso das APIs protegidas
está disponível no repositório `app-oficina`:
[`app-oficina/docs/postman_collection.json`](https://github.com/pedruvaz/tech-challenge-fiap-app-oficina)
<!-- Substituir pelo link direto ao arquivo quando disponível -->

## Contrato da API

### `POST /auth`

Pelo endpoint do gateway (output `api_endpoint` do Terraform):

```bash
curl -X POST "$API_ENDPOINT/auth" \
  -H 'content-type: application/json' \
  -d '{ "cpf": "529.982.247-25" }'
```

```jsonc
// Requisição — aceita com ou sem pontuação
{ "cpf": "529.982.247-25" }
```

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
| `400` | CPF ausente, malformado ou com dígito verificador errado |
| `401` | Cliente não encontrado **ou** inativo |
| `500` | Falha interna (detalhe só no log, nunca na resposta) |

Toda resposta traz o header `x-correlation-id`, que é o `requestId` do API
Gateway — é por ele que se acha a requisição no Datadog.

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
| `$default` (todo o resto) | API (NLB) | **sim** |

As rotas da API (todas, menos `POST /auth`) só são criadas quando a variável
`api_nlb_hostname` está preenchida — ver [Deploy](#deploy). Rota explícita tem
precedência sobre `$default`; as seis públicas existem para que o funcionário
consiga se logar e para que os links de aprovação enviados por e-mail ao
cliente, que a API expõe sem JWT, não levem 401 no gateway.

### Authorizer

REQUEST, payload format 2.0, resposta simples, resultado em cache por 300 s
(por valor do header `Authorization`). Verifica o token em HS256 com a mesma
`JWT_ACCESS_SECRET`, e **aceita os dois formatos de token do sistema**:

| Emissor | Payload obrigatório | `context.tipo` |
|---|---|---|
| `POST /auth` (este repo) | `{ sub: <uuid>, nome, email, tipo: "CLIENTE" }` | `CLIENTE` |
| `POST /auth/login` (API) | `{ sub: <number>, email, roles: "admin" \| "funcionario" \| "mecanico" }` — sem `iss`, `aud` nem `tipo` | `FUNCIONARIO` |

O authorizer valida **assinatura e estrutura do payload**:

- Token de cliente (`tipo: "CLIENTE"`) — exige campo `nome` preenchido.
- Token de funcionário (sem `tipo`) — exige `roles` com um dos valores do enum
  `Roles` do `app-oficina` (`admin`, `funcionario` ou `mecanico`). É **um
  valor só**, não uma lista, apesar do nome.
- Qualquer `tipo` diferente de `"CLIENTE"` é recusado imediatamente.

Isso impede que um token com payload mínimo (`{ sub }` apenas) consiga acesso
ao `$default` se passando por funcionário — a estrutura errada rejeita antes de
propagar o contexto.

O `context` devolvido tem `sub` (sempre string), `tipo` e, quando presente no
token, `email`.

Qualquer falha (header ausente, sem `Bearer`, assinatura errada, expirado,
`alg: none`, segredo indisponível, payload fora do contrato) devolve só
`{ isAuthorized: false }`: o motivo vai para o log, nunca para a resposta, e o
token nunca é logado.

O gateway não repassa o `context` do authorizer para um destino `HTTP_PROXY`
sozinho (isso exigiria mapeamento de parâmetros na integração); a API segue
validando o JWT por conta própria.

## Arquitetura deste repositório

```
   Cliente
      │ POST /auth { cpf }
      ▼
   API Gateway ──────────────► Lambda auth  (subnets privadas)
      │  │                         │  │
      │  │ valida o JWT            │  │  consulta o cliente
      │  ▼ (rotas protegidas)      │  │  (5432, SG dedicado)
      │ Lambda authorizer          ▼  ▼
      │  (fora da VPC)    Secrets Manager   RDS PostgreSQL
      │        └────────► JWT_ACCESS_SECRET   tabela cliente
      │                   DATABASE_URL
      │ demais rotas, HTTP direto ao NLB
      ▼
   app-oficina no EKS   (valida o JWT de novo, mesma JWT_ACCESS_SECRET)
```

## Execução local

```bash
npm ci
npm test              # sem precisar de AWS
npm run bundle        # gera dist/handler.js (~143 KB) e dist/authorizer.js (~58 KB)
```

Os testes mockam o banco e o Secrets Manager — rodam offline. O teste central
é o que verifica o JWT emitido com a mesma chave que a API usaria: se ele
quebrar, a autenticação ponta a ponta quebrou.

## Deploy

Pré-requisito: `infra-k8s` e `infra-db` já aplicados.

```bash
npm run package       # build + bundle em dist/
cd terraform
terraform init
terraform apply
```

O Terraform empacota `../dist` (um zip por função) e publica as duas funções
e o API Gateway. De início só `POST /auth` existe. Para expor a API, depois de
o Service `api` do `app-oficina` criar o NLB:

```bash
NLB=$(kubectl get svc api -n tech-challenge \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
terraform apply -var "api_nlb_hostname=$NLB"   # e -var api_nlb_port=<porta do Service>
```

Com `api_nlb_hostname` vazio (o default) nenhuma rota da API é criada, o que
deixa o gateway aplicável antes de o cluster existir. Nenhuma credencial
é passada por variável de ambiente — só o **nome** do segredo; o conteúdo é
lido em runtime.

## CI/CD

| Gatilho | O que roda |
|---|---|
| Pull request | formatação, typecheck, testes com cobertura, bundle, `terraform plan` |
| Push em `main` | o mesmo + `terraform apply` |

O bundle testado é o mesmo publicado: ele sobe como artefato no job de teste e
é baixado pelo job de deploy, em vez de ser reconstruído. Evita o clássico
"passou no CI e subiu outra coisa".

Configure: secret `AWS_TERRAFORM_ROLE_ARN`, variable `AWS_REGION`.
A branch `main` é protegida: merge só via Pull Request.

## Decisões que vale conhecer

### A Lambda roda dentro da VPC — e o preço disso

O RDS está em subnet privada e não é público, então a função precisa estar na
VPC. A consequência é que ela perde acesso à internet por padrão, e o Secrets
Manager é um serviço **público**: sem **NAT Gateway** ou **VPC endpoint**
(`com.amazonaws.<região>.secretsmanager`), a chamada ao segredo trava até o
timeout. O sintoma é enganoso — parece lentidão do banco, mas é a leitura do
segredo que não volta. A VPC do `infra-k8s` já provisiona NAT.

### Cache do segredo e do pool entre invocações

Ambos ficam em variável de escopo de módulo, que sobrevive enquanto o
container estiver quente. Poupa uma chamada cobrada ao Secrets Manager e o
handshake TLS a cada invocação morna. O cache do segredo guarda a *Promise*,
não o valor: duas invocações concorrentes no mesmo container esperam a mesma
chamada em vez de disparar duas. Uma falha é removida do cache, senão um
timeout transitório no cold start ficaria memoizado e o container devolveria
erro até ser reciclado.

O pool usa `max: 1` de propósito: cada container atende uma invocação por vez,
e com `db.t4g.micro` o limite de conexões é baixo — um pool generoso somado à
concorrência do Lambda esgota o banco.

### 401 genérico para "não existe" e para "inativo"

Distinguir os dois casos transformaria esta rota pública num oráculo para
descobrir quais CPFs são clientes da oficina. A resposta é a mesma; a
diferença fica no log.

### CPF nunca aparece no log

É dado pessoal e o log vai para um serviço de terceiro. Onde ajuda no
diagnóstico, só os 3 últimos dígitos (`***725`). Token e conteúdo do segredo
também nunca são logados.

## Pendências conhecidas

- **NLB exposto fora do gateway.** O NLB do `app-oficina` é `internet-facing`,
  então a integração é HTTP direta, sem VPC Link, e quem conhecer o hostname do
  NLB contorna o authorizer. Fechar isso (NLB interno + VPC Link) é o passo
  seguinte e depende do `infra-k8s`.
- **Contexto do authorizer não chega à API.** Em integração `HTTP_PROXY` o
  `context` não é repassado sem mapeamento de parâmetros; hoje a API revalida o
  JWT sozinha.
- **Guard da API precisa usar `tipo`.** O authorizer passa `tipo: "CLIENTE"` no
  context e a validação de payload está feita neste repo. O `app-oficina` ainda
  precisa ler o `tipo` do context (ou do token revalidado) para restringir
  clientes a acessar apenas os próprios recursos.

## Repositórios da entrega

| Repositório | Papel |
|---|---|
| [infra-k8s](https://github.com/pedruvaz/tech-challenge-fiap-infra-k8s) | VPC, EKS, ECR, OIDC |
| [infra-db](https://github.com/pedruvaz/tech-challenge-fiap-infra-db) | RDS e Secrets Manager |
| [lambda-auth](https://github.com/pedruvaz/tech-challenge-fiap-lambda-auth) | **este** — autenticação por CPF |
| [app-oficina](https://github.com/pedruvaz/tech-challenge-fiap-app-oficina) | API da oficina no EKS |
