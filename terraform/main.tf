# Função de autenticação por CPF.
#
# Terceiro elo da cadeia: lê a rede do `infra-k8s` e o segredo e o security
# group do `infra-db`. Não cria SG próprio — ver o comentário em
# `infra-db/terraform/rds.tf` sobre a dependência circular que isso evitaria.

data "archive_file" "handler" {
  type        = "zip"
  source_dir  = "${path.module}/../dist"
  output_path = "${path.module}/.build/handler.zip"
}

resource "aws_iam_role" "lambda" {
  name = "${var.project_name}-lambda-auth"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

# Obrigatório para uma Lambda dentro da VPC: sem isto ela não consegue criar
# as ENIs nas subnets e a função nem chega a iniciar — o erro aparece como
# timeout de provisionamento, não como falta de permissão.
resource "aws_iam_role_policy_attachment" "lambda_vpc" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

# Leitura do segredo, e só deste segredo.
data "aws_iam_policy_document" "ler_segredo" {
  statement {
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.api_secret_arn]
  }
}

resource "aws_iam_role_policy" "ler_segredo" {
  name   = "ler-segredo-api"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.ler_segredo.json
}

# Log group declarado explicitamente para ter retenção controlada. Criado
# automaticamente pelo Lambda, ele nasce com retenção infinita e a conta de
# CloudWatch cresce para sempre.
resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${var.project_name}-auth"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "auth" {
  function_name = "${var.project_name}-auth"
  role          = aws_iam_role.lambda.arn

  filename         = data.archive_file.handler.output_path
  source_code_hash = data.archive_file.handler.output_base64sha256

  handler = "handler.handler"
  runtime = "nodejs20.x"

  # 5s não basta: o cold start precisa criar a ENI, ler o segredo e abrir a
  # conexão TLS com o RDS antes da primeira consulta.
  timeout     = var.timeout_seconds
  memory_size = var.memory_mb

  # Na VPC para alcançar o RDS em subnet privada. O preço disso é precisar de
  # NAT (ou VPC endpoint) para falar com o Secrets Manager, que é serviço
  # público — ver o README.
  vpc_config {
    subnet_ids         = local.private_subnet_ids
    security_group_ids = [local.lambda_security_group_id]
  }

  environment {
    variables = {
      # Só o *nome* do segredo entra no ambiente. O conteúdo é lido em runtime
      # e nunca vira variável de ambiente: variável de ambiente de Lambda
      # aparece em texto claro no console da AWS e em `GetFunction`.
      API_SECRET_NAME = local.api_secret_name
      NODE_OPTIONS    = "--enable-source-maps"
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.lambda_vpc,
    aws_cloudwatch_log_group.lambda,
  ]
}
