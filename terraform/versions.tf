terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.6"
    }
  }

  backend "s3" {
    bucket       = "tf-state-tech-challenge-fiap-679084116359"
    key          = "lambda-auth/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = var.project_name
      Stack     = "lambda-auth"
      ManagedBy = "terraform"
    }
  }
}

# Rede, vinda do `infra-k8s`.
data "terraform_remote_state" "k8s" {
  backend = "s3"

  config = {
    bucket = "tf-state-tech-challenge-fiap-679084116359"
    key    = "cluster/terraform.tfstate"
    region = "us-east-1"
  }
}

# Segredo e security group, vindos do `infra-db`.
#
# Se o apply falhar aqui com "Unable to find remote state", o pipeline do
# `infra-db` ainda não rodou. A ordem da cadeia é k8s -> db -> lambda.
data "terraform_remote_state" "db" {
  backend = "s3"

  config = {
    bucket = "tf-state-tech-challenge-fiap-679084116359"
    key    = "db/terraform.tfstate"
    region = "us-east-1"
  }
}

locals {
  private_subnet_ids       = data.terraform_remote_state.k8s.outputs.private_subnet_ids
  lambda_security_group_id = data.terraform_remote_state.db.outputs.lambda_security_group_id
  api_secret_arn           = data.terraform_remote_state.db.outputs.api_secret_arn
  api_secret_name          = data.terraform_remote_state.db.outputs.api_secret_name
}
