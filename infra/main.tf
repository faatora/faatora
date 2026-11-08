# Modules added per-epic. Flip enable_infra=true to provision.

module "network" {
  source = "./modules/network"
  count  = var.enable_infra ? 1 : 0

  project     = var.project
  environment = var.environment
  vpc_cidr    = var.vpc_cidr
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

  project        = var.project
  environment    = var.environment
  vpc_subnet_ids = module.network[0].private_subnet_ids
  db_sg_id       = module.network[0].db_sg_id
  multi_az       = var.db_multi_az
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
}
