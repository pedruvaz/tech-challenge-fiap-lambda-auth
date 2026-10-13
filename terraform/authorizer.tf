# Authorizer do API Gateway.
#
# Valida o JWT (HS256, mesma `JWT_ACCESS_SECRET` da API) antes de a requisição
# chegar ao cluster. Aceita tanto o token de cliente (emitido pela função
# `auth`) quanto o de funcionário (emitido pela API) — ver `src/authorizer.ts`.

data "archive_file" "authorizer" {
  type        = "zip"
  source_dir  = "${path.module}/../dist"
  output_path = "${path.module}/.build/authorizer.zip"
  excludes    = ["handler.js", "handler.js.map"]
}

# Role própria: o authorizer não precisa de VPC e não deve herdar o que a
# função de login tem.
resource "aws_iam_role" "authorizer" {
  name = "${var.project_name}-lambda-authorizer"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

# Só escrita de logs. O log group é declarado abaixo; esta policy apenas deixa
# a função escrever nele.
resource "aws_iam_role_policy_attachment" "authorizer_logs" {
  role       = aws_iam_role.authorizer.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Mesmo segredo da função de login, e só ele.
data "aws_iam_policy_document" "authorizer_ler_segredo" {
  statement {
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.api_secret_arn]
  }
}

resource "aws_iam_role_policy" "authorizer_ler_segredo" {
  name   = "ler-segredo-api"
  role   = aws_iam_role.authorizer.id
  policy = data.aws_iam_policy_document.authorizer_ler_segredo.json
}

resource "aws_cloudwatch_log_group" "authorizer" {
  name              = "/aws/lambda/${var.project_name}-authorizer"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "authorizer" {
  function_name = "${var.project_name}-authorizer"
  role          = aws_iam_role.authorizer.arn

  filename         = data.archive_file.authorizer.output_path
  source_code_hash = data.archive_file.authorizer.output_base64sha256

  handler = "authorizer.handler"
  runtime = "nodejs20.x"

  timeout     = var.authorizer_timeout_seconds
  memory_size = var.memory_mb

  # Sem `vpc_config` de propósito: o authorizer não fala com o RDS, só com o
  # Secrets Manager. Fora da VPC ele alcança o serviço pela internet da própria
  # AWS, sem depender de NAT, e o cold start não paga a criação de ENI — o que
  # importa, porque ele roda em toda requisição protegida que não está em cache.

  environment {
    variables = {
      API_SECRET_NAME = local.api_secret_name
      NODE_OPTIONS    = "--enable-source-maps"
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.authorizer_logs,
    aws_cloudwatch_log_group.authorizer,
  ]
}
