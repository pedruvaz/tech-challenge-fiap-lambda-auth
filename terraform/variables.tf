variable "aws_region" {
  description = "Região da AWS. Precisa bater com a das outras stacks."
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Prefixo e tag aplicados aos recursos."
  type        = string
  default     = "tech-challenge-fiap"
}

variable "timeout_seconds" {
  description = <<-EOT
    Timeout da função.

    O default de 3s da AWS não basta: no cold start a função cria a ENI na
    VPC, lê o segredo no Secrets Manager e abre a conexão TLS com o RDS antes
    da primeira consulta.
  EOT
  type        = number
  default     = 15
}

variable "memory_mb" {
  description = <<-EOT
    Memória da função — no Lambda, também define a fatia de CPU.

    256 MB é o ponto em que o parsing do JWT e o handshake TLS deixam de ser
    o gargalo. Subir mais não melhora, e o custo é por GB-segundo.
  EOT
  type        = number
  default     = 256
}

variable "log_retention_days" {
  description = "Retenção dos logs no CloudWatch. Sem isto o grupo nasce com retenção infinita."
  type        = number
  default     = 14
}

variable "authorizer_timeout_seconds" {
  description = <<-EOT
    Timeout da função authorizer.

    Ela roda fora da VPC e só lê o segredo (no cold start) e verifica o JWT,
    então 5s sobra. O API Gateway não espera mais de 10s por um authorizer.
  EOT
  type        = number
  default     = 5
}

variable "api_nlb_hostname" {
  description = <<-EOT
    Hostname do NLB que o Service `api` do `app-oficina` cria no EKS (algo como
    `k8s-techchal-api-0123456789.elb.us-east-1.amazonaws.com`).

    Fica vazio até o cluster existir. Vazio, o Terraform cria só a rota
    `POST /auth` (a Lambda de login) e nenhuma rota da API, o que permite
    aplicar o gateway antes do cluster estar de pé. Depois de o Service
    subir, pegue o hostname com
    `kubectl get svc api -n tech-challenge -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'`
    e aplique de novo com ele preenchido.
  EOT
  type        = string
  default     = ""
}

variable "api_nlb_port" {
  description = <<-EOT
    Porta em que o listener do NLB atende. Confira a `port` do Service `api`:
    é ela, e não a `targetPort` do pod, que o gateway precisa chamar.
  EOT
  type        = number
  default     = 3000
}
