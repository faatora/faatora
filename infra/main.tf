# Modules added per-epic. Flip enable_infra=true to provision.

module "network" {
  source = "./modules/network"
  count  = var.enable_infra ? 1 : 0

  project     = var.project
  environment = var.environment
  vpc_cidr    = var.vpc_cidr
  az_count    = var.az_count
}

module "kms" {
  source = "./modules/kms"
  count  = var.enable_infra ? 1 : 0

  project     = var.project
  environment = var.environment
}

module "auth" {
  source = "./modules/auth"
  count  = var.enable_infra ? 1 : 0

  project     = var.project
  environment = var.environment
}

module "queue" {
  source = "./modules/queue"
  count  = var.enable_infra ? 1 : 0

  project     = var.project
  environment = var.environment
}

module "database" {
  source = "./modules/database"
  count  = var.enable_infra ? 1 : 0

  project     = var.project
  environment = var.environment
  # Private subnets only. The first-deploy session temporarily moved the
  # DB into public subnets with publicly_accessible=true so GitHub
  # Actions could run migrations directly; that hack is reverted here
  # and migrations now run from an in-VPC ECS one-off task (see
  # module.compute.migrate_task_definition_arn). The publicly_accessible
  # variable is kept on the module as an explicit interface so the
  # choice is never implicit.
  vpc_subnet_ids      = module.network[0].private_subnet_ids
  db_sg_id            = module.network[0].db_sg_id
  publicly_accessible = false
  multi_az            = var.db_multi_az
}

module "archive" {
  source = "./modules/archive"
  count  = var.enable_infra ? 1 : 0

  project     = var.project
  environment = var.environment
  kms_key_id  = module.kms[0].data_key_arn
}

module "compute" {
  source = "./modules/compute"
  count  = var.enable_infra ? 1 : 0

  project            = var.project
  environment        = var.environment
  vpc_id             = module.network[0].vpc_id
  public_subnet_ids  = module.network[0].public_subnet_ids
  private_subnet_ids = module.network[0].private_subnet_ids
  alb_sg_id          = module.network[0].alb_sg_id
  app_sg_id          = module.network[0].app_sg_id
  # The task role gains secretsmanager:GetSecretValue on this ARN so a
  # future revision of the migrate task can fetch credentials inside
  # the container. Current CI flow still resolves the URL on the runner
  # and injects it as a task env override.
  rds_master_user_secret_arn = module.database[0].master_user_secret_arn
}
